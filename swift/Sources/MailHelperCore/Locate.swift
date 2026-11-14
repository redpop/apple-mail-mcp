import Foundation

/// Hoechstzahl der gids je `locate`-Anfrage.
public let locateMaxGids = 100

/// `locate`: aktuelle ROWIDs der sichtbaren Kopien (nur lesend). Node nutzt sie vor dem Verschieben.
public struct LocateRequest: Codable, Equatable, Sendable {
    public var allowedMailboxIds: [Int64]
    public var gids: [Int64]
    /// Nur auf Anfrage: Teilkennungen und Namen der Anhaenge je Kopie.
    public var withAttachments: Bool?

    public init(allowedMailboxIds: [Int64], gids: [Int64], withAttachments: Bool? = nil) {
        self.allowedMailboxIds = allowedMailboxIds
        self.gids = gids
        self.withAttachments = withAttachments
    }
}

/// `partId` ist `attachments.attachment_id`, in Mail die `id of mail attachment`.
public struct LocateAttachment: Codable, Equatable, Sendable {
    public let partId: String
    public let name: String

    public init(partId: String, name: String) {
        self.partId = partId
        self.name = name
    }
}

public struct LocateCopy: Codable, Equatable, Sendable {
    public let rowid: Int64
    public let mailboxId: Int64
    /// nil ohne `withAttachments`: der Schluessel fehlt dann in der Antwort.
    public var attachments: [LocateAttachment]?
}

/// Hoechstzahl der Anhaenge je Kopie (wie die Namensliste in search).
private let locateAttachmentCap = 20
private let locateChunk = 300

public struct LocateMessage: Codable, Equatable, Sendable {
    public let gid: Int64
    public let messageIdHeader: String?
    public let subject: String
    public let fromAddress: String?
    /// ROWID absteigend.
    public let copies: [LocateCopy]

    enum CodingKeys: String, CodingKey { case gid, messageIdHeader, subject, fromAddress, copies }

    // Nullable Felder werden immer geschrieben (zod: nullable, nicht optional).
    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(gid, forKey: .gid)
        try c.encode(messageIdHeader, forKey: .messageIdHeader)
        try c.encode(subject, forKey: .subject)
        try c.encode(fromAddress, forKey: .fromAddress)
        try c.encode(copies, forKey: .copies)
    }
}

public struct LocateResult: Codable, Equatable, Sendable {
    public var messages: [LocateMessage]
}

extension MailStore {
    public func locate(_ r: LocateRequest) throws(HelperFailure) -> LocateResult {
        func invalid(_ field: String) -> HelperFailure {
            HelperFailure(code: .invalidInput, message: "Invalid value for \(field).")
        }
        guard !r.allowedMailboxIds.isEmpty else { throw invalid("allowedMailboxIds") }
        guard (1...locateMaxGids).contains(r.gids.count) else { throw invalid("gids") }

        var seen = Set<Int64>()
        let gids = r.gids.filter { seen.insert($0).inserted }
        let (db, optional) = try envelopeDatabaseWithColumns()
        // Fester Ausdruck, nie aus Eingaben: ohne die Spalte (macOS 15) liefert die Abfrage NULL (wie loadDetailed).
        let header = optional.messageIdHeader ? "g.message_id_header" : "NULL"
        // Unaeres + vor deleted und mailbox, wie in loadDetailed: SQLite findet die Kopien ueber den gid-Index.
        // ROWID absteigend, damit die Metadaten der neuesten Kopie kommen (wie die beste Kopie in search).
        let sql = """
            SELECT m2.ROWID, m2.global_message_id, m2.mailbox, m2.subject_prefix, s.subject, a.address, \(header)
            FROM messages m2
            LEFT JOIN subjects s ON s.ROWID = m2.subject
            LEFT JOIN addresses a ON a.ROWID = m2.sender
            LEFT JOIN message_global_data g ON g.ROWID = m2.global_message_id
            WHERE +m2.deleted = 0
              AND m2.global_message_id IN (\(placeholders(gids.count)))
              AND +m2.mailbox IN (\(placeholders(r.allowedMailboxIds.count)))
            ORDER BY m2.ROWID DESC
            """
        var copies: [Int64: [LocateCopy]] = [:]
        var meta: [Int64: (header: String?, subject: String, from: String?)] = [:]
        try db.readTransaction { () throws(HelperFailure) in
            try db.query(sql, (gids + r.allowedMailboxIds).map { .int($0) }) { row in
                let gid = row.int(1)
                copies[gid, default: []].append(LocateCopy(rowid: row.int(0), mailboxId: row.int(2)))
                if meta[gid] == nil {
                    meta[gid] = (row.text(6), (row.text(3) ?? "") + (row.text(4) ?? ""), row.text(5))
                }
            }
        }
        if r.withAttachments == true {
            // Eine Abfrage je Block ueber die ROWIDs der Kopien, Reihenfolge nach attachments.ROWID.
            let rowids = copies.values.flatMap { $0.map(\.rowid) }
            var found: [Int64: [LocateAttachment]] = [:]
            try db.readTransaction { () throws(HelperFailure) in
                var start = 0
                while start < rowids.count {
                    let chunk = Array(rowids[start..<min(start + locateChunk, rowids.count)])
                    start += locateChunk
                    try db.query("""
                        SELECT message, attachment_id, name FROM (
                            SELECT t.message AS message, t.attachment_id AS attachment_id, t.name AS name,
                                   row_number() OVER (PARTITION BY t.message ORDER BY t.ROWID) AS rn
                            FROM attachments t WHERE t.message IN (\(placeholders(chunk.count))))
                        WHERE rn <= ? ORDER BY message, rn
                        """, chunk.map { .int($0) } + [.int(Int64(locateAttachmentCap))]) { row in
                        found[row.int(0), default: []].append(
                            LocateAttachment(partId: row.text(1) ?? "", name: row.text(2) ?? ""))
                    }
                }
            }
            for (gid, list) in copies {
                copies[gid] = list.map { LocateCopy(rowid: $0.rowid, mailboxId: $0.mailboxId, attachments: found[$0.rowid] ?? []) }
            }
        }
        let messages = gids.compactMap { gid -> LocateMessage? in
            guard let m = meta[gid], let c = copies[gid] else { return nil }
            return LocateMessage(gid: gid, messageIdHeader: m.header, subject: m.subject, fromAddress: m.from, copies: c)
        }
        return LocateResult(messages: messages)
    }
}
