import Foundation

public enum FileState: String, Codable, Equatable, Sendable {
    case full, partial, none
}

public struct Person: Codable, Equatable, Sendable {
    public let address: String
    public let name: String?

    enum CodingKeys: String, CodingKey { case address, name }

    // name ist fuer zod nullable, nicht optional: nil wird als null geschrieben.
    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(address, forKey: .address)
        try c.encode(name, forKey: .name)
    }
}

public enum RecipientType: String, Codable, Equatable, Sendable {
    case to, cc, bcc
}

public struct Recipient: Codable, Equatable, Sendable {
    public let type: RecipientType
    public let address: String
    public let name: String?

    enum CodingKeys: String, CodingKey { case type, address, name }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(type, forKey: .type)
        try c.encode(address, forKey: .address)
        try c.encode(name, forKey: .name)
    }
}

/// Spec 7.3 `MessageRow`, dazu `attachmentCount`.
public struct MessageRow: Codable, Equatable, Sendable {
    public let gid: Int64
    public let messageIdHeader: String?
    public let subject: String
    public let sender: Person?
    public let recipients: [Recipient]
    public let recipientCount: Int
    public let dateReceived: Int64
    public let dateSent: Int64?
    public let mailboxIds: [Int64]
    public let read: Bool
    public let flagged: Bool
    public let attachmentNames: [String]
    public let attachmentCount: Int
    public let conversationId: Int64?
    public let file: FileState

    enum CodingKeys: String, CodingKey {
        case gid, messageIdHeader, subject, sender, recipients, recipientCount, dateReceived, dateSent
        case mailboxIds, read, flagged, attachmentNames, attachmentCount, conversationId, file
    }

    // Nullable Felder werden immer geschrieben (zod: nullable, nicht optional).
    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(gid, forKey: .gid)
        try c.encode(messageIdHeader, forKey: .messageIdHeader)
        try c.encode(subject, forKey: .subject)
        try c.encode(sender, forKey: .sender)
        try c.encode(recipients, forKey: .recipients)
        try c.encode(recipientCount, forKey: .recipientCount)
        try c.encode(dateReceived, forKey: .dateReceived)
        try c.encode(dateSent, forKey: .dateSent)
        try c.encode(mailboxIds, forKey: .mailboxIds)
        try c.encode(read, forKey: .read)
        try c.encode(flagged, forKey: .flagged)
        try c.encode(attachmentNames, forKey: .attachmentNames)
        try c.encode(attachmentCount, forKey: .attachmentCount)
        try c.encode(conversationId, forKey: .conversationId)
        try c.encode(file, forKey: .file)
    }
}

/// Eine Kopie einer Mail in einer erlaubten Mailbox.
struct MessageCopy {
    let rowid: Int64
    let gid: Int64
    let mailbox: Int64
    let read: Bool
    let flagged: Bool
    let dateReceived: Int64
    let dateSent: Int64?
    let conversationId: Int64?
    let subjectPrefix: String
    let subject: String
    let senderAddress: String?
    let senderComment: String?
    let messageIdHeader: String?
}

/// Auswahl der besten Kopie (Spec 5.4): vollstaendige Datei vor .partial vor keiner, dann hoechste ROWID.
func chooseBest(_ copies: [MessageCopy], mailboxURLs: [Int64: String], locator: EmlxLocator)
    -> (copy: MessageCopy, file: FileState, located: Located?) {
    func rank(_ s: FileState) -> Int { switch s { case .full: 2; case .partial: 1; case .none: 0 } }
    var best: (copy: MessageCopy, file: FileState, located: Located?)?
    for c in copies {
        let located = mailboxURLs[c.mailbox].flatMap { locator.locate(rowid: c.rowid, mailboxURL: $0) }
        let cand = (copy: c, file: located?.state ?? FileState.none, located: located)
        if let b = best, (rank(b.file), b.copy.rowid) >= (rank(cand.file), c.rowid) { continue }
        best = cand
    }
    return best!
}

func placeholders(_ n: Int) -> String {
    Array(repeating: "?", count: n).joined(separator: ",")
}

/// SQLite-Variablenlimit: gids in Bloecken, allowed kommt in jedem Block dazu.
private let gidChunk = 300
private let attachmentNameCap = 20

extension MailStore {
    /// Laedt vollstaendige Zeilen fuer die gids; Reihenfolge wie `gids`. gids ohne Kopie in `allowed` fehlen.
    func loadRows(gids: [Int64], allowed: [Int64], maxRecipients: Int) throws(HelperFailure) -> [MessageRow] {
        try loadDetailed(gids: gids, allowed: allowed, maxRecipients: maxRecipients).map(\.row)
    }

    /// Wie `loadRows`, dazu die gefundene Datei der besten Kopie.
    func loadDetailed(gids: [Int64], allowed: [Int64], maxRecipients: Int) throws(HelperFailure)
        -> [(row: MessageRow, located: Located?)] {
        guard !gids.isEmpty, !allowed.isEmpty else { return [] }
        let db = try envelopeDatabase()
        let locator = try emlxLocator()
        locator.beginRequest()

        // 1. Kopien in erlaubten Mailboxen.
        var copiesByGid: [Int64: [MessageCopy]] = [:]
        var start = 0
        while start < gids.count {
            let chunk = Array(gids[start..<min(start + gidChunk, gids.count)])
            start += gidChunk
            let sql = """
                SELECT m.ROWID, m.global_message_id, m.mailbox, m.read, m.flagged, m.date_received, m.date_sent,
                       m.conversation_id, m.subject_prefix, s.subject, a.address, a.comment, g.message_id_header
                FROM messages m
                LEFT JOIN subjects s ON s.ROWID = m.subject
                LEFT JOIN addresses a ON a.ROWID = m.sender
                LEFT JOIN message_global_data g ON g.ROWID = m.global_message_id
                WHERE m.deleted = 0
                  AND m.global_message_id IN (\(placeholders(chunk.count)))
                  AND m.mailbox IN (\(placeholders(allowed.count)))
                """
            try db.query(sql, (chunk + allowed).map { .int($0) }) { r in
                let c = MessageCopy(
                    rowid: r.int(0), gid: r.int(1), mailbox: r.int(2),
                    read: r.int(3) != 0, flagged: r.int(4) != 0,
                    dateReceived: r.int(5), dateSent: r.isNull(6) ? nil : r.int(6),
                    conversationId: r.isNull(7) ? nil : r.int(7),
                    subjectPrefix: r.text(8) ?? "", subject: r.text(9) ?? "",
                    senderAddress: r.text(10), senderComment: r.text(11),
                    messageIdHeader: r.text(12))
                copiesByGid[c.gid, default: []].append(c)
            }
        }

        // 2. Beste Kopie je gid.
        let urls = Dictionary(uniqueKeysWithValues: try readMailboxes().map { ($0.id, $0.url) })
        var best: [Int64: (copy: MessageCopy, file: FileState, located: Located?)] = [:]
        for (gid, copies) in copiesByGid { best[gid] = chooseBest(copies, mailboxURLs: urls, locator: locator) }

        // 3. Empfaenger und Anhaenge der besten Zeilen.
        let bestRowids = best.values.map(\.copy.rowid)
        var recipients: [Int64: [Recipient]] = [:]
        var recipientCounts: [Int64: Int] = [:]
        var attachments: [Int64: [String]] = [:]
        var attachmentCounts: [Int64: Int] = [:]
        start = 0
        while start < bestRowids.count {
            let chunk = Array(bestRowids[start..<min(start + gidChunk, bestRowids.count)])
            start += gidChunk
            let binds = chunk.map { SQLValue.int($0) }
            let ph = placeholders(chunk.count)
            try db.query("""
                SELECT r.message, count(*) FROM recipients r JOIN addresses ra ON ra.ROWID = r.address
                WHERE r.message IN (\(ph)) GROUP BY r.message
                """, binds) { recipientCounts[$0.int(0)] = Int($0.int(1)) }
            if maxRecipients > 0 {
                try db.query("""
                    SELECT message, type, address, comment FROM (
                        SELECT r.message AS message, r.type AS type, ra.address AS address, ra.comment AS comment,
                               row_number() OVER (PARTITION BY r.message ORDER BY r.position, r.ROWID) AS rn
                        FROM recipients r JOIN addresses ra ON ra.ROWID = r.address
                        WHERE r.message IN (\(ph)))
                    WHERE rn <= ? ORDER BY message, rn
                    """, binds + [.int(Int64(maxRecipients))]) { r in
                    let type: RecipientType = switch r.int(1) { case 0: .to; case 1: .cc; default: .bcc }
                    let comment = r.text(3) ?? ""
                    recipients[r.int(0), default: []].append(
                        Recipient(type: type, address: r.text(2) ?? "", name: comment.isEmpty ? nil : comment))
                }
            }
            try db.query("SELECT message, count(*) FROM attachments WHERE message IN (\(ph)) GROUP BY message", binds) {
                attachmentCounts[$0.int(0)] = Int($0.int(1))
            }
            try db.query("""
                SELECT message, name FROM (
                    SELECT t.message AS message, t.name AS name,
                           row_number() OVER (PARTITION BY t.message ORDER BY t.ROWID) AS rn
                    FROM attachments t WHERE t.message IN (\(ph)))
                WHERE rn <= ? ORDER BY message, rn
                """, binds + [.int(Int64(attachmentNameCap))]) { r in
                attachments[r.int(0), default: []].append(r.text(1) ?? "")
            }
        }

        // 4. Zusammensetzen.
        var out: [(row: MessageRow, located: Located?)] = []
        for gid in gids {
            guard let copies = copiesByGid[gid], let b = best[gid] else { continue }
            let c = b.copy
            let sender: Person? = c.senderAddress.map { Person(address: $0, name: (c.senderComment ?? "").isEmpty ? nil : c.senderComment) }
            out.append((MessageRow(
                gid: gid, messageIdHeader: c.messageIdHeader,
                subject: c.subjectPrefix + c.subject, sender: sender,
                recipients: recipients[c.rowid] ?? [], recipientCount: recipientCounts[c.rowid] ?? 0,
                dateReceived: copies.map(\.dateReceived).max() ?? c.dateReceived, dateSent: c.dateSent,
                mailboxIds: Set(copies.map(\.mailbox)).sorted(),
                read: copies.contains { $0.read }, flagged: copies.contains { $0.flagged },
                attachmentNames: attachments[c.rowid] ?? [], attachmentCount: attachmentCounts[c.rowid] ?? 0,
                conversationId: c.conversationId, file: b.file), b.located))
        }
        return out
    }
}
