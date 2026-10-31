import Foundation
import Testing
@testable import MailHelperCore

/// Aequivalenz-Orakel fuer Filterkombinationen. Die erwartete gid-Liste wird ohne die Abfragen des Helpers
/// berechnet: alle Zeilen roh lesen und die Bedeutung aus Spec 5.4 in Swift nachbilden (Filter wirken je
/// Filter auf irgendeine nicht geloeschte Kopie in einer erlaubten Mailbox, unread verlangt alle erlaubten
/// Kopien ungelesen, Gruppendatum ist das Maximum der erlaubten Kopien). Verglichen werden Reihenfolge,
/// Inhalt aller Seiten mit `limit: 2000` und `totalMatched`.
@Suite struct SearchOracleTests {
    struct Copy {
        let gid: Int64
        let mailbox: Int64
        let date: Int64
        let read: Bool
        let deleted: Bool
        let subject: String?
        let sender: [String]
        let recipients: [String]
        let hasAttachment: Bool
    }

    /// Faltung unabhaengig von `fold` (gleiche Regel wie Node: klein, NFC, ss).
    static func refFold(_ s: String) -> Data {
        Data(s.lowercased().precomposedStringWithCanonicalMapping.replacingOccurrences(of: "ß", with: "ss").utf8)
    }

    /// Bytevergleich wie `instr` in SQLite, nicht der Unicode-Vergleich von String.contains.
    static func matches(_ text: String?, _ term: String) -> Bool {
        guard let text else { return false }
        return refFold(text).range(of: refFold(term)) != nil
    }

    static func load(_ f: Fixture) throws -> [Copy] {
        let db = try SQLiteHandle(path: f.envelopeIndex.path, readOnly: true)
        var recipients: [Int64: [String]] = [:]
        for r in try db.rows("SELECT r.message, ra.address, ra.comment FROM recipients r JOIN addresses ra ON ra.ROWID = r.address") {
            recipients[Int64(r[0]!)!, default: []] += [r[1], r[2]].compactMap { $0 }
        }
        let withAttachment = Set(try db.texts("SELECT DISTINCT message FROM attachments").compactMap { Int64($0) })
        return try db.rows("""
            SELECT m.ROWID, m.global_message_id, m.mailbox, m.date_received, m.read, m.deleted, s.subject, a.address, a.comment
            FROM messages m LEFT JOIN subjects s ON s.ROWID = m.subject LEFT JOIN addresses a ON a.ROWID = m.sender
            """).map { r in
            let rowid = Int64(r[0]!)!
            return Copy(gid: Int64(r[1]!)!, mailbox: Int64(r[2]!)!, date: Int64(r[3]!)!, read: r[4] != "0",
                        deleted: r[5] != "0", subject: r[6], sender: [r[7], r[8]].compactMap { $0 },
                        recipients: recipients[rowid] ?? [], hasAttachment: withAttachment.contains(rowid))
        }
    }

    /// Erwartete gids in Ergebnisreihenfolge (Datum absteigend, dann gid absteigend).
    static func expected(_ copies: [Copy], _ r: SearchRequest) -> [Int64] {
        let allowed = Set(r.allowedMailboxIds)
        let groups = Dictionary(grouping: copies.filter { !$0.deleted && allowed.contains($0.mailbox) }, by: \.gid)
        func any(_ c: [Copy], _ p: (Copy) -> Bool) -> Bool { c.contains(where: p) }
        let hits = groups.filter { _, c in
            if let t = r.subject, !any(c, { matches($0.subject, t) }) { return false }
            if let t = r.from, !any(c, { $0.sender.contains { matches($0, t) } }) { return false }
            if let t = r.to, !any(c, { $0.recipients.contains { matches($0, t) } }) { return false }
            if let t = r.query, !any(c, { cp in
                matches(cp.subject, t) || cp.sender.contains { matches($0, t) } || cp.recipients.contains { matches($0, t) }
            }) { return false }
            if let ids = r.mailboxIds, !any(c, { ids.contains($0.mailbox) }) { return false }
            if let u = r.unread, any(c, \.read) == u { return false }
            if let h = r.hasAttachment, any(c, \.hasAttachment) != h { return false }
            let d = c.map(\.date).max()!
            if let s = r.since, d < s { return false }
            if let b = r.before, d >= b { return false }
            return true
        }
        return hits.map { (gid: $0.key, d: $0.value.map(\.date).max()!) }
            .sorted { $0.d != $1.d ? $0.d > $1.d : $0.gid > $1.gid }
            .map(\.gid)
    }

    /// Alle Seiten mit limit 2000; dazu totalMatched der ersten Seite.
    static func searchAll(_ s: MailStore, _ base: SearchRequest) throws -> (gids: [Int64], total: Int?) {
        var req = base
        req.limit = 2000
        req.countTotal = true
        var out: [Int64] = []
        var total: Int?
        while true {
            let r = try s.search(req)
            if req.after == nil { total = r.totalMatched }
            out += r.messages.map(\.gid)
            guard r.hasMore, let last = r.messages.last else { return (out, total) }
            req.after = .init(date: last.dateReceived, gid: last.gid)
        }
    }

    @Test func filterCombinationsMatchTheOracle() throws {
        let f = try FixtureBuilder.build(extraMessages: 4_000, bulk: .realSize)
        let s = MailStore(config: f.config)
        let copies = try Self.load(f)
        let wide = FixtureBuilder.realSizeAllowed(f)
        // Engere Erlaubnis ohne die grosse Mailbox 1000 und ohne Junk: Gruppen verlieren Kopien.
        let narrow = wide.filter { $0 != FixtureBuilder.realSizeMailboxes.lowerBound && $0 != f.mailboxId(named: "junk") }
        let pick: [Int64] = Array(1000...1060) + [1171, f.mailboxId(named: "inbox")]

        for allowed in [wide, narrow] {
            let ids = pick.filter(allowed.contains)
            let cases: [(String, SearchRequest)] = [
                ("subject+from", .init(allowedMailboxIds: allowed, from: "größe", subject: "rechnung", limit: 1)),
                ("query+hasAttachment", .init(allowedMailboxIds: allowed, query: "straße 4", hasAttachment: true, limit: 1)),
                ("query+noAttachment", .init(allowedMailboxIds: allowed, query: "straße 4", hasAttachment: false, limit: 1)),
                ("to+unread+mailboxIds", .init(allowedMailboxIds: allowed, mailboxIds: ids, to: "person", unread: true, limit: 1)),
                ("to+read+mailboxIds", .init(allowedMailboxIds: allowed, mailboxIds: ids, to: "person1", unread: false, limit: 1)),
                ("mailboxIds small", .init(allowedMailboxIds: allowed, mailboxIds: [1003], limit: 1)),
                ("from+since+before", .init(allowedMailboxIds: allowed, from: "person1", since: 1_600_300_000,
                                            before: 1_601_500_000, limit: 1)),
                ("subject+mailboxIds+hasAttachment", .init(allowedMailboxIds: allowed, mailboxIds: ids, subject: "thema",
                                                           hasAttachment: true, limit: 1)),
            ]
            for (name, req) in cases {
                let want = Self.expected(copies, req)
                #expect(!want.isEmpty, "\(name): empty oracle proves nothing")
                let got = try Self.searchAll(s, req)
                #expect(got.gids == want, "\(name)")
                #expect(got.total == want.count, "\(name)")
            }
        }
    }
}
