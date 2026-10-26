import Foundation
import Testing
@testable import MailHelperCore

/// hasAttachment auf einer Ablage in echter Verteilung (FixtureBuilder `.realSize`). Die Treffer werden
/// gegen zwei unabhaengig formulierte Referenzabfragen geprueft: das fruehere EXISTS je Zeile im HAVING
/// und den IN-Vorfilter aus 7cb2878. Beide Formen muessen dieselben gid-Mengen liefern wie `search`.
@Suite struct AttachmentFilterTests {
    /// Alle gids einer Suche, seitenweise ueber den Keyset.
    static func allGids(_ s: MailStore, _ base: SearchRequest) throws -> Set<Int64> {
        var req = base
        req.limit = 2000
        req.countTotal = false
        var out: Set<Int64> = []
        while true {
            let r = try s.search(req)
            out.formUnion(r.messages.map(\.gid))
            guard r.hasMore, let last = r.messages.last else { return out }
            req.after = .init(date: last.dateReceived, gid: last.gid)
        }
    }

    enum Shape: String, CaseIterable { case existsInHaving, inPrefilter }

    /// Referenz-CTE mit literalen Mailbox-ids (nur im Test; die ids sind Ganzzahlen aus dem Builder).
    static func referenceCTE(_ shape: Shape, has: Bool, allowed: [Int64], subject: String? = nil) -> String {
        let ids = allowed.map(String.init).joined(separator: ",")
        var wherePre = ""
        var having = ""
        if let subject {
            // Gleiche Bedeutung wie der Textfilter, ohne TEMP-Cache: Betreff irgendeiner erlaubten Kopie.
            wherePre += """
                AND m.global_message_id IN (SELECT m2.global_message_id FROM messages m2 JOIN subjects s ON s.ROWID = m2.subject
                    WHERE m2.deleted = 0 AND m2.mailbox IN (\(ids)) AND instr(lower(s.subject), '\(subject)') > 0)
                """
        }
        switch shape {
        case .existsInHaving:
            having = "HAVING max(EXISTS (SELECT 1 FROM attachments a WHERE a.message = m.ROWID)) = \(has ? 1 : 0)"
        case .inPrefilter:
            wherePre += """
                AND m.global_message_id \(has ? "IN" : "NOT IN") (SELECT m2.global_message_id FROM messages m2
                    WHERE m2.deleted = 0 AND m2.mailbox IN (\(ids)) AND m2.global_message_id IS NOT NULL
                    AND (m2.ROWID IN (SELECT message FROM attachments)))
                """
        }
        return """
            WITH cand AS (SELECT m.global_message_id AS gid, max(m.date_received) AS d FROM messages m
                WHERE m.deleted = 0 AND m.mailbox IN (\(ids)) \(wherePre) GROUP BY m.global_message_id \(having))
            """
    }

    static func referenceGids(_ f: Fixture, _ shape: Shape, has: Bool, allowed: [Int64], subject: String? = nil) throws -> Set<Int64> {
        let db = try SQLiteHandle(path: f.envelopeIndex.path, readOnly: true)
        let rows = try db.texts(referenceCTE(shape, has: has, allowed: allowed, subject: subject) + " SELECT gid FROM cand")
        return Set(rows.compactMap { Int64($0) })
    }

    static func assertEquivalent(_ f: Fixture, _ s: MailStore, allowed: [Int64]) throws {
        let all = try allGids(s, .init(allowedMailboxIds: allowed, limit: 1))
        let yes = try allGids(s, .init(allowedMailboxIds: allowed, hasAttachment: true, limit: 1))
        let no = try allGids(s, .init(allowedMailboxIds: allowed, hasAttachment: false, limit: 1))
        #expect(!yes.isEmpty && !no.isEmpty)
        #expect(yes.isDisjoint(with: no))
        #expect(yes.union(no) == all)
        for shape in Shape.allCases {
            #expect(try referenceGids(f, shape, has: true, allowed: allowed) == yes, "\(shape) true")
            #expect(try referenceGids(f, shape, has: false, allowed: allowed) == no, "\(shape) false")
        }
        // Zusammen mit einem Textfilter: Schnittmenge der Einzelfilter und gleich der Referenz.
        let subject = try allGids(s, .init(allowedMailboxIds: allowed, subject: "rechnung", limit: 1))
        for has in [true, false] {
            let both = try allGids(s, .init(allowedMailboxIds: allowed, subject: "rechnung", hasAttachment: has, limit: 1))
            #expect(!both.isEmpty, "subject + \(has)")
            #expect(both == subject.intersection(has ? yes : no), "subject + \(has)")
            for shape in Shape.allCases {
                #expect(try referenceGids(f, shape, has: has, allowed: allowed, subject: "rechnung") == both, "\(shape) subject + \(has)")
            }
        }
    }

    @Test func attachmentFilterMatchesReferenceShapes() throws {
        let f = try FixtureBuilder.build(extraMessages: 4_000, bulk: .realSize)
        let s = MailStore(config: f.config)
        let allowed = FixtureBuilder.realSizeAllowed(f)
        // Die Randfaelle kommen vor: gids, deren einzige Kopie mit Anhang geloescht ist oder in einer nicht
        // erlaubten Mailbox liegt, waehrend eine andere Kopie sichtbar ist.
        let edges = try f.count("""
            SELECT count(DISTINCT m.global_message_id) FROM messages m JOIN attachments a ON a.message = m.ROWID
            WHERE (m.deleted = 1 OR m.mailbox BETWEEN \(FixtureBuilder.realSizeExcluded.lowerBound) AND \(FixtureBuilder.realSizeExcluded.upperBound))
                AND NOT EXISTS (SELECT 1 FROM messages c JOIN attachments b ON b.message = c.ROWID
                    WHERE c.global_message_id = m.global_message_id AND c.deleted = 0
                        AND c.mailbox NOT BETWEEN \(FixtureBuilder.realSizeExcluded.lowerBound) AND \(FixtureBuilder.realSizeExcluded.upperBound))
                AND EXISTS (SELECT 1 FROM messages c WHERE c.global_message_id = m.global_message_id AND c.deleted = 0
                    AND c.mailbox NOT BETWEEN \(FixtureBuilder.realSizeExcluded.lowerBound) AND \(FixtureBuilder.realSizeExcluded.upperBound))
            """)
        #expect(edges > 10)
        try Self.assertEquivalent(f, s, allowed: allowed)
        // Engere Erlaubnis: ohne die grosse Mailbox 1000 verschieben sich viele Gruppen zwischen true und false.
        try Self.assertEquivalent(f, s, allowed: allowed.filter { $0 != FixtureBuilder.realSizeMailboxes.lowerBound })
    }

    /// Zeitmessung auf echter Groesse (rund 242000 Zeilen). Laeuft nur mit PERF_REAL_SIZE=1, am besten im
    /// Release-Build: `PERF_REAL_SIZE=1 swift test -c release --package-path swift --filter realSize`.
    @Test(.enabled(if: ProcessInfo.processInfo.environment["PERF_REAL_SIZE"] == "1"))
    func realSizeAttachmentPagesAreFast() throws {
        let f = try FixtureBuilder.build(extraMessages: 121_000, bulk: .realSize)
        let allowed = FixtureBuilder.realSizeAllowed(f)
        print("real size: messages \(try f.count("SELECT count(*) FROM messages")), gids \(try f.count("SELECT count(DISTINCT global_message_id) FROM messages")), attachments \(try f.count("SELECT count(*) FROM attachments")) on \(try f.count("SELECT count(DISTINCT message) FROM attachments")) messages, allowed mailboxes \(allowed.count) of \(try f.count("SELECT count(*) FROM mailboxes"))")

        func median(_ run: () throws -> Void) rethrows -> Duration {
            try run()   // warm
            var d: [Duration] = []
            for _ in 0..<5 {
                let t0 = ContinuousClock.now
                try run()
                d.append(ContinuousClock.now - t0)
            }
            return d.sorted()[2]
        }
        func page(_ r: SearchRequest) -> SearchRequest {
            var r = r
            r.limit = 20
            r.countTotal = true
            return r
        }
        let cases: [(name: String, req: SearchRequest, limit: Duration?)] = [
            ("no filter", page(.init(allowedMailboxIds: allowed, limit: 20)), nil),
            ("hasAttachment true", page(.init(allowedMailboxIds: allowed, hasAttachment: true, limit: 20)), .milliseconds(150)),
            ("hasAttachment false", page(.init(allowedMailboxIds: allowed, hasAttachment: false, limit: 20)), nil),
            ("subject", page(.init(allowedMailboxIds: allowed, subject: "rechnung", limit: 20)), nil),
            ("subject + hasAttachment true", page(.init(allowedMailboxIds: allowed, subject: "rechnung", hasAttachment: true, limit: 20)), .milliseconds(150)),
            ("subject + hasAttachment false", page(.init(allowedMailboxIds: allowed, subject: "rechnung", hasAttachment: false, limit: 20)), nil),
            ("subject matching all", page(.init(allowedMailboxIds: allowed, subject: "e", limit: 20)), nil),
            ("from", page(.init(allowedMailboxIds: allowed, from: "jürgen größe 1", limit: 20)), nil),
            ("to", page(.init(allowedMailboxIds: allowed, to: "person12", limit: 20)), nil),
            ("query", page(.init(allowedMailboxIds: allowed, query: "straße 4", limit: 20)), nil),
        ]
        // Erst ohne ANALYZE-Statistik (wie der frisch gebaute Index), dann mit; ob Mails Index sqlite_stat1
        // fuehrt, ist nicht belegt, und der Planer entscheidet je nach Statistik anders.
        for stats in [false, true] {
            if stats { try SQLiteHandle(path: f.envelopeIndex.path).exec("ANALYZE") }
            let s = MailStore(config: f.config)
            for c in cases {
                let first = try s.search(c.req)
                let m = try median {
                    let r = try s.search(c.req)
                    #expect(r == first, "\(c.name)")
                }
                print("real size search, stats \(stats), \(c.name): median \(m), total \(first.totalMatched ?? -1)")
                #expect(first.messages.count == 20 && first.hasMore, "\(c.name)")
                if let limit = c.limit { #expect(m < limit, "\(c.name)") }
            }
            // Breite Textfilter, nur Zeitausgabe ohne Pruefung (fast alle Zeilen treffen).
            for (name, req) in [("query broad", page(.init(allowedMailboxIds: allowed, query: "e", limit: 20))),
                                ("to broad", page(.init(allowedMailboxIds: allowed, to: "example", limit: 20)))] {
                var total = -1
                let m = try median { total = try s.search(req).totalMatched ?? -1 }
                print("real size search, stats \(stats), \(name): median \(m), total \(total)")
            }
            // Vergleichsformen, nur die Kandidatenseite mit Zaehlung (ohne Zeilenaufbau), eigene Verbindung.
            let db = try SQLiteHandle(path: f.envelopeIndex.path, readOnly: true)
            for shape in Shape.allCases {
                for has in [true, false] {
                    let sql = Self.referenceCTE(shape, has: has, allowed: allowed)
                        + " SELECT gid, d, count(*) OVER () FROM cand ORDER BY d DESC, gid DESC LIMIT 21"
                    let m = try median { _ = try db.texts(sql) }
                    print("real size reference, stats \(stats), \(shape.rawValue), hasAttachment \(has): median \(m)")
                }
            }
        }
        try Self.assertEquivalent(f, MailStore(config: f.config), allowed: allowed)
    }
}
