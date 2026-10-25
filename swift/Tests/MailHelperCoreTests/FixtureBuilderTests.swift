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

    // Harte Literale relativ zu mailRoot, ohne Helfer. Prueft Oracle und tatsaechlich geschriebene Dateien.
    @Test func literalRelativePaths() throws {
        let f = try FixtureBuilder.build()
        let a = "A0000000-0000-4000-8000-00000000000A"
        let l = "10CA1000-0000-4000-8000-00000000000C"
        let cases: [(Int64, String)] = [
            (4711, "V10/\(a)/INBOX.mbox/5D0E0001-0000-4000-8000-000000000001/Data/4/Messages/4711.emlx"),
            (123456, "V10/\(a)/Archiv.mbox/2024.mbox/5D0E0002-0000-4000-8000-000000000001/Data/3/2/1/Messages/123456.partial.emlx"),
            // Erwartung in NFC (U+00C4), wie percent-dekodierte URL.
            (29, "V10/\(a)/Spezial\u{00C4}rger.mbox/5D0E0007-0000-4000-8000-000000000002/Data/Messages/29.emlx"),
            (7, "V10/\(a)/INBOX.mbox/5D0E0001-0000-4000-8000-000000000001/Data/Messages/7.emlx"),
            (33, "V10/\(l)/Lokal.mbox/5D0E0008-0000-4000-8000-000000000001/Data/Messages/33.emlx"),
        ]
        for (rowid, rel) in cases {
            let oracle = f.expectedEmlxPath(rowid: rowid)
            #expect(oracle.path == f.mailRoot.path + "/" + rel, "oracle rowid \(rowid)")
            #expect(FileManager.default.fileExists(atPath: f.mailRoot.path + "/" + rel), "file rowid \(rowid)")
        }
        // Rohbytes des Verzeichniseintrags (readdir): Foundation legt Namen zerlegt (NFD: A + U+0308) an; die
        // NFC-Schreibweise oben loest trotzdem auf, weil APFS normalisierungsunempfindlich vergleicht.
        let dir = try #require(opendir(f.mailRoot.path + "/V10/\(a)"))
        defer { closedir(dir) }
        var names: [[UInt8]] = []
        while let e = readdir(dir) {
            let bytes = withUnsafeBytes(of: e.pointee.d_name) { Array($0.prefix { $0 != 0 }) }
            names.append(bytes)
        }
        let nfc: [UInt8] = Array("Spezial".utf8) + [0x41, 0xCC, 0x88] + Array("rger.mbox".utf8)
        #expect(names.contains(nfc))
    }

    @Test func noSenderEncodings() throws {
        let f = try FixtureBuilder.build()
        func sender(_ name: String) throws -> (isNull: Bool, value: Int64, rows: Int64) {
            let rowid = try #require(f.seed.messages.first { $0.name == name }).rowid
            let isNull = try f.count("SELECT sender IS NULL FROM messages WHERE ROWID = \(rowid)") == 1
            let v = try f.count("SELECT coalesce(sender, -1) FROM messages WHERE ROWID = \(rowid)")
            let rows = try f.count("SELECT count(*) FROM addresses WHERE ROWID = \(v)")
            return (isNull, v, rows)
        }
        let zero = try sender("noHeader")
        #expect(!zero.isNull && zero.value == 0 && zero.rows == 0)
        let null = try sender("lokal")
        #expect(null.isNull)
        let dangling = try sender("senderDangling")
        #expect(!dangling.isNull && dangling.value > 0 && dangling.rows == 0)
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
