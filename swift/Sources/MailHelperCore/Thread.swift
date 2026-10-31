import Foundation

/// Spec 7.3 `thread`.
public struct ThreadRequest: Codable, Equatable, Sendable {
    public var allowedMailboxIds: [Int64]
    public var gid: Int64
    public var limit: Int
    public var maxRecipients: Int

    public init(allowedMailboxIds: [Int64], gid: Int64, limit: Int, maxRecipients: Int) {
        self.allowedMailboxIds = allowedMailboxIds
        self.gid = gid
        self.limit = limit
        self.maxRecipients = maxRecipients
    }
}

/// `conversationId` ist bei "kein Thread" (0) null; zod: nullable, nicht optional.
public struct ThreadResult: Codable, Equatable, Sendable {
    public var conversationId: Int64?
    public var messages: [MessageRow]
    public var hasMore: Bool

    enum CodingKeys: String, CodingKey { case conversationId, messages, hasMore }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(conversationId, forKey: .conversationId)
        try c.encode(messages, forKey: .messages)
        try c.encode(hasMore, forKey: .hasMore)
    }
}

extension MailStore {
    public func thread(_ r: ThreadRequest) throws(HelperFailure) -> ThreadResult {
        func invalid(_ field: String) -> HelperFailure {
            HelperFailure(code: .invalidInput, message: "Invalid value for \(field).")
        }
        guard !r.allowedMailboxIds.isEmpty else { throw invalid("allowedMailboxIds") }
        guard (1...100).contains(r.limit) else { throw invalid("limit") }
        guard r.maxRecipients >= 0 else { throw invalid("maxRecipients") }

        let db = try envelopeDatabase()
        // Wie bei search: Konversation, gids und Zeilen aus einem Stand des Index.
        return try db.readTransaction { () throws(HelperFailure) in try threadRows(r, db) }
    }

    private func threadRows(_ r: ThreadRequest, _ db: Database) throws(HelperFailure) -> ThreadResult {
        let allowedIn = "mailbox IN (\(placeholders(r.allowedMailboxIds.count)))"
        let allowedBind = r.allowedMailboxIds.map { SQLValue.int($0) }

        // Konversation ueber irgendeine erlaubte, nicht geloeschte Kopie der gid.
        var found = false
        var conversation: Int64 = 0
        try db.query("""
            SELECT conversation_id FROM messages
            WHERE deleted = 0 AND global_message_id = ? AND \(allowedIn)
            ORDER BY ROWID DESC LIMIT 1
            """, [.int(r.gid)] + allowedBind) { row in
            found = true
            conversation = row.isNull(0) ? 0 : row.int(0)
        }
        guard found else { throw HelperFailure(code: .messageNotFound, message: "Message not found.") }

        if conversation == 0 {
            let rows = try loadRows(gids: [r.gid], allowed: r.allowedMailboxIds, maxRecipients: r.maxRecipients)
            return ThreadResult(conversationId: nil, messages: rows, hasMore: false)
        }

        // Gruppiert je gid, Gruppendatum = juengste erlaubte Kopie (wie die Suche); aelteste zuerst.
        var gids: [Int64] = []
        try db.query("""
            SELECT global_message_id FROM messages
            WHERE deleted = 0 AND conversation_id = ? AND \(allowedIn)
            GROUP BY global_message_id
            ORDER BY max(date_received) ASC, global_message_id ASC
            LIMIT ?
            """, [.int(conversation)] + allowedBind + [.int(Int64(r.limit + 1))]) { gids.append($0.int(0)) }
        let hasMore = gids.count > r.limit
        if hasMore { gids.removeLast() }
        let rows = try loadRows(gids: gids, allowed: r.allowedMailboxIds, maxRecipients: r.maxRecipients)
        return ThreadResult(conversationId: conversation, messages: rows, hasMore: hasMore)
    }
}
