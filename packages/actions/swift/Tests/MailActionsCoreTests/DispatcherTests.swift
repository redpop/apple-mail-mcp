import Foundation
import Testing
@testable import MailActionsCore

/// Ersetzt Mail: fuehrt nichts aus und merkt sich jeden Aufruf.
final class FakeAppleEvents: AppleEvents, @unchecked Sendable {
    var running = true
    var permissionCode: Int32 = 0
    var result: (descriptor: NSAppleEventDescriptor?, errorNumber: Int) = (NSAppleEventDescriptor(string: "moved"), 0)
    private(set) var sources: [String] = []
    private(set) var permissionAsks: [Bool] = []

    var isMailRunning: Bool { running }

    func determinePermission(ask: Bool) -> Int32 {
        permissionAsks.append(ask)
        return permissionCode
    }

    func execute(source: String) -> (descriptor: NSAppleEventDescriptor?, errorNumber: Int) {
        sources.append(source)
        return result
    }
}

@Suite struct DispatcherTests {
    let events = FakeAppleEvents()

    private let moveLine = #"{"id":7,"command":"move","payload":{"account":"Acc","source":"INBOX","target":"Archiv/2026","rowid":42,"expectedMessageId":"abc@example.com"}}"#

    private func send(_ line: String) throws -> [String: Any] {
        let out = Dispatcher(events: events).handle(line: Data(line.utf8))
        #expect(!out.contains(0x0A), "antwort muss genau eine Zeile sein")
        return try #require(try JSONSerialization.jsonObject(with: out) as? [String: Any])
    }

    private func result(_ o: [String: Any]) -> [String: Any]? { o["result"] as? [String: Any] }
    private func errorCode(_ o: [String: Any]) -> String? { (o["error"] as? [String: Any])?["code"] as? String }
    private func errorMessage(_ o: [String: Any]) -> String? { (o["error"] as? [String: Any])?["message"] as? String }

    private func movePayload(replacing key: String, with json: String) -> String {
        var fields = [
            "account": #""Acc""#, "source": #""INBOX""#, "target": #""Archiv""#, "rowid": "42",
            "expectedMessageId": #""abc@example.com""#,
        ]
        fields[key] = json
        let body = fields.map { #""\#($0.key)":\#($0.value)"# }.joined(separator: ",")
        return #"{"id":1,"command":"move","payload":{\#(body)}}"#
    }

    // MARK: - hello

    @Test func helloMatchesTheReadPackagesProtocol() throws {
        let o = try send(#"{"id":1,"command":"hello","payload":{}}"#)
        #expect(o["id"] as? Int == 1 && o["ok"] as? Bool == true)
        let r = try #require(result(o))
        #expect(r["protocolVersion"] as? Int == 4)
        #expect(r["helperVersion"] as? String == helperVersion)
        #expect(events.sources.isEmpty && events.permissionAsks.isEmpty)
    }

    // MARK: - Eingabe

    @Test func unknownCommandIsRejected() throws {
        let o = try send(#"{"id":2,"command":"delete","payload":{}}"#)
        #expect(o["ok"] as? Bool == false && errorCode(o) == "INVALID_INPUT")
        #expect(events.sources.isEmpty)
    }

    @Test func nonObjectLineIsRejected() throws {
        let o = try send("not json")
        #expect(o["id"] is NSNull && errorCode(o) == "INVALID_INPUT")
    }

    @Test func rejectsUnknownKeys() throws {
        for line in [
            movePayload(replacing: "extra", with: #""x""#),
            #"{"id":1,"command":"hello","payload":{"extra":1}}"#,
            #"{"id":1,"command":"permission","payload":{"extra":1}}"#,
            #"{"id":1,"command":"request-permission","payload":{"extra":1}}"#,
        ] {
            let o = try send(line)
            #expect(errorCode(o) == "INVALID_INPUT")
            #expect(errorMessage(o)?.contains("extra") == true)
        }
        #expect(events.sources.isEmpty)
    }

    @Test func rejectsInvalidMoveValues() throws {
        for (key, json) in [
            ("rowid", #""1 or true""#), ("rowid", "1.5"), ("rowid", "0"), ("rowid", "-1"), ("rowid", "true"),
            ("account", #""""#), ("source", #""""#), ("target", #""""#), ("expectedMessageId", #""""#),
            ("account", "1"), ("target", "null"),
            ("account", #""A\nB""#), ("target", #""A\u0000B""#),
        ] {
            let o = try send(movePayload(replacing: key, with: json))
            #expect(errorCode(o) == "INVALID_INPUT", "\(key)=\(json)")
        }
        #expect(events.sources.isEmpty)
    }

    @Test func invalidValueIsNotEchoed() throws {
        let o = try send(movePayload(replacing: "account", with: #""geheim\nkonto""#))
        #expect(errorMessage(o)?.contains("geheim") == false)
    }

    // MARK: - permission

    @Test(arguments: [
        (Int32(0), "granted"), (Int32(-1743), "denied"), (Int32(-1744), "undetermined"),
        (Int32(-600), "mail_not_running"), (Int32(-50), "denied"),
    ])
    func permissionMapsStatus(code: Int32, status: String) throws {
        events.permissionCode = code
        let o = try send(#"{"id":1,"command":"permission","payload":{}}"#)
        #expect(result(o)?["status"] as? String == status)
        #expect(events.permissionAsks == [false], "permission zeigt nie einen Dialog")
    }

    @Test func requestPermissionMayAsk() throws {
        let o = try send(#"{"id":1,"command":"request-permission","payload":{}}"#)
        #expect(result(o)?["status"] as? String == "granted")
        #expect(events.permissionAsks == [true])
    }

    @Test(arguments: ["permission", "request-permission"])
    func permissionDoesNotTouchAStoppedMail(command: String) throws {
        events.running = false
        let o = try send(#"{"id":1,"command":"\#(command)","payload":{}}"#)
        #expect(result(o)?["status"] as? String == "mail_not_running")
        #expect(events.permissionAsks.isEmpty)
    }

    // MARK: - move

    @Test func moveRunsTheScriptOnce() throws {
        let o = try send(moveLine)
        #expect(o["id"] as? Int == 7 && result(o)?["outcome"] as? String == "moved")
        #expect(events.sources.count == 1)
        let source = try #require(events.sources.first)
        #expect(source.contains(#"mailbox "INBOX" of account "Acc""#))
        #expect(source.contains(#"mailbox "Archiv/2026" of account "Acc""#))
        #expect(source.contains("whose id is 42)"))
    }

    @Test func moveReportsMismatchFromScriptResult() throws {
        events.result = (NSAppleEventDescriptor(string: "mismatch"), 0)
        #expect(result(try send(moveLine))?["outcome"] as? String == "mismatch")
    }

    @Test func notFoundFromScriptResult() throws {
        events.result = (NSAppleEventDescriptor(string: "not_found"), 0)
        #expect(result(try send(moveLine))?["outcome"] as? String == "not_found")
    }

    @Test func folderNotFoundFromScriptResult() throws {
        events.result = (NSAppleEventDescriptor(string: "folder_not_found"), 0)
        #expect(result(try send(moveLine))?["outcome"] as? String == "folder_not_found")
    }

    @Test(arguments: [-1728, -1719])
    func notFoundFor1728(number: Int) throws {
        events.result = (nil, number)
        let r = try #require(result(try send(moveLine)))
        #expect(r["outcome"] as? String == "not_found")
        #expect(r["code"] as? Int == number)
    }

    @Test func moveReturnsNoSubjectOrPath() throws {
        let moved = try #require(result(try send(moveLine)))
        #expect(Set(moved.keys) == ["outcome"])
        events.result = (nil, -1728)
        let notFound = try #require(result(try send(moveLine)))
        #expect(Set(notFound.keys) == ["outcome", "code"])
    }

    @Test func unexpectedScriptResultIsNeverEchoed() throws {
        events.result = (NSAppleEventDescriptor(string: "Rechnung fuer Max"), 0)
        let o = try send(moveLine)
        #expect(errorCode(o) == "MOVE_FAILED")
        #expect(errorMessage(o)?.contains("Rechnung") == false)
    }

    @Test func missingDescriptorIsMoveFailed() throws {
        events.result = (nil, 0)
        #expect(errorCode(try send(moveLine)) == "MOVE_FAILED")
    }

    @Test func mailNotRunningSendsNoEvent() throws {
        events.running = false
        #expect(errorCode(try send(moveLine)) == "MAIL_NOT_RUNNING")
        #expect(events.sources.isEmpty && events.permissionAsks.isEmpty)
    }

    @Test(arguments: [Int32(-1743), Int32(-1744), Int32(-50)])
    func missingPermissionStopsBeforeTheScript(code: Int32) throws {
        events.permissionCode = code
        #expect(errorCode(try send(moveLine)) == "AUTOMATION_NOT_GRANTED")
        #expect(events.sources.isEmpty)
        #expect(events.permissionAsks == [false], "move zeigt nie einen Dialog")
    }

    @Test func permissionCheckSeesMailGone() throws {
        events.permissionCode = -600
        #expect(errorCode(try send(moveLine)) == "MAIL_NOT_RUNNING")
        #expect(events.sources.isEmpty)
    }

    @Test(arguments: [-1743, -1744])
    func automationDeniedDuringTheScript(number: Int) throws {
        events.result = (nil, number)
        #expect(errorCode(try send(moveLine)) == "AUTOMATION_NOT_GRANTED")
    }

    @Test func procNotFoundDuringTheScriptIsMailNotRunning() throws {
        events.result = (nil, -600)
        #expect(errorCode(try send(moveLine)) == "MAIL_NOT_RUNNING")
    }

    @Test(arguments: [-1712, -609, -10000])
    func otherEventErrorsCarryOnlyTheNumber(number: Int) throws {
        events.result = (nil, number)
        let o = try send(moveLine)
        #expect(errorCode(o) == "MOVE_FAILED")
        #expect(errorMessage(o) == "Apple Event error \(number).")
    }
}
