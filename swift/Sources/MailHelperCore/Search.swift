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

extension MailStore {
    private static func invalid(_ field: String) -> HelperFailure {
        HelperFailure(code: .invalidInput, message: "Invalid value for \(field).")
    }

    /// Gefalteter Suchbegriff; leer zaehlt als nicht gesetzt.
    private static func term(_ s: String?) -> String? {
        guard let s else { return nil }
        let f = fold(s)
        return f.isEmpty ? nil : f
    }

    /// Gruppierte Kandidatenabfrage (Spec 5.4) ohne Keyset. Filter wirken auf irgendeine Kopie in
    /// einer erlaubten Mailbox (HAVING ueber max(...)), das Gruppendatum bleibt das Maximum ueber alle
    /// erlaubten Kopien, damit Keyset und angezeigtes Datum uebereinstimmen.
    private func candidateCTE(_ r: SearchRequest) -> (sql: String, bind: [SQLValue]) {
        var bind: [SQLValue] = r.allowedMailboxIds.map { .int($0) }
        var wherePre: [String] = []
        var whereBind: [SQLValue] = []
        var having: [String] = []
        var havingBind: [SQLValue] = []
        let allowedIn = "m2.mailbox IN (\(placeholders(r.allowedMailboxIds.count)))"
        let allowedBind: [SQLValue] = r.allowedMailboxIds.map { .int($0) }

        let term = Self.term
        // Textfilter: die kleinen Woerterbuchtabellen (subjects, addresses) werden verglichen, nicht die
        // Nachrichten- oder Empfaengerzeilen, und zwar in ihrer gefalteten Kopie in TEMP (FoldCache.swift).
        // Ein IN je Filter, damit "irgendeine erlaubte Kopie" je Filter gilt.
        let subjectDict = "m2.subject IN (SELECT id FROM temp.fold_subjects WHERE instr(f, ?) > 0)"
        let senderDict = "m2.sender IN (SELECT id FROM temp.fold_addresses WHERE instr(a, ?) > 0 OR instr(c, ?) > 0)"
        let recipientDict = """
            m2.ROWID IN (SELECT r.message FROM recipients r WHERE r.address IN
                (SELECT id FROM temp.fold_addresses WHERE instr(a, ?) > 0 OR instr(c, ?) > 0))
            """
        // Vorfilter auf Gruppen: irgendeine nicht geloeschte Kopie in einer erlaubten Mailbox erfuellt cond.
        // IS NOT NULL nur zur Sicherheit fuer NOT IN (eine NULL in der Menge machte NOT IN fuer alle NULL);
        // die Spalte ist im Schema NOT NULL.
        func anyAllowedCopy(_ cond: String) -> String {
            """
            SELECT m2.global_message_id FROM messages m2
                WHERE m2.deleted = 0 AND \(allowedIn) AND m2.global_message_id IS NOT NULL AND (\(cond))
            """
        }
        func textFilter(_ cond: String, _ binds: [SQLValue]) {
            wherePre.append("m.global_message_id IN (\(anyAllowedCopy(cond)))")
            whereBind += allowedBind + binds
        }
        if let t = term(r.from) { textFilter(senderDict, [.text(t), .text(t)]) }
        if let t = term(r.to) { textFilter(recipientDict, [.text(t), .text(t)]) }
        if let t = term(r.subject) { textFilter(subjectDict, [.text(t)]) }
        if let t = term(r.query) {
            textFilter("\(subjectDict) OR \(senderDict) OR \(recipientDict)", [.text(t), .text(t), .text(t), .text(t), .text(t)])
        }

        if let ids = r.mailboxIds {
            having.append("max(CASE WHEN m.mailbox IN (\(placeholders(ids.count))) THEN 1 ELSE 0 END) = 1")
            havingBind += ids.map { .int($0) }
        }
        if let since = r.since { having.append("max(m.date_received) >= ?"); havingBind.append(.int(since)) }
        if let before = r.before { having.append("max(m.date_received) < ?"); havingBind.append(.int(before)) }
        if let u = r.unread { having.append("max(m.read) = \(u ? 0 : 1)") }
        if let f = r.flagged { having.append("max(m.flagged) = \(f ? 1 : 0)") }
        if let h = r.hasAttachment {
            // Als Vorfilter statt EXISTS je Zeile im HAVING: die Menge der Nachrichten mit Anhang wird einmal
            // gebildet. Gleiche Bedeutung: irgendeine erlaubte Kopie hat einen Anhang (bzw. keine).
            wherePre.append("m.global_message_id \(h ? "IN" : "NOT IN") (\(anyAllowedCopy("m2.ROWID IN (SELECT message FROM attachments)")))")
            whereBind += allowedBind
        }
        bind += whereBind + havingBind

        let sql = """
            WITH cand AS (
                SELECT m.global_message_id AS gid, max(m.date_received) AS d
                FROM messages m
                WHERE m.deleted = 0 AND m.mailbox IN (\(placeholders(r.allowedMailboxIds.count)))
                \(wherePre.map { "AND " + $0 }.joined(separator: " "))
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
        if [r.from, r.to, r.subject, r.query].contains(where: { Self.term($0) != nil }) {
            try db.refreshFoldedDictionaries()
        }
        let cte = candidateCTE(r)

        // Gesamtzahl nur auf der ersten Seite, per Fensterfunktion in derselben Abfrage: die Kandidaten
        // werden ohnehin vollstaendig gruppiert, eine zweite Abfrage wiederholte alles. Exakt, ohne Obergrenze.
        let counting = r.countTotal && r.after == nil
        var sql = cte.sql + " SELECT gid, d\(counting ? ", count(*) OVER ()" : "") FROM cand"
        var bind = cte.bind
        if let a = r.after {
            sql += " WHERE (d, gid) < (?, ?)"
            bind += [.int(a.date), .int(a.gid)]
        }
        sql += " ORDER BY d DESC, gid DESC LIMIT ?"
        bind.append(.int(Int64(r.limit + 1)))

        var gids: [Int64] = []
        var total = 0
        try db.query(sql, bind) {
            gids.append($0.int(0))
            if counting { total = Int($0.int(2)) }
        }
        let hasMore = gids.count > r.limit
        if hasMore { gids.removeLast() }

        var result = SearchResult(messages: try loadRows(gids: gids, allowed: r.allowedMailboxIds, maxRecipients: r.maxRecipients),
                                  hasMore: hasMore)
        if counting {
            // Folgeseiten zaehlen nicht; dort fehlen beide Felder. totalMatchedCapped bleibt fuer den Vertrag
            // mit Node erhalten und ist immer false.
            result.totalMatched = total
            result.totalMatchedCapped = false
        }
        return result
    }
}
