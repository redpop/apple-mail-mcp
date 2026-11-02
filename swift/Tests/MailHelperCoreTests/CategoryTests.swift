import Foundation
import Testing
@testable import MailHelperCore

/// Filter `category` und Felder `category`/`highImpact` (AMM-19). Die Werte stehen nicht im Seed, sondern
/// werden je Test per SQL gesetzt, damit seed.json und die Contract-Dateien unberuehrt bleiben.
@Suite struct CategoryTests {
    /// Eine Mail je Fall, Betreff "Kategorietest <name>", eigener Absender je Mail.
    struct Case {
        let name: String
        let gid: Int64
        let rowid: Int64
        let mailbox: String
        let model: Int64?
        var highImpact = false
    }

    static let cases: [Case] = [
        Case(name: "wichtig", gid: 4001, rowid: 9201, mailbox: "archiv2024", model: 0),
        Case(name: "transaktion", gid: 4002, rowid: 9202, mailbox: "archiv2024", model: 1),
        Case(name: "neuigkeit", gid: 4003, rowid: 9203, mailbox: "inbox", model: 2),
        Case(name: "werbung", gid: 4004, rowid: 9204, mailbox: "inbox", model: 3),
        Case(name: "ohneeingang", gid: 4005, rowid: 9205, mailbox: "inbox", model: nil),
        Case(name: "ohnearchiv", gid: 4006, rowid: 9206, mailbox: "archiv2024", model: nil),
        Case(name: "unbekannt", gid: 4007, rowid: 9207, mailbox: "inbox", model: 7),
        Case(name: "dringend", gid: 4008, rowid: 9208, mailbox: "archiv2024", model: 2, highImpact: true),
        // Absender-Uebersteuerung in business_addresses: Werbung -> Transaktionen.
        Case(name: "umgestellt", gid: 4009, rowid: 9209, mailbox: "inbox", model: 3),
        // Uebersteuerung nur in business_categories (business_addresses.category NULL): -> Neuigkeiten.
        Case(name: "firma", gid: 4010, rowid: 9210, mailbox: "archiv2024", model: nil),
        // Uebersteuerung auf Wichtiges: Transaktionen -> Wichtiges.
        Case(name: "hochgestuft", gid: 4011, rowid: 9211, mailbox: "archiv2024", model: 1),
        // Nur in Junk: zaehlt nicht, wenn Junk nicht erlaubt ist.
        Case(name: "nurjunk", gid: 4012, rowid: 9212, mailbox: "junk", model: 1),
    ]

    static func gid(_ name: String) -> Int64 { cases.first { $0.name == name }!.gid }

    static func seedMessage(_ c: Case) -> Seed.Message {
        Seed.Message(
            name: "cat-\(c.name)", gid: c.gid, rowid: c.rowid, mailbox: c.mailbox, subjectPrefix: "",
            subject: "Kategorietest \(c.name)",
            sender: .init(address: "\(c.name)@example.com", comment: "Absender \(c.name)"), recipients: [],
            dateReceived: 1_700_003_000 + c.rowid, dateSent: 1_700_003_000, read: true, flagged: false, deleted: false,
            conversationId: 0, messageIdHeader: "<cat-\(c.rowid)@example.com>", attachments: [], file: "full",
            storeIndex: 0, senderStored: nil, emlx: nil, body: "Synthetischer Text.\n")
    }

    /// Fixture mit den Faellen; `dropping` entfernt danach eine Spalte (Kompatibilitaet).
    static func build(dropping: (table: String, column: String)? = nil) throws -> Fixture {
        let f = try FixtureBuilder.build(extraSeedMessages: cases.map(seedMessage))
        let db = try SQLiteHandle(path: f.envelopeIndex.path)
        for c in cases {
            try db.run("UPDATE message_global_data SET model_category = ?, model_high_impact = ? WHERE ROWID = ?",
                       [c.model.map { .int($0) } ?? .null, .int(c.highImpact ? 1 : 0), .int(c.gid)])
        }
        func sender(_ name: String) throws -> Int64 {
            try db.scalarInt("SELECT ROWID FROM addresses WHERE address = '\(name)@example.com'")
        }
        try db.run("INSERT INTO businesses (ROWID, address_comment, domain) VALUES (1, 'A', 'a.example.com'), (2, 'B', 'b.example.com'), (3, 'C', 'c.example.com')")
        try db.run("INSERT INTO business_addresses (address, business, category) VALUES (?, 1, 1)", [.int(try sender("umgestellt"))])
        try db.run("INSERT INTO business_addresses (address, business, category) VALUES (?, 2, NULL)", [.int(try sender("firma"))])
        try db.run("INSERT INTO business_categories (business, category) VALUES (2, 2)")
        try db.run("INSERT INTO business_addresses (address, business, category) VALUES (?, 3, 0)", [.int(try sender("hochgestuft"))])
        if let d = dropping {
            let indexes = try db.texts("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = '\(d.table)' AND sql LIKE '%\(d.column)%'")
            for name in indexes { try db.exec("DROP INDEX \"\(name)\"") }
            try db.exec("ALTER TABLE \(d.table) DROP COLUMN \(d.column)")
        }
        return f
    }

    static func found(_ s: MailStore, _ f: Fixture, _ category: Int, allowed: [Int64]? = nil, inbox: Bool = true) throws -> Set<Int64> {
        let allowed = allowed ?? f.allMailboxIds
        let inboxIds = inbox ? [f.mailboxId(named: "inbox")].filter(allowed.contains) : nil
        return try AttachmentFilterTests.allGids(s, .init(allowedMailboxIds: allowed, subject: "kategorietest",
                                                          category: category, inboxMailboxIds: inboxIds, limit: 1))
    }

    @Test func filterFollowsMailsRules() throws {
        let f = try Self.build()
        let s = MailStore(config: f.config)
        let noJunk = f.allMailboxIds.filter { $0 != f.mailboxId(named: "junk") }
        let g = Self.gid
        #expect(try Self.found(s, f, 0, allowed: noJunk) == [g("wichtig"), g("ohneeingang"), g("dringend"), g("hochgestuft")])
        #expect(try Self.found(s, f, 1, allowed: noJunk) == [g("transaktion"), g("umgestellt")])
        #expect(try Self.found(s, f, 2, allowed: noJunk) == [g("neuigkeit"), g("dringend"), g("firma")])
        #expect(try Self.found(s, f, 3, allowed: noJunk) == [g("werbung")])
        // Junk erlaubt: die Kopie dort zaehlt.
        #expect(try Self.found(s, f, 1).contains(g("nurjunk")))
        // Ohne Eingangsliste zaehlt NULL nirgends zu Wichtiges.
        #expect(try Self.found(s, f, 0, allowed: noJunk, inbox: false) == [g("wichtig"), g("dringend"), g("hochgestuft")])
        // Eingang nicht erlaubt: die Mail ohne Wert dort faellt weg.
        let noInbox = noJunk.filter { $0 != f.mailboxId(named: "inbox") }
        #expect(try Self.found(s, f, 0, allowed: noInbox) == [g("wichtig"), g("dringend"), g("hochgestuft")])
    }

    @Test func rowsCarryEffectiveCategory() throws {
        let f = try Self.build()
        let s = MailStore(config: f.config)
        let rows = try s.search(.init(allowedMailboxIds: f.allMailboxIds, subject: "kategorietest", limit: 50)).messages
        let byGid = Dictionary(uniqueKeysWithValues: rows.map { ($0.gid, $0) })
        let expected: [String: Int64?] = [
            "wichtig": 0, "transaktion": 1, "neuigkeit": 2, "werbung": 3, "ohneeingang": nil, "ohnearchiv": nil,
            "unbekannt": 7, "dringend": 2, "umgestellt": 1, "firma": 2, "hochgestuft": 0, "nurjunk": 1,
        ]
        for (name, category) in expected {
            let row = try #require(byGid[Self.gid(name)], "\(name)")
            #expect(row.category == category, "\(name)")
            #expect(row.highImpact == (name == "dringend"), "\(name)")
        }
        // Seed-Mails ohne Wert.
        let plain = try s.search(.init(allowedMailboxIds: f.allMailboxIds, subject: "rechnung", limit: 5)).messages
        #expect(!plain.isEmpty && plain.allSatisfy { $0.category == nil && !$0.highImpact })
    }

    @Test func filterCombinesWithOtherFiltersAndCounts() throws {
        let f = try Self.build()
        let s = MailStore(config: f.config)
        let r = try s.search(.init(allowedMailboxIds: f.allMailboxIds, category: 2, limit: 2, countTotal: true))
        #expect(r.totalMatched == 3 && r.hasMore && r.messages.count == 2)
        let inArchive = try AttachmentFilterTests.allGids(s, .init(
            allowedMailboxIds: f.allMailboxIds, mailboxIds: [f.mailboxId(named: "archiv2024")], category: 2, limit: 1))
        #expect(inArchive == [Self.gid("dringend"), Self.gid("firma")])
    }

    @Test func invalidValuesAreRejected() throws {
        let f = try Self.build()
        let s = MailStore(config: f.config)
        let all = f.allMailboxIds
        for req in [
            SearchRequest(allowedMailboxIds: all, category: 4, limit: 5),
            SearchRequest(allowedMailboxIds: all, category: -1, limit: 5),
            SearchRequest(allowedMailboxIds: all, inboxMailboxIds: [f.mailboxId(named: "inbox")], limit: 5),
            SearchRequest(allowedMailboxIds: [f.mailboxId(named: "archiv2024")], category: 0, inboxMailboxIds: [f.mailboxId(named: "inbox")], limit: 5),
        ] {
            #expect(throws: HelperFailure.self) { try s.search(req) }
            do { _ = try s.search(req) } catch { #expect(error.code == .invalidInput) }
        }
    }

    @Test func missingModelColumnFailsOnlyTheFilter() throws {
        for column in ["model_category", "model_high_impact"] {
            let f = try Self.build(dropping: ("message_global_data", column))
            let s = MailStore(config: f.config)
            do {
                _ = try s.search(.init(allowedMailboxIds: f.allMailboxIds, category: 1, limit: 5))
                Issue.record("\(column): expected CATEGORY_UNSUPPORTED")
            } catch {
                #expect(error.code == .categoryUnsupported, "\(column)")
            }
            let rows = try s.search(.init(allowedMailboxIds: f.allMailboxIds, subject: "kategorietest", limit: 50)).messages
            #expect(rows.count == Self.cases.count, "\(column)")
            // Ohne Modellwert bleibt nur die Uebersteuerung.
            let byGid = Dictionary(uniqueKeysWithValues: rows.map { ($0.gid, $0.category) })
            #expect(byGid[Self.gid("umgestellt")] == 1 && byGid[Self.gid("werbung")] == .some(nil), "\(column)")
            #expect(rows.allSatisfy { !$0.highImpact }, "\(column)")
            #expect(s.probe().schema?.categories == false, "\(column)")
        }
    }

    @Test func missingOverrideColumnsFallBackToTheModel() throws {
        let f = try Self.build(dropping: ("business_addresses", "category"))
        let s = MailStore(config: f.config)
        let g = Self.gid
        #expect(try Self.found(s, f, 3) == [g("werbung"), g("umgestellt")])
        #expect(try Self.found(s, f, 2) == [g("neuigkeit"), g("dringend")])
        #expect(s.probe().schema?.categories == true)
    }
}
