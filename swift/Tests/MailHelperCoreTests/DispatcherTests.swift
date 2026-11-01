import Foundation
import Testing
@testable import MailHelperCore

@Suite struct DispatcherTests {
    let f: Fixture
    let store: MailStore

    init() throws {
        f = try FixtureBuilder.build()
        store = MailStore(config: f.config)
    }

    private func line(_ s: String) -> Data { Data(s.utf8) }

    private func object(_ d: Data) throws -> [String: Any] {
        try #require(try JSONSerialization.jsonObject(with: d) as? [String: Any])
    }

    private func errorCode(_ d: Data) throws -> String? {
        ((try object(d))["error"] as? [String: Any])?["code"] as? String
    }

    private var allowed: String { f.allMailboxIds.map(String.init).joined(separator: ",") }

    @Test func helloAnswersProtocolVersion() throws {
        let out = Dispatcher(store: store, signing: .trusted).handle(line: line(#"{"id":1,"command":"hello","payload":{}}"#))
        #expect(String(decoding: out, as: UTF8.self).contains(#""protocolVersion":2"#))
        let o = try object(out)
        #expect(o["id"] as? Int == 1 && o["ok"] as? Bool == true)
        let r = try #require(o["result"] as? [String: Any])
        #expect(r["helperVersion"] as? String == helperVersion)
        #expect(Set(r.keys) == ["protocolVersion", "helperVersion"])
    }

    @Test func unknownFieldIsInvalidInput() throws {
        let d = Dispatcher(store: store, signing: .trusted)
        let out = d.handle(line: line(#"{"id":5,"command":"search","payload":{"limit":1,"allowedMailboxIds":[1],"sql":"x"}}"#))
        let o = try object(out)
        #expect(o["ok"] as? Bool == false)
        #expect(try errorCode(out) == "INVALID_INPUT")
        let message = try #require((o["error"] as? [String: Any])?["message"] as? String)
        #expect(message.contains("sql"))
        // Der Wert eines fremden Feldes erscheint nie in der Meldung.
        let secret = d.handle(line: line(#"{"id":6,"command":"thread","payload":{"allowedMailboxIds":[1],"gid":1,"limit":1,"maxRecipients":0,"zz":"geheim-wert"}}"#))
        #expect(!String(decoding: secret, as: UTF8.self).contains("geheim-wert"))
        #expect(String(decoding: secret, as: UTF8.self).contains("zz"))
        // hello/probe/list-mailboxes nehmen nur {}.
        for c in ["hello", "probe", "list-mailboxes"] {
            #expect(try errorCode(d.handle(line: line(#"{"id":7,"command":"\#(c)","payload":{"x":1}}"#))) == "INVALID_INPUT")
        }
    }

    @Test func unknownNestedFieldIsInvalidInput() throws {
        let d = Dispatcher(store: store, signing: .trusted)
        let out = d.handle(line: line(#"{"id":5,"command":"search","payload":{"limit":1,"maxRecipients":0,"countTotal":false,"allowedMailboxIds":[1],"after":{"date":1,"gid":1,"zz":"geheim-wert"}}}"#))
        #expect(try errorCode(out) == "INVALID_INPUT")
        let text = String(decoding: out, as: UTF8.self)
        #expect(text.contains("after.zz"))
        #expect(!text.contains("geheim-wert"))
        // Ein gueltiges after geht durch.
        let ok = d.handle(line: line(#"{"id":6,"command":"search","payload":{"limit":1,"maxRecipients":0,"countTotal":false,"allowedMailboxIds":[\#(allowed)],"after":{"date":1,"gid":1}}}"#))
        #expect(try object(ok)["ok"] as? Bool == true)
    }

    @Test func unknownFieldNameIsTruncated() throws {
        let d = Dispatcher(store: store, signing: .trusted)
        let long = String(repeating: "k", count: 500)
        let out = d.handle(line: line(#"{"id":5,"command":"hello","payload":{"\#(long)":1}}"#))
        #expect(try errorCode(out) == "INVALID_INPUT")
        let outObject = try object(out)
        let message = try #require((outObject["error"] as? [String: Any])?["message"] as? String)
        #expect(message == "Unknown field: " + String(repeating: "k", count: 64) + "...")
        let nested = d.handle(line: line(#"{"id":6,"command":"search","payload":{"limit":1,"maxRecipients":0,"countTotal":false,"allowedMailboxIds":[1],"after":{"\#(long)":1}}}"#))
        let nestedObject = try object(nested)
        let nestedMessage = try #require((nestedObject["error"] as? [String: Any])?["message"] as? String)
        #expect(nestedMessage == "Unknown field: after." + String(repeating: "k", count: 64) + "...")
    }

    @Test func badPayloadShapesAreInvalidInput() throws {
        let d = Dispatcher(store: store, signing: .trusted)
        for s in [#"{"id":1,"command":"search"}"#, #"{"id":1,"command":"search","payload":[1]}"#,
                  #"{"id":1,"command":"search","payload":"x"}"#,
                  #"{"id":1,"command":"search","payload":{"allowedMailboxIds":"zz","limit":1,"maxRecipients":0,"countTotal":false}}"#,
                  #"{"id":1,"command":"search","payload":{"limit":1}}"#,
                  #"{"id":1,"payload":{}}"#] {
            let out = d.handle(line: line(s))
            #expect(try errorCode(out) == "INVALID_INPUT", Comment(rawValue: s))
            #expect(try object(out)["id"] as? Int == 1)
        }
    }

    @Test func unknownCommandIsInvalidInput() throws {
        let out = Dispatcher(store: store, signing: .trusted).handle(line: line(#"{"id":9,"command":"drop","payload":{}}"#))
        #expect(try errorCode(out) == "INVALID_INPUT")
        #expect(try object(out)["id"] as? Int == 9)
    }

    @Test func garbageLineIsInvalidInputWithoutId() throws {
        let d = Dispatcher(store: store, signing: .trusted)
        for g in [Data("not json".utf8), Data(), Data([0xFF, 0xFE, 0x00]), Data("[1,2]".utf8), Data("42".utf8)] {
            let out = d.handle(line: g)
            let o = try object(out)
            #expect(o["ok"] as? Bool == false)
            #expect(o["id"] is NSNull)
            #expect(try errorCode(out) == "INVALID_INPUT")
            #expect(!out.contains(UInt8(ascii: "\n")))
        }
        // Nicht numerische id wird nicht gespiegelt.
        let out = d.handle(line: line(#"{"id":"a","command":"hello","payload":{}}"#))
        #expect(try object(out)["id"] is NSNull)
    }

    @Test func untrustedSigningBlocksReadsButNotProbe() throws {
        let d = Dispatcher(store: store, signing: .untrusted("test"))
        let reads = [#"{"id":1,"command":"search","payload":{"allowedMailboxIds":[1],"limit":1,"maxRecipients":0,"countTotal":false}}"#,
                     #"{"id":2,"command":"list-mailboxes","payload":{}}"#,
                     #"{"id":3,"command":"get-messages","payload":{"allowedMailboxIds":[1],"gids":[1],"maxBytesPerMessage":1,"maxBytesTotal":1}}"#,
                     #"{"id":4,"command":"thread","payload":{"allowedMailboxIds":[1],"gid":1,"limit":1,"maxRecipients":0}}"#]
        for s in reads { #expect(try errorCode(d.handle(line: line(s))) == "HELPER_UNTRUSTED_SIGNATURE") }
        let p = try object(d.handle(line: line(#"{"id":8,"command":"probe","payload":{}}"#)))
        let r = try #require(p["result"] as? [String: Any])
        #expect(r["access"] as? String == "untrusted_signature")
        #expect(r["schema"] == nil && r["counts"] == nil)
        #expect(p["ok"] as? Bool == true)
        #expect(try object(d.handle(line: line(#"{"id":9,"command":"hello","payload":{}}"#)))["ok"] as? Bool == true)
        // Ohne Mail-Verzeichnis: untrusted probe beruehrt keine Datei und bleibt untrusted.
        let tmp = FileManager.default.temporaryDirectory.appending(path: "none-\(UUID().uuidString)")
        let empty = Dispatcher(store: MailStore(config: MailStoreConfig(mailRoot: tmp, accountsDB: tmp)), signing: .untrusted("x"))
        let e = try object(empty.handle(line: line(#"{"id":1,"command":"probe","payload":{}}"#)))
        #expect((e["result"] as? [String: Any])?["access"] as? String == "untrusted_signature")
    }

    @Test func trustedCommandsWork() throws {
        let d = Dispatcher(store: store, signing: .trusted)
        let lm = try object(d.handle(line: line(#"{"id":1,"command":"list-mailboxes","payload":{}}"#)))
        #expect((lm["result"] as? [String: Any])?["mailboxes"] is [Any])
        let pr = try object(d.handle(line: line(#"{"id":2,"command":"probe","payload":{}}"#)))
        #expect((pr["result"] as? [String: Any])?["access"] as? String == "granted")
        let s = try object(d.handle(line: line(#"{"id":3,"command":"search","payload":{"allowedMailboxIds":[\#(allowed)],"limit":5,"maxRecipients":0,"countTotal":false}}"#)))
        #expect(((s["result"] as? [String: Any])?["messages"] as? [Any])?.count == 5)
        let t = try object(d.handle(line: line(#"{"id":4,"command":"thread","payload":{"allowedMailboxIds":[\#(allowed)],"gid":\#(f.gid(named: "thread1")),"limit":10,"maxRecipients":5}}"#)))
        let tr = try #require(t["result"] as? [String: Any])
        #expect(tr["conversationId"] as? Int == 77)
        #expect((tr["messages"] as? [Any])?.count == 3)
        let g = try object(d.handle(line: line(#"{"id":5,"command":"get-messages","payload":{"allowedMailboxIds":[\#(allowed)],"gids":[\#(f.gid(named: "small")),424242],"maxBytesPerMessage":1000000,"maxBytesTotal":1000000}}"#)))
        let gr = try #require(g["result"] as? [String: Any])
        #expect((gr["messages"] as? [Any])?.count == 1)
        #expect(gr["missing"] as? [Int] == [424242])
        // HelperFailure aus dem Store wird durchgereicht.
        let nf = d.handle(line: line(#"{"id":6,"command":"thread","payload":{"allowedMailboxIds":[\#(allowed)],"gid":999999,"limit":10,"maxRecipients":5}}"#))
        #expect(try errorCode(nf) == "MESSAGE_NOT_FOUND")
        #expect(try object(nf)["id"] as? Int == 6)
    }

    @Test func storeFailureWithoutMailDataIsReported() throws {
        let tmp = FileManager.default.temporaryDirectory.appending(path: "none-\(UUID().uuidString)")
        let d = Dispatcher(store: MailStore(config: MailStoreConfig(mailRoot: tmp, accountsDB: tmp)), signing: .trusted)
        #expect(try errorCode(d.handle(line: line(#"{"id":1,"command":"list-mailboxes","payload":{}}"#))) == "MAIL_DATA_NOT_FOUND")
    }

    @Test func responseLineStaysUnder32MiB() throws {
        let fh = try FileHandle(forWritingTo: f.expectedEmlxPath(rowid: 7))
        try fh.truncate(atOffset: UInt64(25 * 1024 * 1024))
        try fh.close()
        // Die grosse Datei zuerst, damit sie das Budget wirklich ausschoepft.
        let big = f.gid(named: "small")
        var gids = [big] + f.visibleGids.sorted().filter { $0 != big }
        var filler: Int64 = 900_000
        while gids.count < 50 { gids.append(filler); filler += 1 }
        let list = gids.map(String.init).joined(separator: ",")
        let req = #"{"id":1,"command":"get-messages","payload":{"allowedMailboxIds":[\#(allowed)],"gids":[\#(list)],"maxBytesPerMessage":67108864,"maxBytesTotal":67108864}}"#
        let out = Dispatcher(store: store, signing: .trusted).handle(line: line(req))
        #expect(out.count < 32 * 1024 * 1024)
        #expect(out.count > 20 * 1024 * 1024)
        #expect(!out.contains(UInt8(ascii: "\n")))
        #expect(!String(decoding: out.prefix(200), as: UTF8.self).contains("\\/"))
        let o = try object(out)
        #expect(o["ok"] as? Bool == true)
    }
}
