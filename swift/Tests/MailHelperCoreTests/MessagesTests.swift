import Foundation
import Testing
@testable import MailHelperCore

@Suite struct MessagesTests {
    let f: Fixture
    let store: MailStore
    var all: [Int64] { f.allMailboxIds }

    init() throws {
        f = try FixtureBuilder.build()
        store = MailStore(config: f.config)
    }

    private func overwrite(rowid: Int64, bytes: Int) throws {
        try Data(repeating: 0x41, count: bytes).write(to: f.expectedEmlxPath(rowid: rowid))
    }

    private func request(_ names: [String], allowed: [Int64]? = nil, per: Int = 1 << 23, total: Int = 1 << 24) -> GetMessagesRequest {
        .init(allowedMailboxIds: allowed ?? all, gids: names.map { f.gid(named: $0) }, maxBytesPerMessage: per, maxBytesTotal: total)
    }

    @Test func returnsWholeFileWithFrame() throws {
        let r = try store.getMessages(request(["small"]))
        let m = try #require(r.messages.first)
        let onDisk = try Data(contentsOf: f.expectedEmlxPath(rowid: 7))
        #expect(Data(base64Encoded: try #require(m.raw)) == onDisk)
        #expect(m.rawSize == Int64(onDisk.count))
        #expect(!m.rawTruncated)
        #expect(m.row.gid == f.gid(named: "small"))
        #expect(m.row.file == .full)
        #expect(r.missing.isEmpty && !r.budgetExhausted)
    }

    @Test func readsAtMostMaxBytes() throws {
        try overwrite(rowid: 7, bytes: 5000)
        let r = try store.getMessages(request(["small"], per: 1024))
        let m = try #require(r.messages.first)
        #expect(Data(base64Encoded: try #require(m.raw))!.count == 1024)
        #expect(m.rawTruncated)
        #expect(m.rawSize == 5000)
        // Genau passend ist nicht gekuerzt.
        let exact = try store.getMessages(request(["small"], per: 5000))
        #expect(!exact.messages[0].rawTruncated)
        #expect(Data(base64Encoded: try #require(exact.messages[0].raw))!.count == 5000)
    }

    @Test func totalIsClampedTo20MiB() throws {
        #expect(getMessagesTotalByteCap == 20 * 1024 * 1024)
        let fh = try FileHandle(forWritingTo: f.expectedEmlxPath(rowid: 7))
        try fh.truncate(atOffset: UInt64(25 * 1024 * 1024))
        try fh.close()
        let r = try store.getMessages(request(["small"], per: Int.max, total: Int.max))
        let m = try #require(r.messages.first)
        #expect(Data(base64Encoded: try #require(m.raw))!.count == getMessagesTotalByteCap)
        #expect(m.rawTruncated)
        #expect(m.rawSize == 25 * 1024 * 1024)

        // 50 gids (alle sichtbaren, aufgefuellt), die grosse Datei darunter: die Zeile bleibt unter 32 MiB.
        var gids = Array(f.visibleGids).sorted()
        var filler: Int64 = 900_000
        while gids.count < 50 { gids.append(filler); filler += 1 }
        let big = try store.getMessages(.init(allowedMailboxIds: all, gids: gids, maxBytesPerMessage: Int.max, maxBytesTotal: Int.max))
        let enc = JSONEncoder()
        enc.outputFormatting = [.withoutEscapingSlashes]
        let line = try enc.encode(big)
        #expect(line.count < 32 * 1024 * 1024)
        #expect(big.messages.count + big.missing.count == 50)
    }

    @Test func totalBudgetStopsFurtherReads() throws {
        for rowid: Int64 in [7, 20, 22] { try overwrite(rowid: rowid, bytes: 1000) }
        let r = try store.getMessages(request(["small", "noHeader", "tie1"], total: 2500))
        #expect(r.messages.map(\.row.gid) == [f.gid(named: "small"), f.gid(named: "noHeader"), f.gid(named: "tie1")])
        #expect(r.messages[0].raw != nil && r.messages[1].raw != nil)
        #expect(r.messages[2].raw == nil)
        #expect(r.messages[2].rawSize == 1000 && !r.messages[2].rawTruncated)   // echte Groesse, nichts gelesen
        #expect(r.budgetExhausted)
        // Passt alles genau, ist nichts erschoepft.
        let fits = try store.getMessages(request(["small", "noHeader", "tie1"], total: 3000))
        #expect(fits.messages.allSatisfy { $0.raw != nil } && !fits.budgetExhausted)
    }

    @Test func firstMessageAlwaysFitsTheTotal() throws {
        try overwrite(rowid: 7, bytes: 5000)
        let r = try store.getMessages(request(["small", "noHeader"], per: 5000, total: 100))
        #expect(Data(base64Encoded: try #require(r.messages[0].raw))!.count == 100)
        #expect(r.messages[0].rawTruncated)
        #expect(r.messages[1].raw == nil)
        #expect(r.messages[1].rawSize > 0)
        #expect(r.budgetExhausted)
    }

    @Test func fileNoneGivesNullRaw() throws {
        let r = try store.getMessages(request(["trash", "small"]))
        let trash = try #require(r.messages.first { $0.row.gid == f.gid(named: "trash") })
        #expect(trash.row.file == .none)
        #expect(trash.raw == nil && trash.rawSize == 0 && !trash.rawTruncated)
        #expect(r.messages.first { $0.row.gid == f.gid(named: "small") }?.raw != nil)
        #expect(!r.budgetExhausted)
    }

    @Test func notAllowedGidIsMissing() throws {
        let noJunk = all.filter { $0 != f.mailboxId(named: "junk") }
        var req = request(["thread3", "small", "deleted"], allowed: noJunk)
        req.gids.append(987654)
        let r = try store.getMessages(req)
        #expect(r.messages.map(\.row.gid) == [f.gid(named: "small")])
        #expect(r.missing == [f.gid(named: "thread3"), f.gid(named: "deleted"), 987654])
    }

    @Test func duplicateGidsAreReturnedOnce() throws {
        let r = try store.getMessages(request(["small", "small"]))
        #expect(r.messages.count == 1)
    }

    @Test func moreThan50GidsIsInvalidInput() throws {
        let gids = (1...51).map { Int64($0) }
        #expect(throws: HelperFailure.self) {
            try store.getMessages(.init(allowedMailboxIds: all, gids: gids, maxBytesPerMessage: 10, maxBytesTotal: 10))
        }
        let ok = try store.getMessages(.init(allowedMailboxIds: all, gids: Array(gids.prefix(50)), maxBytesPerMessage: 10, maxBytesTotal: 10))
        #expect(ok.missing.count == 50)
    }

    @Test func invalidInputs() throws {
        let g = [f.gid(named: "small")]
        let bad: [GetMessagesRequest] = [
            .init(allowedMailboxIds: [], gids: g, maxBytesPerMessage: 10, maxBytesTotal: 10),
            .init(allowedMailboxIds: all, gids: [], maxBytesPerMessage: 10, maxBytesTotal: 10),
            .init(allowedMailboxIds: all, gids: g, maxBytesPerMessage: 0, maxBytesTotal: 10),
            .init(allowedMailboxIds: all, gids: g, maxBytesPerMessage: 10, maxBytesTotal: 0),
        ]
        for r in bad {
            do {
                _ = try store.getMessages(r)
                Issue.record("keine Ablehnung fuer \(r)")
            } catch {
                #expect(error.code == .invalidInput)
                #expect(!error.message.contains("/"))
            }
        }
    }

    @Test func bestRowStateInSearchIsFull() throws {
        let r = try store.search(.init(allowedMailboxIds: all, limit: 50))
        let dup = try #require(r.messages.first { $0.gid == f.gid(named: "dup3") })
        #expect(dup.file == .full)
        // Ohne die volle Datei gewinnt die partielle (123456), obwohl 4712 (ohne Datei) eine hoehere ROWID als 4711 hat
        // und 123456 die hoechste ROWID ist: der Dateizustand geht vor der ROWID.
        try FileManager.default.removeItem(at: f.expectedEmlxPath(rowid: 4711))
        let r2 = try store.search(.init(allowedMailboxIds: all, limit: 50))
        #expect(r2.messages.first { $0.gid == f.gid(named: "dup3") }?.file == .partial)
        // Nur Junk erlaubt: einzige Kopie 4712 ohne Datei.
        let r3 = try store.search(.init(allowedMailboxIds: [f.mailboxId(named: "junk")], limit: 50))
        #expect(r3.messages.first { $0.gid == f.gid(named: "dup3") }?.file == FileState.none)
    }

    @Test func getMessagesReadsTheBestRowsFile() throws {
        let r = try store.getMessages(request(["dup3"]))
        let m = try #require(r.messages.first)
        #expect(Data(base64Encoded: try #require(m.raw)) == (try Data(contentsOf: f.expectedEmlxPath(rowid: 4711))))
        // Gleiche Auswahl mit nur partieller Kopie erlaubt (Archiv).
        let arch = try store.getMessages(request(["dup3"], allowed: [f.mailboxId(named: "archiv2024")]))
        #expect(arch.messages[0].row.file == .partial)
        #expect(Data(base64Encoded: try #require(arch.messages[0].raw)) == (try Data(contentsOf: f.expectedEmlxPath(rowid: 123456))))
    }

    @Test func wireShapeMatchesZod() throws {
        let r = try store.getMessages(request(["small", "trash"]))
        let json = try JSONEncoder().encode(r)
        let obj = try #require(try JSONSerialization.jsonObject(with: json) as? [String: Any])
        #expect(Set(obj.keys) == ["messages", "missing", "budgetExhausted"])
        let msgs = try #require(obj["messages"] as? [[String: Any]])
        for m in msgs {
            #expect(Set(m.keys) == ["gid", "messageIdHeader", "subject", "sender", "recipients", "recipientCount", "dateReceived",
                                    "dateSent", "mailboxIds", "read", "flagged", "attachmentNames", "attachmentCount",
                                    "conversationId", "file", "raw", "rawSize", "rawTruncated"])
        }
        #expect(msgs.contains { $0["raw"] is NSNull })
        #expect(msgs.contains { $0["raw"] is String })
        #expect(try JSONDecoder().decode(GetMessagesResult.self, from: json) == r)
    }

    @Test func failureMessagesNeverContainPaths() throws {
        let empty = MailStore(config: MailStoreConfig(mailRoot: f.mailRoot.appending(path: "nix"), accountsDB: f.accountsDB))
        do {
            _ = try empty.getMessages(request(["small"]))
            Issue.record("kein Fehler")
        } catch {
            #expect(!error.message.contains("/"))
        }
    }
}
