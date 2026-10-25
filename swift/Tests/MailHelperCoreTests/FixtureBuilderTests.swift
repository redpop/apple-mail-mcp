import Foundation
import Testing
@testable import MailHelperCore

@Suite struct FixtureBuilderTests {
    @Test func builderCreatesDatabaseAndFiles() throws {
        let f = try FixtureBuilder.build()
        #expect(FileManager.default.fileExists(atPath: f.mailRoot.appending(path: "V10/MailData/Envelope Index").path))
        #expect(try f.count("SELECT count(*) FROM messages") == Int64(f.seed.messages.count))
        #expect(FileManager.default.fileExists(atPath: f.expectedEmlxPath(rowid: 4711).path))
    }

    @Test func digitRule() throws {
        let f = try FixtureBuilder.build()
        let root = f.mailRoot.path
        func tail(_ rowid: Int64) -> String {
            let p = f.expectedEmlxPath(rowid: rowid).path
            let parts = p.dropFirst(root.count).split(separator: "/")
            return parts.suffix(from: parts.firstIndex(of: "Data")!).joined(separator: "/")
        }
        #expect(tail(7) == "Data/Messages/7.emlx")
        #expect(tail(4711) == "Data/4/Messages/4711.emlx")
        #expect(tail(123456) == "Data/3/2/1/Messages/123456.partial.emlx")
    }

    @Test func fileKindsMatchSeed() throws {
        let f = try FixtureBuilder.build()
        let fm = FileManager.default
        for m in f.seed.messages {
            let p = f.expectedEmlxPath(rowid: m.rowid).path
            #expect(fm.fileExists(atPath: p) == (m.file != "none"), "rowid \(m.rowid)")
        }
    }

    @Test func emlxFraming() throws {
        let f = try FixtureBuilder.build()
        let data = try Data(contentsOf: f.expectedEmlxPath(rowid: 7))
        let nl = try #require(data.firstIndex(of: 0x0A))
        let len = try #require(Int(String(decoding: data[..<nl], as: UTF8.self)))
        let rest = data[(nl + 1)...]
        #expect(String(decoding: rest.prefix(len), as: UTF8.self).contains("Subject: Willkommen"))
        #expect(String(decoding: rest.dropFirst(len), as: UTF8.self).hasPrefix("<?xml"))
    }

    @Test func dedupAndSchemaFacts() throws {
        let f = try FixtureBuilder.build()
        #expect(try f.count("SELECT count(*) FROM messages WHERE global_message_id = \(f.gid(named: "dup3"))") == 3)
        #expect(try f.count("SELECT count(DISTINCT mailbox) FROM messages WHERE global_message_id = \(f.gid(named: "dup3"))") == 3)
        #expect(try f.count("SELECT count(*) FROM recipients WHERE type = 2") == 1)
        #expect(try f.count("SELECT count(*) FROM messages WHERE deleted = 1") == 1)
        #expect(try f.count("SELECT count(*) FROM message_global_data WHERE message_id_header IS NULL") == 2)
        #expect(f.visibleGids.contains(f.gid(named: "dup3")))
        #expect(!f.visibleGids.contains(f.gid(named: "deleted")))
        #expect(f.urlOfMessage(rowid: 4711).hasPrefix("imap://\(f.accountUUID("A"))/"))
    }

    @Test func accountsDatabaseOmitsAccountBAndLocal() throws {
        let f = try FixtureBuilder.build()
        let db = try SQLiteHandle(path: f.accountsDB.path, readOnly: true)
        #expect(try db.scalarInt("SELECT count(*) FROM ZACCOUNT WHERE ZIDENTIFIER = '\(f.accountUUID("A"))'") == 1)
        #expect(try db.scalarInt("SELECT count(*) FROM ZACCOUNT WHERE ZIDENTIFIER IN ('\(f.accountUUID("B"))', '\(f.accountUUID("L"))')") == 0)
    }

    @Test func extraMessagesAreBulkInserted() throws {
        let f = try FixtureBuilder.build(extraMessages: 250)
        #expect(try f.count("SELECT count(*) FROM messages") == Int64(f.seed.messages.count + 250))
    }

    @Test func configExposesPaths() throws {
        let f = try FixtureBuilder.build()
        #expect(f.config.mailRoot == f.mailRoot)
        #expect(f.config.accountsDB == f.accountsDB)
    }
}
