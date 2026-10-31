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
        // C ist in Accounts4, hat aber nur ein Nicht-Mail-Schema: darf nie erscheinen.
        let h = try SQLiteHandle(path: f.envelopeIndex.path)
        try h.run("INSERT INTO mailboxes (ROWID, url, total_count, unread_count) VALUES (?, ?, ?, ?)",
                  [.int(900), .text("caldav://\(f.accountUUID("C"))/x"), .int(0), .int(0)])
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
        #expect(MailStore(config: f.config).probe().accountNames == AccountNamesState(status: .unavailable, unmatchedAccounts: 0, reason: "Accounts database not found"))
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

    @Test func rebuiltEnvelopeIndexAtSamePathIsReread() throws {
        let f = try FixtureBuilder.build()
        let store = MailStore(config: f.config)
        #expect(try store.listMailboxes().mailboxes.count == f.seed.mailboxes.count)
        let f2 = try FixtureBuilder.build()
        let h = try SQLiteHandle(path: f2.envelopeIndex.path)
        try h.run("INSERT INTO mailboxes (ROWID, url, total_count, unread_count) VALUES (?, ?, ?, ?)",
                  [.int(901), .text("imap://\(f.accountUUID("A"))/Neu"), .int(7), .int(5)])
        try FileManager.default.removeItem(at: f.envelopeIndex)
        try FileManager.default.copyItem(at: f2.envelopeIndex, to: f.envelopeIndex)
        let r = try store.listMailboxes()
        #expect(r.mailboxes.count == f.seed.mailboxes.count + 1)
        #expect(r.mailboxes.last?.total == 7)
    }

    @Test func unavailableAccountNamesAreNotCached() throws {
        let f = try FixtureBuilder.build()
        let saved = f.accountsDB.deletingLastPathComponent().appending(path: "saved.sqlite")
        try FileManager.default.moveItem(at: f.accountsDB, to: saved)
        let store = MailStore(config: f.config)
        #expect(try store.listMailboxes().accountNames == .unavailable)
        try FileManager.default.moveItem(at: saved, to: f.accountsDB)
        let r = try store.listMailboxes()
        #expect(r.accountNames == .available)
        #expect(r.accounts.count == 1)
    }

    @Test func accountNamesRecomputedWhenAccountSetChanges() throws {
        let f = try FixtureBuilder.build()
        let store = MailStore(config: f.config)
        #expect(try store.listMailboxes().accounts.count == 1)
        let newUUID = "D0000000-0000-4000-8000-00000000000E"
        let acc = try SQLiteHandle(path: f.accountsDB.path)
        try acc.run("INSERT INTO ZACCOUNT (Z_PK, ZIDENTIFIER, ZACCOUNTDESCRIPTION, ZUSERNAME, ZOWNINGBUNDLEID) VALUES (?, ?, ?, ?, ?)",
                    [.int(99), .text(newUUID), .text("Neu"), .text("neu@example.org"), .text("com.apple.mail")])
        let env = try SQLiteHandle(path: f.envelopeIndex.path)
        try env.run("INSERT INTO mailboxes (ROWID, url, total_count, unread_count) VALUES (?, ?, ?, ?)",
                    [.int(902), .text("imap://\(newUUID)/INBOX"), .int(0), .int(0)])
        let r = try store.listMailboxes()
        #expect(Set(r.accounts.map(\.uuid)) == [f.accountUUID("A"), newUUID])
    }
    // Kindkonten (IMAP unter Google/iCloud) haben oft keine eigene Beschreibung; Mail zeigt die des Elternkontos.
    @Test func childAccountWithoutDescriptionUsesParentDescription() throws {
        let f = try FixtureBuilder.build()
        let child = "D0000000-0000-4000-8000-00000000000E"
        let acc = try SQLiteHandle(path: f.accountsDB.path)
        try acc.run("INSERT INTO ZACCOUNT (Z_PK, ZIDENTIFIER, ZACCOUNTDESCRIPTION, ZUSERNAME, ZOWNINGBUNDLEID) VALUES (?, ?, ?, ?, ?)",
                    [.int(50), .text("E0000000-0000-4000-8000-00000000000F"), .text("Google"), .text("eltern@example.org"), .null])
        try acc.run("INSERT INTO ZACCOUNT (Z_PK, ZIDENTIFIER, ZACCOUNTDESCRIPTION, ZUSERNAME, ZOWNINGBUNDLEID, ZPARENTACCOUNT) VALUES (?, ?, ?, ?, ?, ?)",
                    [.int(51), .text(child), .null, .null, .text("com.apple.mail"), .int(50)])
        let env = try SQLiteHandle(path: f.envelopeIndex.path)
        try env.run("INSERT INTO mailboxes (ROWID, url, total_count, unread_count) VALUES (?, ?, ?, ?)",
                    [.int(903), .text("imap://\(child)/INBOX"), .int(0), .int(0)])
        let r = try MailStore(config: f.config).listMailboxes()
        // Das Elternkonto selbst hat keine Mailbox und erscheint nicht; sein ZUSERNAME wird nicht gelesen.
        #expect(Set(r.accounts.map(\.uuid)) == [f.accountUUID("A"), child])
        let c = try #require(r.accounts.first { $0.uuid == child })
        #expect(c.description == "Google")
        #expect(c.username == nil)
    }

    @Test func ownDescriptionWinsAndEmptyCountsAsMissing() throws {
        let f = try FixtureBuilder.build()
        let own = "D0000000-0000-4000-8000-000000000010"
        let empty = "D0000000-0000-4000-8000-000000000011"
        let acc = try SQLiteHandle(path: f.accountsDB.path)
        try acc.run("INSERT INTO ZACCOUNT (Z_PK, ZIDENTIFIER, ZACCOUNTDESCRIPTION, ZUSERNAME) VALUES (?, ?, ?, ?)",
                    [.int(60), .text("E0000000-0000-4000-8000-000000000012"), .text("iCloud"), .null])
        try acc.run("INSERT INTO ZACCOUNT (Z_PK, ZIDENTIFIER, ZACCOUNTDESCRIPTION, ZUSERNAME, ZPARENTACCOUNT) VALUES (?, ?, ?, ?, ?)",
                    [.int(61), .text(own), .text("Eigene"), .null, .int(60)])
        try acc.run("INSERT INTO ZACCOUNT (Z_PK, ZIDENTIFIER, ZACCOUNTDESCRIPTION, ZUSERNAME) VALUES (?, ?, ?, ?)",
                    [.int(62), .text(empty), .text(""), .null])
        let env = try SQLiteHandle(path: f.envelopeIndex.path)
        for (rowid, uuid) in [(904, own), (905, empty)] {
            try env.run("INSERT INTO mailboxes (ROWID, url, total_count, unread_count) VALUES (?, ?, ?, ?)",
                        [.int(Int64(rowid)), .text("imap://\(uuid)/INBOX"), .int(0), .int(0)])
        }
        let r = try MailStore(config: f.config).listMailboxes()
        #expect(r.accounts.first { $0.uuid == own }?.description == "Eigene")
        let e = try #require(r.accounts.first { $0.uuid == empty })
        #expect(e.description == nil)
    }

    @Test func accountsDbWithoutParentColumnStillNamesAccounts() throws {
        let f = try FixtureBuilder.build()
        let h = try SQLiteHandle(path: f.accountsDB.path)
        try h.exec("ALTER TABLE ZACCOUNT DROP COLUMN ZPARENTACCOUNT")
        let r = try MailStore(config: f.config).listMailboxes()
        #expect(r.accountNames == .available)
        #expect(r.accounts.map(\.description) == ["Privat"])
    }
}
