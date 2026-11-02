import Foundation

/// Hoechstzahl der gids, auf die `search` eingeschraenkt werden kann (Body-Index-Spec 5.3).
public let searchMaxGids = 200_000

/// Spec 7.3 `search`. Unbekannte Schluessel lehnt der Dispatcher ab (Protocol.swift).
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
    /// Kategorie aus Mail (AMM-19): 0 Wichtiges, 1 Transaktionen, 2 Neuigkeiten, 3 Werbung.
    public var category: Int?
    /// Eingangs-Mailboxen (Teilmenge der erlaubten): dort zaehlt eine Mail ohne Kategorie zu 0, wie in Mail.
    public var inboxMailboxIds: [Int64]?
    /// Nur diese gids (Treffer des Body-Index); alle uebrigen Filter wirken weiter. Leer: keine Kandidaten.
    public var gids: [Int64]?
    public var after: After?
    public var limit: Int
    public var maxRecipients: Int
    public var countTotal: Bool

    public init(allowedMailboxIds: [Int64], mailboxIds: [Int64]? = nil, from: String? = nil, to: String? = nil,
                subject: String? = nil, query: String? = nil, since: Int64? = nil, before: Int64? = nil,
                unread: Bool? = nil, flagged: Bool? = nil, hasAttachment: Bool? = nil,
                category: Int? = nil, inboxMailboxIds: [Int64]? = nil, gids: [Int64]? = nil,
                after: After? = nil,
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
        self.category = category
        self.inboxMailboxIds = inboxMailboxIds
        self.gids = gids
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
    private func candidateCTE(_ r: SearchRequest, _ optional: Schema.OptionalColumns) -> (sql: String, bind: [SQLValue]) {
        var bind: [SQLValue] = r.allowedMailboxIds.map { .int($0) }
        var wherePre: [String] = []
        var whereBind: [SQLValue] = []
        var having: [String] = []
        var havingBind: [SQLValue] = []
        let allowedIn = "m2.mailbox IN (\(placeholders(r.allowedMailboxIds.count)))"
        let allowedBind: [SQLValue] = r.allowedMailboxIds.map { .int($0) }

        let term = Self.term
        // true, sobald ein Vorfilter eine gid-Menge liefert (m.global_message_id IN ...), siehe unten.
        var driveByGid = false
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
        // Das unaere + vor deleted und mailbox nimmt diesen Spalten die Indexnutzung, damit SQLite die Kopien
        // ueber den Index der Bedingung findet (messages_subject_*, messages_sender_*, ROWID) statt ueber
        // messages_deleted_mailbox_index alle erlaubten Zeilen zu lesen. Mit ANALYZE-Statistik waehlt SQLite
        // das von selbst, ohne (frisch angelegter Index) nicht; ob Mails Index sqlite_stat1 fuehrt, ist nicht
        // belegt. Am Ergebnis aendert + nichts.
        func anyAllowedCopy(_ cond: String) -> String {
            """
            SELECT m2.global_message_id FROM messages m2
                WHERE +m2.deleted = 0 AND +\(allowedIn) AND (\(cond))
            """
        }
        func textFilter(_ cond: String, _ binds: [SQLValue]) {
            wherePre.append("m.global_message_id IN (\(anyAllowedCopy(cond)))")
            whereBind += allowedBind + binds
            driveByGid = true
        }
        if let t = term(r.from) { textFilter(senderDict, [.text(t), .text(t)]) }
        if let t = term(r.to) { textFilter(recipientDict, [.text(t), .text(t)]) }
        if let t = term(r.subject) { textFilter(subjectDict, [.text(t)]) }
        if let t = term(r.query) {
            textFilter("\(subjectDict) OR \(senderDict) OR \(recipientDict)", [.text(t), .text(t), .text(t), .text(t), .text(t)])
        }

        if r.gids != nil {
            // Vom Aufrufer gegebene gids, in searchPage in temp.search_gids geschrieben (eine TEMP-Tabelle statt
            // IN (...), weil bis zu 200000 Werte das Variablenlimit von SQLite sprengten). Der Primaerschluessel
            // liefert die Menge sortiert; die Gruppen kommen wie bei den Textfiltern ueber
            // messages_global_message_id_mailbox_index.
            wherePre.append("m.global_message_id IN (SELECT gid FROM temp.search_gids)")
            driveByGid = true
        }
        if let ids = r.mailboxIds {
            // Vorfilter statt HAVING: die gids mit einer nicht geloeschten Kopie in einer der Mailboxen, ueber
            // messages_mailbox_date_received_index (das + nimmt deleted die Indexnutzung). Als HAVING las die
            // Suche alle erlaubten Zeilen, auch fuer eine kleine Mailbox (rund 220 ms auf 242000 Zeilen).
            // ids ist Teilmenge der erlaubten Mailboxen (geprueft in search), die Bedeutung bleibt gleich.
            wherePre.append("""
                m.global_message_id IN (SELECT m2.global_message_id FROM messages m2
                    WHERE +m2.deleted = 0 AND m2.mailbox IN (\(placeholders(ids.count))))
                """)
            whereBind += ids.map { .int($0) }
            driveByGid = true
        }
        if let since = r.since { having.append("max(m.date_received) >= ?"); havingBind.append(.int(since)) }
        if let before = r.before { having.append("max(m.date_received) < ?"); havingBind.append(.int(before)) }
        if let u = r.unread { having.append("max(m.read) = \(u ? 0 : 1)") }
        if let f = r.flagged { having.append("max(m.flagged) = \(f ? 1 : 0)") }
        if let h = r.hasAttachment {
            // Bedeutung: irgendeine nicht geloeschte, erlaubte Kopie hat einen Anhang (true) bzw. keine (false).
            // Die gid-Menge wird einmal gebildet, ausgehend von attachments: CROSS JOIN legt die Reihenfolge
            // fest (je Anhangszeile ein Zugriff ueber den Primaerschluessel von messages). Ohne diese Vorgabe
            // waehlte SQLite messages_deleted_mailbox_index mit (deleted, mailbox IN erlaubt, ROWID IN
            // Anhaenge), also je erlaubte Mailbox einen Zugriff je Anhangsnachricht: bei echter Groesse rund
            // 190 x 15000 Suchschritte, langsamer als das fruehere EXISTS je Zeile. IS NOT NULL nur zur
            // Sicherheit fuer NOT IN (eine NULL in der Menge machte NOT IN fuer alle NULL); die Spalte ist im
            // Schema NOT NULL.
            let withAttachment = """
                SELECT m2.global_message_id FROM attachments a CROSS JOIN messages m2 ON m2.ROWID = a.message
                    WHERE m2.deleted = 0 AND \(allowedIn) AND m2.global_message_id IS NOT NULL
                """
            wherePre.append("m.global_message_id \(h ? "IN" : "NOT IN") (\(withAttachment))")
            whereBind += allowedBind
            if h { driveByGid = true }
        }
        if let c = r.category {
            let (cond, binds) = Self.categoryFilter(c, inbox: r.inboxMailboxIds ?? [], allowedIn: allowedIn,
                                                    allowedBind: allowedBind, optional)
            wherePre.append("m.global_message_id IN (\(cond))")
            whereBind += binds
            driveByGid = true
        }
        bind += whereBind + havingBind
        // Gibt es eine gid-Menge, nimmt das unaere + deleted und mailbox die Indexnutzung, damit SQLite die
        // Gruppen ueber messages_global_message_id_mailbox_index aus der Menge holt (schon nach gid sortiert,
        // kein GROUP-BY-Baum) statt alle erlaubten Zeilen ueber messages_deleted_mailbox_index zu lesen. Das
        // ist auch dann nicht langsamer, wenn die Menge fast alle Nachrichten umfasst (gemessen: Betreff "e"
        // auf 242000 Zeilen). Bei mehreren Mengen waehlt SQLite eine davon. Ohne Menge (kein Filter, nur
        // HAVING-Filter oder nur hasAttachment = false) bleibt der Durchlauf ueber alle erlaubten Zeilen.
        let plus = driveByGid ? "+" : ""

        let sql = """
            WITH cand AS (
                SELECT m.global_message_id AS gid, max(m.date_received) AS d
                FROM messages m
                WHERE \(plus)m.deleted = 0 AND \(plus)m.mailbox IN (\(placeholders(r.allowedMailboxIds.count)))
                \(wherePre.map { "AND " + $0 }.joined(separator: " "))
                GROUP BY m.global_message_id
                \(having.isEmpty ? "" : "HAVING " + having.joined(separator: " AND "))
            )
            """
        return (sql, bind)
    }

    /// Effektive Kategorie einer Kopie m2 (AMM-19): Absender-Uebersteuerung vor dem Modellwert, Join ueber den
    /// Absender. Mail schreibt eine Uebersteuerung in beide Tabellen; COALESCE deckt beide Faelle ab. Ohne
    /// Uebersteuerungstabellen bleibt der Modellwert, ohne Modellspalten NULL. Feste Ausdruecke, nie Eingaben.
    static func effectiveCategory(_ o: Schema.OptionalColumns) -> (joins: String, override: String, effective: String) {
        let model = o.modelCategory ? "g.model_category" : "NULL"
        guard o.addressCategory else { return ("", "NULL", model) }
        var joins = "LEFT JOIN business_addresses ba ON ba.address = m2.sender"
        var override = "ba.category"
        if o.businessCategory {
            joins += " LEFT JOIN business_categories bc ON bc.business = ba.business"
            override = "COALESCE(ba.category, bc.category)"
        }
        return (joins, override, "COALESCE(\(override), \(model))")
    }

    /// gid-Menge fuer `category` (AMM-19, Regeln am 2026-11-02 mit der Oberflaeche abgeglichen):
    /// 1 bis 3: effektive Kategorie gleich dem Wert. 0 (Wichtiges): effektive Kategorie 0 oder
    /// model_high_impact = 1, in Eingangs-Mailboxen zusaetzlich ohne effektive Kategorie.
    /// Die Menge entsteht aus Teilmengen, die je einen Index nutzen, statt alle erlaubten Zeilen samt Joins
    /// zu lesen (COALESCE nimmt jedem Index die Wirkung):
    /// - Modellwert ueber message_global_data_model_category_index, dann die Kopien ueber
    ///   messages_global_message_id_mailbox_index; die effektive Kategorie wird dort nochmals geprueft, weil
    ///   eine Uebersteuerung den Modellwert ersetzt
    /// - Uebersteuerung: die (wenigen) Absender in business_addresses, ihre Kopien ueber messages_sender_index
    /// - nur 0: model_high_impact = 1 (ohne Index, ein Durchlauf ueber message_global_data) und die Eingaenge
    ///   ueber messages_mailbox_date_received_index
    private static func categoryFilter(_ c: Int, inbox: [Int64], allowedIn: String, allowedBind: [SQLValue],
                                       _ o: Schema.OptionalColumns) -> (sql: String, bind: [SQLValue]) {
        let e = effectiveCategory(o)
        let copy = "+m2.deleted = 0 AND +\(allowedIn)"
        let value = SQLValue.int(Int64(c))
        var parts: [String] = []
        var bind: [SQLValue] = []
        parts.append("""
            SELECT m2.global_message_id FROM message_global_data g
                CROSS JOIN messages m2 ON m2.global_message_id = g.ROWID \(e.joins)
                WHERE g.model_category = ? AND \(copy) AND \(e.effective) = ?
            """)
        bind += [value] + allowedBind + [value]
        if o.addressCategory {
            // business_categories haengt nur ueber ba.business an; der LEFT JOIN steht deshalb vor messages.
            let bcJoin = o.businessCategory ? "LEFT JOIN business_categories bc ON bc.business = ba.business" : ""
            parts.append("""
                SELECT m2.global_message_id FROM business_addresses ba \(bcJoin)
                    CROSS JOIN messages m2 ON m2.sender = ba.address
                    WHERE \(e.override) = ? AND \(copy)
                """)
            bind += [value] + allowedBind
        }
        if c == 0 {
            parts.append("""
                SELECT m2.global_message_id FROM message_global_data g
                    CROSS JOIN messages m2 ON m2.global_message_id = g.ROWID
                    WHERE g.model_high_impact = 1 AND \(copy)
                """)
            bind += allowedBind
            if !inbox.isEmpty {
                parts.append("""
                    SELECT m2.global_message_id FROM messages m2
                        LEFT JOIN message_global_data g ON g.ROWID = m2.global_message_id \(e.joins)
                        WHERE +m2.deleted = 0 AND m2.mailbox IN (\(placeholders(inbox.count))) AND \(e.effective) IS NULL
                    """)
                bind += inbox.map { .int($0) }
            }
        }
        return (parts.joined(separator: " UNION ALL "), bind)
    }

    public func search(_ r: SearchRequest) throws(HelperFailure) -> SearchResult {
        guard !r.allowedMailboxIds.isEmpty else { throw Self.invalid("allowedMailboxIds") }
        guard (1...2000).contains(r.limit) else { throw Self.invalid("limit") }
        guard r.maxRecipients >= 0 else { throw Self.invalid("maxRecipients") }
        if let ids = r.mailboxIds {
            guard !ids.isEmpty, Set(ids).isSubset(of: Set(r.allowedMailboxIds)) else { throw Self.invalid("mailboxIds") }
        }
        if let gids = r.gids { guard gids.count <= searchMaxGids else { throw Self.invalid("gids") } }
        if let c = r.category { guard (0...3).contains(c) else { throw Self.invalid("category") } }
        if let ids = r.inboxMailboxIds {
            guard r.category != nil, Set(ids).isSubset(of: Set(r.allowedMailboxIds)) else { throw Self.invalid("inboxMailboxIds") }
        }

        let (db, optional) = try envelopeDatabaseWithColumns()
        if r.category != nil, !optional.modelCategory {
            throw HelperFailure(code: .categoryUnsupported, message: "Missing columns: message_global_data.model_category, message_global_data.model_high_impact")
        }
        // Eine Lesetransaktion fuer Fold-Nachtrag, Seitenabfrage und Zeilenaufbau: sonst koennte Mail
        // dazwischen schreiben, und eine gefundene gid fehlte in `messages` oder totalMatched passte nicht
        // zur Seite. Die Transaktion dauert so lange wie die Suche (Millisekunden bis wenige hundert).
        return try db.readTransaction { () throws(HelperFailure) in try searchPage(r, db, optional) }
    }

    private func searchPage(_ r: SearchRequest, _ db: Database, _ optional: Schema.OptionalColumns) throws(HelperFailure) -> SearchResult {
        if [r.from, r.to, r.subject, r.query].contains(where: { Self.term($0) != nil }) {
            try db.refreshFoldedDictionaries()
        }
        if let gids = r.gids { try db.fillSearchGids(gids) }
        let cte = candidateCTE(r, optional)

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
        testHookAfterPageQuery?()

        var result = SearchResult(messages: try loadRows(gids: gids, allowed: r.allowedMailboxIds, maxRecipients: r.maxRecipients),
                                  hasMore: hasMore)
        // Speicher freigeben; die naechste Suche mit gids fuellt die Tabelle ohnehin neu.
        if r.gids != nil { try db.execute("DELETE FROM temp.search_gids") }
        if counting {
            // Folgeseiten zaehlen nicht; dort fehlen beide Felder. totalMatchedCapped bleibt fuer den Vertrag
            // mit Node erhalten und ist immer false.
            result.totalMatched = total
            result.totalMatchedCapped = false
        }
        return result
    }
}
