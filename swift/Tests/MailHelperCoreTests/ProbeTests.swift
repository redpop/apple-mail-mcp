import CryptoKit
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

    /// Lese-Kommandos ueber den Dispatcher, damit Code und Meldung so geprueft werden, wie Node sie sieht.
    private func failure(_ store: MailStore, _ command: String, _ payload: String) throws -> (code: String?, message: String?) {
        let out = Dispatcher(store: store, signing: .trusted).handle(line: Data(#"{"id":1,"command":"\#(command)","payload":\#(payload)}"#.utf8))
        let o = try #require(try JSONSerialization.jsonObject(with: out) as? [String: Any])
        let e = o["error"] as? [String: Any]
        return (e?["code"] as? String, e?["message"] as? String)
    }

    @Test func readCommandsRefuseIncompatibleSchema() throws {
        for column in ["conversation_id", "size"] {
            let f = try FixtureBuilder.build(dropping: ("messages", column))
            let store = MailStore(config: f.config)
            let allowed = f.allMailboxIds.map(String.init).joined(separator: ",")
            let gid = f.gid(named: "thread1")
            let commands: [(String, String)] = [
                ("list-mailboxes", "{}"),
                ("search", #"{"allowedMailboxIds":[\#(allowed)],"limit":5,"maxRecipients":0,"countTotal":false}"#),
                ("get-messages", #"{"allowedMailboxIds":[\#(allowed)],"gids":[\#(gid)],"maxBytesPerMessage":1024,"maxBytesTotal":1024}"#),
                ("thread", #"{"allowedMailboxIds":[\#(allowed)],"gid":\#(gid),"limit":5,"maxRecipients":0}"#),
            ]
            for (command, payload) in commands {
                let r = try failure(store, command, payload)
                #expect(r.code == "SCHEMA_UNSUPPORTED", "\(command) without messages.\(column)")
                #expect(r.message == "Missing columns: messages.\(column)", "\(command)")
            }
            // probe bleibt ein Zustand, kein Fehler.
            let p = store.probe()
            #expect(p.access == .granted)
            #expect(p.schema?.compatible == false)
            #expect(p.schema?.missing == ["messages.\(column)"])
        }
    }

    @Test func probeCarriesTheFingerprintDDL() throws {
        let f = try FixtureBuilder.build()
        let p = MailStore(config: f.config).probe()
        let ddl = try #require(p.schema?.ddl)
        #expect(!ddl.isEmpty)
        #expect(ddl.allSatisfy { $0.hasPrefix("CREATE TABLE") })
        #expect(ddl.contains { $0.contains("messages") && $0.contains("conversation_id") })
        // Nur Struktur: kein Wert aus dem Seed.
        let joined = ddl.joined(separator: "\n")
        for m in f.seed.messages { #expect(!joined.contains(m.subject) || m.subject.isEmpty) }
        // Der Fingerabdruck ist SHA-256 genau ueber diese Anweisungen.
        let digest = SHA256.hash(data: Data(ddl.joined(separator: "\n").utf8))
        #expect(p.schema?.fingerprint == "sha256:" + digest.map { String(format: "%02x", $0) }.joined())
    }

    @Test func accountNamesReasonIsSentOnlyWhenUnavailable() throws {
        let f = try FixtureBuilder.build()
        let ok = try JSONSerialization.jsonObject(with: JSONEncoder().encode(MailStore(config: f.config).probe())) as! [String: Any]
        #expect((ok["accountNames"] as? [String: Any])?.keys.contains("reason") == false)
        try FileManager.default.removeItem(at: f.accountsDB)
        let gone = MailStore(config: f.config).probe()
        #expect(gone.accountNames.status == .unavailable)
        #expect(gone.accountNames.reason == Accounts.notFound)
        let o = try JSONSerialization.jsonObject(with: JSONEncoder().encode(gone)) as! [String: Any]
        let names = try #require(o["accountNames"] as? [String: Any])
        #expect(names["reason"] as? String == "Accounts database not found")
        #expect(!(names["reason"] as! String).contains("/"))
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
