import Foundation

/// Obergrenzen der Index-Befehle (Body-Index-Spec 5.3), einzige Stelle.
public let indexFeedMaxLimit = 5_000
public let indexGidsMaxLimit = 20_000

/// Body-Index-Spec 5.3 `index-feed`: Zeilen nach `ROWID` aufsteigend, fuer den Indexer in Node.
public struct IndexFeedRequest: Codable, Equatable, Sendable {
    public var allowedMailboxIds: [Int64]
    public var afterRowid: Int64
    public var limit: Int

    public init(allowedMailboxIds: [Int64], afterRowid: Int64, limit: Int) {
        self.allowedMailboxIds = allowedMailboxIds
        self.afterRowid = afterRowid
        self.limit = limit
    }
}

public struct IndexFeedRow: Codable, Equatable, Sendable {
    public let rowid: Int64
    public let gid: Int64
    /// `date_received` dieser Zeile, nicht das Gruppendatum der gid.
    public let date: Int64
}

public struct IndexFeedResult: Codable, Equatable, Sendable {
    public var rows: [IndexFeedRow]
    /// `max(ROWID)` der ganzen Tabelle, ohne Filter: faellt er unter die Hochwassermarke des Indexers, hat
    /// Mail den Envelope Index neu aufgebaut (Body-Index-Spec 5.6).
    public var maxRowid: Int64
    public var hasMore: Bool
}

/// Body-Index-Spec 5.3 `index-gids`: alle sichtbaren gids aufsteigend, seitenweise.
public struct IndexGidsRequest: Codable, Equatable, Sendable {
    public var allowedMailboxIds: [Int64]
    public var afterGid: Int64
    public var limit: Int

    public init(allowedMailboxIds: [Int64], afterGid: Int64, limit: Int) {
        self.allowedMailboxIds = allowedMailboxIds
        self.afterGid = afterGid
        self.limit = limit
    }
}

/// `gids` als Paare `[gid, hasFile]`, kompakter als Objekte (Body-Index-Spec 7).
public struct IndexGidsResult: Encodable, Equatable, Sendable {
    public struct Entry: Encodable, Equatable, Sendable {
        public let gid: Int64
        public let hasFile: Bool

        public func encode(to encoder: Encoder) throws {
            var c = encoder.unkeyedContainer()
            try c.encode(gid)
            try c.encode(hasFile)
        }
    }

    public var gids: [Entry]
    public var hasMore: Bool
}

extension MailStore {
    private static func invalidIndex(_ field: String) -> HelperFailure {
        HelperFailure(code: .invalidInput, message: "Invalid value for \(field).")
    }

    public func indexFeed(_ r: IndexFeedRequest) throws(HelperFailure) -> IndexFeedResult {
        guard !r.allowedMailboxIds.isEmpty else { throw Self.invalidIndex("allowedMailboxIds") }
        guard r.afterRowid >= 0 else { throw Self.invalidIndex("afterRowid") }
        guard (1...indexFeedMaxLimit).contains(r.limit) else { throw Self.invalidIndex("limit") }

        let db = try envelopeDatabase()
        // Seite und maxRowid aus einem Stand: sonst koennte maxRowid eine Zeile zaehlen, die die Seite nicht sah.
        return try db.readTransaction { () throws(HelperFailure) in
            var rows: [IndexFeedRow] = []
            // Unaeres + vor deleted und mailbox: SQLite soll die ROWID-Spanne der Tabelle lesen (schon
            // sortiert, bricht nach limit + 1 Treffern ab) statt ueber messages_deleted_mailbox_index alle
            // erlaubten Zeilen zu holen und zu sortieren.
            try db.query("""
                SELECT ROWID, global_message_id, date_received FROM messages
                WHERE ROWID > ? AND +deleted = 0
                  AND +mailbox IN (\(placeholders(r.allowedMailboxIds.count)))
                  AND global_message_id IS NOT NULL
                ORDER BY ROWID ASC LIMIT ?
                """, [.int(r.afterRowid)] + r.allowedMailboxIds.map { .int($0) } + [.int(Int64(r.limit + 1))]) { row in
                rows.append(IndexFeedRow(rowid: row.int(0), gid: row.int(1), date: row.int(2)))
            }
            let hasMore = rows.count > r.limit
            if hasMore { rows.removeLast() }
            var maxRowid: Int64 = 0
            try db.query("SELECT coalesce(max(ROWID), 0) FROM messages") { maxRowid = $0.int(0) }
            return IndexFeedResult(rows: rows, maxRowid: maxRowid, hasMore: hasMore)
        }
    }

    public func indexGids(_ r: IndexGidsRequest) throws(HelperFailure) -> IndexGidsResult {
        guard !r.allowedMailboxIds.isEmpty else { throw Self.invalidIndex("allowedMailboxIds") }
        guard r.afterGid >= 0 else { throw Self.invalidIndex("afterGid") }
        guard (1...indexGidsMaxLimit).contains(r.limit) else { throw Self.invalidIndex("limit") }

        let db = try envelopeDatabase()
        let allowedIn = "+mailbox IN (\(placeholders(r.allowedMailboxIds.count)))"
        let allowedBind = r.allowedMailboxIds.map { SQLValue.int($0) }
        let copies: [(gid: Int64, rowid: Int64, mailbox: Int64)]
        let hasMore: Bool
        (copies, hasMore) = try db.readTransaction { () throws(HelperFailure) in
            // 1. Die naechsten limit + 1 gids, ueber messages_global_message_id_mailbox_index (schon sortiert).
            var gids: [Int64] = []
            try db.query("""
                SELECT DISTINCT global_message_id FROM messages
                WHERE global_message_id > ? AND +deleted = 0 AND \(allowedIn)
                ORDER BY global_message_id ASC LIMIT ?
                """, [.int(r.afterGid)] + allowedBind + [.int(Int64(r.limit + 1))]) { gids.append($0.int(0)) }
            let more = gids.count > r.limit
            if more { gids.removeLast() }
            guard let first = gids.first, let last = gids.last else { return ([], more) }
            // 2. Alle erlaubten Kopien dieser gids in einer Spanne statt in IN-Bloecken.
            var out: [(gid: Int64, rowid: Int64, mailbox: Int64)] = []
            try db.query("""
                SELECT global_message_id, ROWID, mailbox FROM messages
                WHERE global_message_id BETWEEN ? AND ? AND +deleted = 0 AND \(allowedIn)
                ORDER BY global_message_id ASC, ROWID DESC
                """, [.int(first), .int(last)] + allowedBind) { out.append((gid: $0.int(0), rowid: $0.int(1), mailbox: $0.int(2))) }
            return (out, more)
        }

        // 3. hasFile: dieselbe Dateisuche wie `file` in messageRow (EmlxLocator), ausserhalb der Transaktion.
        // Die erste gefundene Kopie genuegt.
        let locator = try emlxLocator()
        locator.beginRequest()
        let urls = Dictionary(uniqueKeysWithValues: try readMailboxes().map { ($0.id, $0.url) })
        var entries: [IndexGidsResult.Entry] = []
        var index = 0
        while index < copies.count {
            let gid = copies[index].gid
            var hasFile = false
            while index < copies.count, copies[index].gid == gid {
                let c = copies[index]
                if !hasFile, let url = urls[c.mailbox], locator.locate(rowid: c.rowid, mailboxURL: url) != nil {
                    hasFile = true
                }
                index += 1
            }
            entries.append(.init(gid: gid, hasFile: hasFile))
        }
        return IndexGidsResult(gids: entries, hasMore: hasMore)
    }
}
