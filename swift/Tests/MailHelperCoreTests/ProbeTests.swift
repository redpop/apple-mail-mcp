import Foundation
import Testing
@testable import MailHelperCore

@Suite struct ProbeTests {
    @Test func probeOnFixtureIsGranted() throws {
        let f = try FixtureBuilder.build()
        let p = MailStore(config: f.config).probe()
        #expect(p.access == .granted)
        #expect(p.mailDir == "V10")
        #expect(p.schema?.compatible == true)
        #expect(p.schema?.missing == [])
        #expect(p.counts?.uniqueMessages == Int64(Set(f.seed.messages.map(\.gid)).count))
        #expect(p.counts?.messages == Int64(f.seed.messages.count))
        #expect(p.counts?.mailboxes == Int64(f.seed.mailboxes.count))
        #expect(p.accountNames == AccountNamesState(status: .available, unmatchedAccounts: 2))
    }

    @Test func probeWithoutMailDirIsNoMailData() throws {
        let tmp = FileManager.default.temporaryDirectory.appending(path: "empty-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: tmp, withIntermediateDirectories: true)
        let p = MailStore(config: MailStoreConfig(mailRoot: tmp, accountsDB: tmp.appending(path: "a.sqlite"))).probe()
        #expect(p.access == .noMailData)
        #expect(p.mailDir == nil)
        #expect(p.schema == nil)
        #expect(p.counts == nil)
    }

    @Test func probeWithMissingRootIsNoMailData() {
        let tmp = FileManager.default.temporaryDirectory.appending(path: "gone-\(UUID().uuidString)")
        let p = MailStore(config: MailStoreConfig(mailRoot: tmp, accountsDB: tmp.appending(path: "a.sqlite"))).probe()
        #expect(p.access == .noMailData)
    }

    @Test func probeOnUnreadableDirIsDenied() throws {
        let f = try FixtureBuilder.build()
        let path = f.mailRoot.path
        try FileManager.default.setAttributes([.posixPermissions: 0o000], ofItemAtPath: path)
        defer { try? FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: path) }
        // Als root greift chmod nicht; dann ist der Test nicht aussagekraeftig.
        try #require(geteuid() != 0)
        let p = MailStore(config: f.config).probe()
        #expect(p.access == .denied)
        #expect(p.schema == nil)
        #expect(p.counts == nil)
    }

    @Test func missingColumnIsReported() throws {
        let f = try FixtureBuilder.build(dropping: ("messages", "conversation_id"))
        let p = MailStore(config: f.config).probe()
        #expect(p.access == .granted)
        #expect(p.schema?.compatible == false)
        #expect(p.schema?.missing == ["messages.conversation_id"])
        #expect(p.counts == nil)
    }

    @Test func fingerprintIsStable() throws {
        let a = MailStore(config: try FixtureBuilder.build().config).probe()
        let b = MailStore(config: try FixtureBuilder.build().config).probe()
        let fp = try #require(a.schema?.fingerprint)
        #expect(fp.hasPrefix("sha256:"))
        #expect(fp.count == "sha256:".count + 64)
        #expect(fp == b.schema?.fingerprint)
        let dropped = MailStore(config: try FixtureBuilder.build(dropping: ("messages", "size")).config).probe()
        #expect(dropped.schema?.fingerprint != fp)
    }

    @Test func damagedDatabaseStaysGrantedWithoutSchema() throws {
        let f = try FixtureBuilder.build()
        try Data(repeating: 0x41, count: 4096).write(to: f.envelopeIndex)
        let p = MailStore(config: f.config).probe()
        #expect(p.access == .granted)
        #expect(p.mailDir == "V10")
        #expect(p.schema == nil)
        #expect(p.counts == nil)
    }

    @Test func fingerprintIgnoresSqliteInternalTables() throws {
        let a = try #require(MailStore(config: try FixtureBuilder.build().config).probe().schema?.fingerprint)
        let f = try FixtureBuilder.build()
        let h = try SQLiteHandle(path: f.envelopeIndex.path)
        try h.exec("ANALYZE")
        #expect(MailStore(config: f.config).probe().schema?.fingerprint == a)
    }

    @Test func sqliteFailureAfterReadableFileIsNotFullDiskAccess() throws {
        let f = try FixtureBuilder.build()
        try Data(repeating: 0x41, count: 4096).write(to: f.envelopeIndex)
        let db = try Database(readOnlyAt: f.envelopeIndex)
        do {
            try db.query("SELECT 1 FROM sqlite_master") { _ in }
            Issue.record("expected failure")
        } catch {
            #expect(error.code == .databaseError)
        }
    }

    @Test func probeJSONMatchesNodeSchema() throws {
        let f = try FixtureBuilder.build()
        let data = try JSONEncoder().encode(MailStore(config: f.config).probe())
        let o = try #require(JSONSerialization.jsonObject(with: data) as? [String: Any])
        #expect(Set(o.keys) == ["osVersion", "mailDir", "access", "schema", "counts", "accountNames"])
        #expect(o["access"] as? String == "granted")
        let names = try #require(o["accountNames"] as? [String: Any])
        #expect(names["status"] as? String == "available")
        #expect(names["unmatchedAccounts"] as? Int == 2)
        let no = try JSONSerialization.jsonObject(with: JSONEncoder().encode(
            MailStore(config: MailStoreConfig(mailRoot: f.mailRoot.appending(path: "nope"), accountsDB: f.accountsDB)).probe())) as! [String: Any]
        #expect(no["mailDir"] is NSNull)
        #expect(no["schema"] == nil)
    }

    @Test func mcpFoldRunsInSQLAndKeepsNull() throws {
        let f = try FixtureBuilder.build()
        let db = try Database(readOnlyAt: f.envelopeIndex)
        var out: [String?] = []
        try db.query("SELECT mcp_fold(?), mcp_fold(NULL)", [.text("STRAßE Ärger")]) { row in
            out = [row.text(0), row.text(1)]
        }
        #expect(out[0] == "strasse ärger")
        #expect(out[1] == nil)
    }
}
