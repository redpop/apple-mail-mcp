import Foundation
import Testing
@testable import MailHelperCore

@Suite struct MailboxesTests {
    @Test func listsAllMailboxesWithCounts() throws {
        let f = try FixtureBuilder.build()
        let r = try MailStore(config: f.config).listMailboxes()
        #expect(r.mailboxes.count == f.seed.mailboxes.count)
        #expect(r.mailboxes.map(\.id) == f.seed.mailboxes.map(\.id).sorted())
        let inbox = try #require(r.mailboxes.first { $0.id == f.mailboxId(named: "inbox") })
        let seedInbox = try #require(f.seed.mailboxes.first { $0.name == "inbox" })
        #expect(inbox.url == seedInbox.url)
        #expect(inbox.total == seedInbox.total)
        #expect(inbox.unread == seedInbox.unread)
        #expect(inbox.total == 3 && inbox.unread == 2)
    }

    @Test func accountNamesOnlyForMailAccounts() throws {
        let f = try FixtureBuilder.build()
        let r = try MailStore(config: f.config).listMailboxes()
        #expect(r.accountNames == .available)
        #expect(r.accountNamesReason == nil)
        #expect(Set(r.accounts.map(\.uuid)) == [f.accountUUID("A")])   // B/L fehlen in Accounts4, C ist kein Mail-Konto
        #expect(r.accounts.first?.description == "Privat")
        #expect(r.accounts.first?.username == "anna@example.com")
    }

    @Test func missingAccountsDbIsUnavailableNotError() throws {
        let f = try FixtureBuilder.build()
        try FileManager.default.removeItem(at: f.accountsDB)
        let r = try MailStore(config: f.config).listMailboxes()
        #expect(r.accounts.isEmpty)
        #expect(r.accountNames == .unavailable)
        #expect(r.accountNamesReason == "Accounts database not found")
        #expect(r.mailboxes.count == f.seed.mailboxes.count)
        #expect(MailStore(config: f.config).probe().accountNames == AccountNamesState(status: .unavailable, unmatchedAccounts: 0))
    }

    @Test func unreadableAccountsDbIsUnavailable() throws {
        let f = try FixtureBuilder.build()
        try #require(geteuid() != 0)
        try FileManager.default.setAttributes([.posixPermissions: 0o000], ofItemAtPath: f.accountsDB.path)
        defer { try? FileManager.default.setAttributes([.posixPermissions: 0o644], ofItemAtPath: f.accountsDB.path) }
        let r = try MailStore(config: f.config).listMailboxes()
        #expect(r.accountNames == .unavailable)
        #expect(r.accountNamesReason == "Accounts database not readable")
        #expect(r.mailboxes.count == f.seed.mailboxes.count)
    }

    @Test func missingAccountsColumnIsUnavailable() throws {
        let f = try FixtureBuilder.build()
        let h = try SQLiteHandle(path: f.accountsDB.path)
        try h.exec("ALTER TABLE ZACCOUNT DROP COLUMN ZUSERNAME")
        let r = try MailStore(config: f.config).listMailboxes()
        #expect(r.accountNames == .unavailable)
        #expect(r.accountNamesReason == "Accounts database has an unexpected schema")
        #expect(r.accounts.isEmpty)
        #expect(r.mailboxes.count == f.seed.mailboxes.count)
    }

    @Test func probeCountsUnmatchedMailAccounts() throws {
        let f = try FixtureBuilder.build()
        let p = MailStore(config: f.config).probe()
        // Mail-Konten im Index: A, B, L; nur A steht in Accounts4.
        #expect(p.accountNames == AccountNamesState(status: .available, unmatchedAccounts: 2))
    }

    @Test func accountNamesAreCachedForHelperLifetime() throws {
        let f = try FixtureBuilder.build()
        let store = MailStore(config: f.config)
        _ = try store.listMailboxes()
        try FileManager.default.removeItem(at: f.accountsDB)
        let r = try store.listMailboxes()
        #expect(r.accountNames == .available)
        #expect(r.accounts.count == 1)
    }

    @Test func accountUUIDParsing() {
        #expect(MailStore.accountUUID(fromMailboxURL: "imap://U1/INBOX") == "U1")
        #expect(MailStore.accountUUID(fromMailboxURL: "EWS://U2/x") == "U2")
        #expect(MailStore.accountUUID(fromMailboxURL: "local://U3/Lokal") == "U3")
        #expect(MailStore.accountUUID(fromMailboxURL: "file://U4/x") == nil)
        #expect(MailStore.accountUUID(fromMailboxURL: "garbage") == nil)
    }

    @Test func jsonMatchesNodeSchema() throws {
        let f = try FixtureBuilder.build()
        let ok = try JSONSerialization.jsonObject(with: JSONEncoder().encode(MailStore(config: f.config).listMailboxes())) as! [String: Any]
        #expect(Set(ok.keys) == ["mailboxes", "accounts", "accountNames"])
        let mb = try #require((ok["mailboxes"] as? [[String: Any]])?.first)
        #expect(Set(mb.keys) == ["id", "url", "total", "unread"])
        try FileManager.default.removeItem(at: f.accountsDB)
        let bad = try JSONSerialization.jsonObject(with: JSONEncoder().encode(MailStore(config: f.config).listMailboxes())) as! [String: Any]
        #expect(bad["accountNamesReason"] as? String == "Accounts database not found")
    }
}
