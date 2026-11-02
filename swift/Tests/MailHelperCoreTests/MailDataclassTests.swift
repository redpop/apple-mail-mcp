import Foundation
import Testing
@testable import MailHelperCore

// AMM-22: Mail fuer ein Konto abgeschaltet (z. B. iCloud-Mail "Diesen Mac synchronisieren" aus).
@Suite struct MailDataclassTests {
    private func mailEnabled(_ f: Fixture, _ name: String) throws -> Bool? {
        let r = try MailStore(config: f.config).listMailboxes()
        return try #require(r.accounts.first { $0.uuid == f.accountUUID(name) }).mailEnabled
    }

    @Test func ownAndInheritedMailDataclass() throws {
        let f = try FixtureBuilder.build()
        // A hat Mail aktiviert; D hat keine eigenen Dataclasses, sein Elternkonto P hat Mail nur provisioniert.
        #expect(try mailEnabled(f, "A") == true)
        #expect(try mailEnabled(f, "D") == false)
    }

    @Test func ownEnabledDataclassesWinOverParent() throws {
        let f = try FixtureBuilder.build()
        let h = try SQLiteHandle(path: f.accountsDB.path)
        let mail = try #require(try h.texts("SELECT Z_PK FROM ZDATACLASS WHERE ZENUMVALUE = 0").first)
        let d = try #require(try h.texts("SELECT Z_PK FROM ZACCOUNT WHERE ZIDENTIFIER = '\(f.accountUUID("D"))'").first)
        try h.exec("INSERT INTO Z_2ENABLEDDATACLASSES VALUES (\(d), \(mail))")
        #expect(try mailEnabled(f, "D") == true)
    }

    @Test func parentWithMailEnabledKeepsChildVisible() throws {
        let f = try FixtureBuilder.build()
        let h = try SQLiteHandle(path: f.accountsDB.path)
        try h.exec("""
            INSERT INTO Z_2ENABLEDDATACLASSES SELECT p.Z_PK, d.Z_PK FROM ZACCOUNT p, ZDATACLASS d
            WHERE p.ZIDENTIFIER = '\(f.accountUUID("P"))' AND d.ZENUMVALUE = 0
            """)
        #expect(try mailEnabled(f, "D") == true)
    }

    @Test func noEnabledDataclassesAnywhereIsUndetermined() throws {
        let f = try FixtureBuilder.build()
        let h = try SQLiteHandle(path: f.accountsDB.path)
        try h.exec("DELETE FROM Z_2ENABLEDDATACLASSES")
        #expect(try mailEnabled(f, "A") == nil)
        #expect(try mailEnabled(f, "D") == nil)
    }

    @Test func undecodableNameLeavesItUndetermined() throws {
        let f = try FixtureBuilder.build()
        let h = try SQLiteHandle(path: f.accountsDB.path)
        // Die Notes-Zeile von P ist kaputt: Es koennte die Mail-Zeile sein, also nicht ausblenden.
        try h.run("UPDATE ZDATACLASS SET ZNAME = ? WHERE ZENUMVALUE <> 0", [.blob(Data("bplist00garbage".utf8))])
        #expect(try mailEnabled(f, "D") == nil)
        #expect(try mailEnabled(f, "A") == true)
    }

    @Test func linkToMissingDataclassRowLeavesItUndetermined() throws {
        let f = try FixtureBuilder.build()
        let h = try SQLiteHandle(path: f.accountsDB.path)
        try h.exec("DELETE FROM ZDATACLASS WHERE ZENUMVALUE <> 0")
        #expect(try mailEnabled(f, "D") == nil)
    }

    @Test func plainTextNameIsAccepted() throws {
        let f = try FixtureBuilder.build()
        let h = try SQLiteHandle(path: f.accountsDB.path)
        try h.exec("UPDATE ZDATACLASS SET ZNAME = 'com.apple.Dataclass.Mail' WHERE ZENUMVALUE = 0")
        try h.exec("UPDATE ZDATACLASS SET ZNAME = 'com.apple.Dataclass.Notes' WHERE ZENUMVALUE <> 0")
        #expect(try mailEnabled(f, "A") == true)
        #expect(try mailEnabled(f, "D") == false)
    }

    @Test(arguments: [
        "DROP TABLE Z_2ENABLEDDATACLASSES",
        "DROP TABLE ZDATACLASS",
        "DROP TABLE Z_PRIMARYKEY",
        "UPDATE Z_PRIMARYKEY SET Z_NAME = 'NamedObject' WHERE Z_ENT = 7",
        "UPDATE Z_PRIMARYKEY SET Z_NAME = 'Other' WHERE Z_ENT = 2",
        "CREATE TABLE Z_9ENABLEDDATACLASSES (Z_9ENABLEDACCOUNTS INTEGER, Z_7ENABLEDDATACLASSES INTEGER)",
        "ALTER TABLE Z_2ENABLEDDATACLASSES RENAME COLUMN Z_2ENABLEDACCOUNTS TO Z_3ENABLEDACCOUNTS",
        "ALTER TABLE ZDATACLASS RENAME COLUMN ZNAME TO ZIDENT",
    ])
    func unexpectedSchemaHidesNothingAndKeepsNames(_ change: String) throws {
        let f = try FixtureBuilder.build()
        let h = try SQLiteHandle(path: f.accountsDB.path)
        try h.exec(change)
        let r = try MailStore(config: f.config).listMailboxes()
        #expect(r.accountNames == .available)
        #expect(r.accounts.first { $0.uuid == f.accountUUID("A") }?.description == "Privat")
        #expect(r.accounts.allSatisfy { $0.mailEnabled == nil })
    }

    @Test func decodesOnlyAnArchivedString() throws {
        #expect(MailDataclass.decodeArchivedString(try FixtureBuilder.archivedDataclass("Mail")) == "com.apple.Dataclass.Mail")
        #expect(MailDataclass.decodeArchivedString(Data("bplist00garbage".utf8)) == nil)
        #expect(MailDataclass.decodeArchivedString(Data("com.apple.Dataclass.Mail".utf8)) == nil)
        let array = try NSKeyedArchiver.archivedData(withRootObject: ["com.apple.Dataclass.Mail"] as NSArray, requiringSecureCoding: true)
        #expect(MailDataclass.decodeArchivedString(array) == nil)
        let plain = try PropertyListSerialization.data(fromPropertyList: ["$objects": ["$null", "com.apple.Dataclass.Mail"]],
                                                       format: .binary, options: 0)
        #expect(MailDataclass.decodeArchivedString(plain) == nil)
    }

    @Test func acceptsOnlyDataclassIdentifiers() {
        #expect(MailDataclass.isIdentifier("com.apple.Dataclass.Mail"))
        #expect(!MailDataclass.isIdentifier("com.apple.Dataclass."))
        #expect(!MailDataclass.isIdentifier("com.apple.Dataclass.Mail user@example.com"))
        #expect(!MailDataclass.isIdentifier("x-custom.Mail"))
        #expect(MailDataclass.entity("Z_2ENABLEDDATACLASSES", suffix: "ENABLEDDATACLASSES") == "2")
        #expect(MailDataclass.entity("Z_2PROVISIONEDDATACLASSES", suffix: "ENABLEDDATACLASSES") == nil)
        #expect(MailDataclass.entity("Z_ENABLEDDATACLASSES", suffix: "ENABLEDDATACLASSES") == nil)
        #expect(MailDataclass.entity("Z_2;ENABLEDDATACLASSES", suffix: "ENABLEDDATACLASSES") == nil)
    }

    @Test func undeterminedIsOmittedInJson() throws {
        let f = try FixtureBuilder.build()
        let h = try SQLiteHandle(path: f.accountsDB.path)
        try h.exec("DROP TABLE Z_2ENABLEDDATACLASSES")
        let data = try JSONEncoder().encode(try MailStore(config: f.config).listMailboxes())
        let json = try #require(try JSONSerialization.jsonObject(with: data) as? [String: Any])
        let accounts = try #require(json["accounts"] as? [[String: Any]])
        #expect(accounts.allSatisfy { $0["mailEnabled"] == nil })
    }
}
