import Foundation
import Testing
@testable import MailHelperCore

/// Goldene Antworten fuer den Vertrag mit Node (Spec 7.3). Je Dispatcher-Kommando eine Antwort aus der
/// Fixture unter tests/fixtures/contract/; tests/contract.test.ts parst sie mit strikten Varianten der
/// zod-Schemata (unbekannte Schluessel scheitern). Werte, die vom Rechner abhaengen (osVersion,
/// helperVersion), werden durch feste Platzhalter ersetzt; alles andere ist durch die Fixture bestimmt.
///
/// Ohne Umgebungsvariable vergleicht der Test mit den eingecheckten Dateien (als JSON-Objekte, nicht als
/// Text). Mit `UPDATE_CONTRACT=1 npm run test:swift` schreibt er sie neu; danach einchecken.
@Suite struct ContractTests {
    static let placeholderVersion = "0.0.0"

    static func contractDir() throws -> URL {
        try FixtureBuilder.repoRoot().appending(path: "tests/fixtures/contract")
    }

    /// Feste Platzhalter fuer rechnerabhaengige Werte; sonst unveraendert.
    static func normalize(_ envelope: [String: Any]) -> [String: Any] {
        var e = envelope
        if var result = e["result"] as? [String: Any] {
            if result["osVersion"] != nil { result["osVersion"] = placeholderVersion }
            if result["helperVersion"] != nil { result["helperVersion"] = placeholderVersion }
            e["result"] = result
        }
        return e
    }

    @Test func everyCommandMatchesTheGoldenFile() throws {
        let f = try FixtureBuilder.build()
        let d = Dispatcher(store: MailStore(config: f.config), signing: .trusted)
        let allowed = f.allMailboxIds.map(String.init).joined(separator: ",")
        let requests: [(file: String, command: String, payload: String)] = [
            ("hello", "hello", "{}"),
            ("probe", "probe", "{}"),
            ("list-mailboxes", "list-mailboxes", "{}"),
            ("search", "search", #"{"allowedMailboxIds":[\#(allowed)],"limit":5,"maxRecipients":5,"countTotal":true}"#),
            ("get-messages", "get-messages",
             #"{"allowedMailboxIds":[\#(allowed)],"gids":[\#(f.gid(named: "invoice"))],"maxBytesPerMessage":65536,"maxBytesTotal":65536}"#),
            ("thread", "thread", #"{"allowedMailboxIds":[\#(allowed)],"gid":\#(f.gid(named: "thread1")),"limit":50,"maxRecipients":5}"#),
            ("error", "thread", #"{"allowedMailboxIds":[\#(allowed)],"gid":999999,"limit":50,"maxRecipients":5}"#),
        ]
        let update = ProcessInfo.processInfo.environment["UPDATE_CONTRACT"] == "1"
        let dir = try Self.contractDir()
        if update { try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true) }

        for (i, r) in requests.enumerated() {
            let line = Data(#"{"id":\#(i + 1),"command":"\#(r.command)","payload":\#(r.payload)}"#.utf8)
            let raw = try #require(try JSONSerialization.jsonObject(with: d.handle(line: line)) as? [String: Any])
            let normalized = Self.normalize(raw)
            #expect((normalized["ok"] as? Bool) == (r.file != "error"), "\(r.file)")
            let url = dir.appending(path: "\(r.file).json")
            if update {
                var data = try JSONSerialization.data(withJSONObject: normalized,
                                                      options: [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes])
                data.append(Data("\n".utf8))
                try data.write(to: url)
                continue
            }
            let committed = try #require(try JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any],
                                         "\(r.file).json fehlt; mit UPDATE_CONTRACT=1 erzeugen")
            #expect(NSDictionary(dictionary: committed).isEqual(to: normalized),
                    "\(r.file).json weicht ab; mit UPDATE_CONTRACT=1 npm run test:swift neu erzeugen")
        }
    }
}
