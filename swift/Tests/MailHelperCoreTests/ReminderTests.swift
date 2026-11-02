import Foundation
import Testing
@testable import MailHelperCore

/// Erinnerungen ("Erinnern", AMM-20): Mail zeigt eine Mail ab message_global_data.read_later_date wieder im
/// Eingang ihres Kontos, auch wenn sie in einem anderen Ordner liegt. Die Termine stehen nicht im Seed, sondern
/// werden je Test per SQL gesetzt, damit seed.json und die Contract-Dateien unberuehrt bleiben.
@Suite struct ReminderTests {
    static let due: Int64 = 1_000_000
    static let future: Int64 = 4_000_000_000

    struct Case {
        let name: String
        let gid: Int64
        let rowid: Int64
        let mailbox: String
        let readLater: Int64?
        var deleted = false
        var read = true
    }

    static let cases: [Case] = [
        Case(name: "archiv", gid: 5001, rowid: 9301, mailbox: "archiv2024", readLater: due, read: false),
        Case(name: "zukunft", gid: 5002, rowid: 9302, mailbox: "archiv2024", readLater: future),
        Case(name: "eingang", gid: 5003, rowid: 9303, mailbox: "inbox", readLater: due),
        Case(name: "junk", gid: 5004, rowid: 9304, mailbox: "junk", readLater: due),
        Case(name: "lokal", gid: 5005, rowid: 9305, mailbox: "lokal", readLater: due),
        Case(name: "geloescht", gid: 5006, rowid: 9306, mailbox: "archiv2024", readLater: due, deleted: true),
        Case(name: "ohne", gid: 5007, rowid: 9307, mailbox: "archiv2024", readLater: nil),
        Case(name: "null", gid: 5008, rowid: 9308, mailbox: "archiv2024", readLater: 0),
    ]

    static func gid(_ name: String) -> Int64 { cases.first { $0.name == name }!.gid }

    static func seedMessage(_ c: Case) -> Seed.Message {
        Seed.Message(
            name: "rem-\(c.name)", gid: c.gid, rowid: c.rowid, mailbox: c.mailbox, subjectPrefix: "",
            subject: "Erinnerungstest \(c.name)",
            sender: .init(address: "rem-\(c.name)@example.com", comment: ""), recipients: [],
            dateReceived: 1_700_004_000 + c.rowid, dateSent: 1_700_004_000, read: c.read, flagged: false,
            deleted: c.deleted, conversationId: 0, messageIdHeader: "<rem-\(c.rowid)@example.com>", attachments: [],
            file: "full", storeIndex: 0, senderStored: nil, emlx: nil, body: "Synthetischer Text.\n")
    }

    static func build(dropColumn: Bool = false) throws -> Fixture {
        let f = try FixtureBuilder.build(extraSeedMessages: cases.map(seedMessage))
        let db = try SQLiteHandle(path: f.envelopeIndex.path)
        for c in cases {
            try db.run("UPDATE message_global_data SET read_later_date = ? WHERE ROWID = ?",
                       [c.readLater.map { .int($0) } ?? .null, .int(c.gid)])
        }
        if dropColumn {
            let indexes = try db.texts("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'message_global_data' AND sql LIKE '%read_later_date%'")
            for name in indexes { try db.exec("DROP INDEX \"\(name)\"") }
            try db.exec("ALTER TABLE message_global_data DROP COLUMN read_later_date")
        }
        return f
    }

    /// Erlaubte Mailboxen von Konto A ohne Junk, wie Node sie fuer den Eingang von A schickt.
    static func accountA(_ f: Fixture, junk: Bool = false) -> [Int64] {
        ["inbox", "archiv2024", "sent", "trash", "aerger"].map(f.mailboxId(named:)) + (junk ? [f.mailboxId(named: "junk")] : [])
    }

    static func inInbox(_ s: MailStore, _ f: Fixture, reminders: [Int64]?, allowed: [Int64]? = nil) throws -> Set<Int64> {
        let all = try AttachmentFilterTests.allGids(s, .init(
            allowedMailboxIds: allowed ?? f.allMailboxIds, mailboxIds: [f.mailboxId(named: "inbox")],
            reminderMailboxIds: reminders, limit: 1))
        return all.filter { g in cases.contains { $0.gid == g } }
    }

    @Test func inboxIncludesDueRemindersOfTheGivenMailboxes() throws {
        let f = try Self.build()
        let s = MailStore(config: f.config)
        let g = Self.gid
        #expect(try Self.inInbox(s, f, reminders: nil) == [g("eingang")])
        #expect(try Self.inInbox(s, f, reminders: Self.accountA(f)) == [g("eingang"), g("archiv")])
        #expect(try Self.inInbox(s, f, reminders: Self.accountA(f, junk: true)) == [g("eingang"), g("archiv"), g("junk")])
        // Eine Mail, die im Eingang liegt und faellig ist, kommt nur einmal.
        let r = try s.search(.init(allowedMailboxIds: f.allMailboxIds, mailboxIds: [f.mailboxId(named: "inbox")],
                                   subject: "erinnerungstest", reminderMailboxIds: Self.accountA(f), limit: 50,
                                   countTotal: true))
        #expect(r.totalMatched == 2 && r.messages.count == 2)
        // Die Zeile nennt den echten Ordner.
        let row = try #require(r.messages.first { $0.gid == g("archiv") })
        #expect(row.mailboxIds == [f.mailboxId(named: "archiv2024")])
    }

    @Test func remindersCombineWithOtherFilters() throws {
        let f = try Self.build()
        let s = MailStore(config: f.config)
        let unread = try AttachmentFilterTests.allGids(s, .init(
            allowedMailboxIds: f.allMailboxIds, mailboxIds: [f.mailboxId(named: "inbox")], subject: "erinnerungstest",
            unread: true, reminderMailboxIds: Self.accountA(f), limit: 1))
        #expect(unread == [Self.gid("archiv")])
    }

    @Test func rowsCarryTheReminderDate() throws {
        let f = try Self.build()
        let s = MailStore(config: f.config)
        let rows = try s.search(.init(allowedMailboxIds: f.allMailboxIds, subject: "erinnerungstest", limit: 50)).messages
        let byGid = Dictionary(uniqueKeysWithValues: rows.map { ($0.gid, $0.reminder) })
        #expect(byGid[Self.gid("archiv")] == .some(Self.due))
        #expect(byGid[Self.gid("zukunft")] == .some(Self.future))
        #expect(byGid[Self.gid("ohne")] == .some(nil))
        #expect(byGid[Self.gid("null")] == .some(nil))
        let plain = try s.search(.init(allowedMailboxIds: f.allMailboxIds, subject: "rechnung", limit: 5)).messages
        #expect(!plain.isEmpty && plain.allSatisfy { $0.reminder == nil })
    }

    @Test func listMailboxesReportsDueReminderCopies() throws {
        let f = try Self.build()
        let s = MailStore(config: f.config)
        let due = try s.listMailboxes().dueReminders.filter { r in Self.cases.contains { $0.gid == r.gid } }
        let expected = [
            DueReminder(gid: Self.gid("archiv"), mailbox: f.mailboxId(named: "archiv2024"), read: false),
            DueReminder(gid: Self.gid("eingang"), mailbox: f.mailboxId(named: "inbox"), read: true),
            DueReminder(gid: Self.gid("junk"), mailbox: f.mailboxId(named: "junk"), read: true),
            DueReminder(gid: Self.gid("lokal"), mailbox: f.mailboxId(named: "lokal"), read: true),
        ]
        #expect(due == expected)
    }

    @Test func invalidReminderMailboxesAreRejected() throws {
        let f = try Self.build()
        let s = MailStore(config: f.config)
        let inbox = f.mailboxId(named: "inbox")
        for req in [
            SearchRequest(allowedMailboxIds: f.allMailboxIds, reminderMailboxIds: [inbox], limit: 5),
            SearchRequest(allowedMailboxIds: [inbox], mailboxIds: [inbox], reminderMailboxIds: [f.mailboxId(named: "archiv2024")], limit: 5),
            SearchRequest(allowedMailboxIds: f.allMailboxIds, mailboxIds: [inbox], reminderMailboxIds: [], limit: 5),
        ] {
            do {
                _ = try s.search(req)
                Issue.record("expected INVALID_INPUT")
            } catch {
                #expect(error.code == .invalidInput)
            }
        }
    }

    @Test func missingColumnMeansNoReminders() throws {
        let f = try Self.build(dropColumn: true)
        let s = MailStore(config: f.config)
        #expect(try Self.inInbox(s, f, reminders: Self.accountA(f)) == [Self.gid("eingang")])
        let rows = try s.search(.init(allowedMailboxIds: f.allMailboxIds, subject: "erinnerungstest", limit: 50)).messages
        #expect(rows.allSatisfy { $0.reminder == nil })
        #expect(try s.listMailboxes().dueReminders.isEmpty)
    }
}
