import Foundation

/// Spec 7.3 `search`. Strikte Ablehnung unbekannter Schluessel kommt in Task 8.
public struct SearchRequest: Codable, Equatable, Sendable {
    public struct After: Codable, Equatable, Sendable {
        public var date: Int64
        public var gid: Int64
        public init(date: Int64, gid: Int64) {
            self.date = date
            self.gid = gid
        }
    }

    public var allowedMailboxIds: [Int64]
    public var mailboxIds: [Int64]?
    public var from: String?
    public var to: String?
    public var subject: String?
    public var query: String?
    public var since: Int64?
    public var before: Int64?
    public var unread: Bool?
    public var flagged: Bool?
    public var hasAttachment: Bool?
    public var after: After?
    public var limit: Int
    public var maxRecipients: Int
    public var countTotal: Bool

    public init(allowedMailboxIds: [Int64], mailboxIds: [Int64]? = nil, from: String? = nil, to: String? = nil,
                subject: String? = nil, query: String? = nil, since: Int64? = nil, before: Int64? = nil,
                unread: Bool? = nil, flagged: Bool? = nil, hasAttachment: Bool? = nil, after: After? = nil,
                limit: Int, maxRecipients: Int = 5, countTotal: Bool = false) {
        self.allowedMailboxIds = allowedMailboxIds
        self.mailboxIds = mailboxIds
        self.from = from
        self.to = to
        self.subject = subject
        self.query = query
        self.since = since
        self.before = before
        self.unread = unread
        self.flagged = flagged
        self.hasAttachment = hasAttachment
        self.after = after
        self.limit = limit
        self.maxRecipients = maxRecipients
        self.countTotal = countTotal
    }
}

public struct SearchResult: Codable, Equatable, Sendable {
    public var messages: [MessageRow]
    public var hasMore: Bool
    public var totalMatched: Int?
    public var totalMatchedCapped: Bool?

    enum CodingKeys: String, CodingKey { case messages, hasMore, totalMatched, totalMatchedCapped }

    // totalMatched und totalMatchedCapped fehlen, wenn nicht gezaehlt wurde.
    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(messages, forKey: .messages)
        try c.encode(hasMore, forKey: .hasMore)
        try c.encodeIfPresent(totalMatched, forKey: .totalMatched)
        try c.encodeIfPresent(totalMatchedCapped, forKey: .totalMatchedCapped)
    }
}

private let countCap = 10_000

extension MailStore {
    private static func invalid(_ field: String) -> HelperFailure {
        HelperFailure(code: .invalidInput, message: "Invalid value for \(field).")
    }

    /// Gruppierte Kandidatenabfrage (Spec 5.4) ohne Keyset. Filter wirken auf irgendeine Kopie in
    /// einer erlaubten Mailbox (HAVING ueber max(...)), das Gruppendatum bleibt das Maximum ueber alle
    /// erlaubten Kopien, damit Keyset und angezeigtes Datum uebereinstimmen.
    private func candidateCTE(_ r: SearchRequest) -> (sql: String, bind: [SQLValue]) {
        var bind: [SQLValue] = r.allowedMailboxIds.map { .int($0) }
        var having: [String] = []

        func anyCopy(_ cond: String, _ b: [SQLValue]) {
            having.append("max(CASE WHEN \(cond) THEN 1 ELSE 0 END) = 1")
            bind += b
        }
        func term(_ s: String?) -> String? {
            guard let s else { return nil }
            let f = fold(s)
            return f.isEmpty ? nil : f
        }
        let senderCond = "(instr(mcp_fold(a.address), ?) > 0 OR instr(mcp_fold(a.comment), ?) > 0)"
        let subjectCond = "instr(mcp_fold(s.subject), ?) > 0"
        let recipientCond = """
            EXISTS (SELECT 1 FROM recipients r JOIN addresses ra ON ra.ROWID = r.address
                    WHERE r.message = m.ROWID
                      AND (instr(mcp_fold(ra.address), ?) > 0 OR instr(mcp_fold(ra.comment), ?) > 0))
            """

        if let ids = r.mailboxIds {
            having.append("max(CASE WHEN m.mailbox IN (\(placeholders(ids.count))) THEN 1 ELSE 0 END) = 1")
            bind += ids.map { .int($0) }
        }
        if let t = term(r.from) { anyCopy(senderCond, [.text(t), .text(t)]) }
        if let t = term(r.to) { anyCopy(recipientCond, [.text(t), .text(t)]) }
        if let t = term(r.subject) { anyCopy(subjectCond, [.text(t)]) }
        if let t = term(r.query) {
            anyCopy("(\(subjectCond) OR \(senderCond) OR \(recipientCond))",
                    [.text(t), .text(t), .text(t), .text(t), .text(t)])
        }
        if let since = r.since { having.append("max(m.date_received) >= ?"); bind.append(.int(since)) }
        if let before = r.before { having.append("max(m.date_received) < ?"); bind.append(.int(before)) }
        if let u = r.unread { having.append("max(m.read) = \(u ? 0 : 1)") }
        if let f = r.flagged { having.append("max(m.flagged) = \(f ? 1 : 0)") }
        if let h = r.hasAttachment {
            having.append("max(EXISTS (SELECT 1 FROM attachments t WHERE t.message = m.ROWID)) = \(h ? 1 : 0)")
        }

        let sql = """
            WITH cand AS (
                SELECT m.global_message_id AS gid, max(m.date_received) AS d
                FROM messages m
                LEFT JOIN subjects s ON s.ROWID = m.subject
                LEFT JOIN addresses a ON a.ROWID = m.sender
                WHERE m.deleted = 0 AND m.mailbox IN (\(placeholders(r.allowedMailboxIds.count)))
                GROUP BY m.global_message_id
                \(having.isEmpty ? "" : "HAVING " + having.joined(separator: " AND "))
            )
            """
        return (sql, bind)
    }

    public func search(_ r: SearchRequest) throws(HelperFailure) -> SearchResult {
        guard !r.allowedMailboxIds.isEmpty else { throw Self.invalid("allowedMailboxIds") }
        guard (1...2000).contains(r.limit) else { throw Self.invalid("limit") }
        guard r.maxRecipients >= 0 else { throw Self.invalid("maxRecipients") }
        if let ids = r.mailboxIds {
            guard !ids.isEmpty, Set(ids).isSubset(of: Set(r.allowedMailboxIds)) else { throw Self.invalid("mailboxIds") }
        }

        let db = try envelopeDatabase()
        let cte = candidateCTE(r)

        var sql = cte.sql + " SELECT gid, d FROM cand"
        var bind = cte.bind
        if let a = r.after {
            sql += " WHERE (d, gid) < (?, ?)"
            bind += [.int(a.date), .int(a.gid)]
        }
        sql += " ORDER BY d DESC, gid DESC LIMIT ?"
        bind.append(.int(Int64(r.limit + 1)))

        var gids: [Int64] = []
        try db.query(sql, bind) { gids.append($0.int(0)) }
        let hasMore = gids.count > r.limit
        if hasMore { gids.removeLast() }

        var result = SearchResult(messages: try loadRows(gids: gids, allowed: r.allowedMailboxIds, maxRecipients: r.maxRecipients),
                                  hasMore: hasMore)
        if r.countTotal {
            var n = 0
            try db.query(cte.sql + " SELECT count(*) FROM (SELECT gid FROM cand LIMIT \(countCap + 1))", cte.bind) {
                n = Int($0.int(0))
            }
            result.totalMatched = min(n, countCap)
            result.totalMatchedCapped = n > countCap
        }
        return result
    }
}
