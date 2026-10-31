import Foundation

/// Ergebnis der Signaturpruefung des Helpers (Spec 13.2). Der Grund ist fuer den Aufrufer (stderr),
/// er geht nie in eine Antwort.
public enum SigningState: Sendable {
    case trusted
    case untrusted(String)
}

/// Eine Anfragezeile rein, eine Antwortzeile raus (ohne Zeilenumbruch). Wirft nie.
public struct Dispatcher {
    let store: MailStore
    let signing: SigningState

    public init(store: MailStore, signing: SigningState) {
        self.store = store
        self.signing = signing
    }

    private static let encoder: JSONEncoder = {
        let e = JSONEncoder()
        // Base64 enthaelt "/"; Escaping wuerde die Zeile aufblaehen. Kein prettyPrinted: genau eine Zeile.
        e.outputFormatting = [.withoutEscapingSlashes]
        return e
    }()

    private static let fallback = Data(
        #"{"id":null,"ok":false,"error":{"code":"DATABASE_ERROR","message":"Internal error."}}"#.utf8)

    private struct Wrapped<P: Decodable>: Decodable { let payload: P }

    public func handle(line: Data) -> Data {
        guard let object = (try? JSONSerialization.jsonObject(with: line)) as? [String: Any] else {
            return respond(id: nil, failure: Self.invalid("Request is not a JSON object."))
        }
        let id = Self.requestId(object["id"])
        guard let command = object["command"] as? String else {
            return respond(id: id, failure: Self.invalid("Missing command."))
        }
        guard let payload = object["payload"] as? [String: Any] else {
            return respond(id: id, failure: Self.invalid("Payload must be a JSON object."))
        }
        // Typed throws: Alles im Block wirft nur HelperFailure. Kommt spaeter ein
        // ungetypter Fehler dazu, bricht der Build hier ab, statt ihn still zu
        // einem generischen Fehler zu machen.
        do throws(HelperFailure) {
            switch command {
            case "hello":
                try Self.checkKeys(payload, EmptyPayload.self)
                return respond(id: id, result: HelloResult(protocolVersion: protocolVersion, helperVersion: helperVersion))
            case "probe":
                try Self.checkKeys(payload, EmptyPayload.self)
                if case .untrusted = signing { return respond(id: id, result: untrustedProbe()) }
                return respond(id: id, result: store.probe())
            case "list-mailboxes":
                try Self.checkKeys(payload, EmptyPayload.self)
                try requireTrusted()
                return respond(id: id, result: try store.listMailboxes())
            case "search":
                let r: SearchRequest = try Self.decode(line, payload)
                try requireTrusted()
                return respond(id: id, result: try store.search(r))
            case "get-messages":
                let r: GetMessagesRequest = try Self.decode(line, payload)
                try requireTrusted()
                return respond(id: id, result: try store.getMessages(r))
            case "thread":
                let r: ThreadRequest = try Self.decode(line, payload)
                try requireTrusted()
                return respond(id: id, result: try store.thread(r))
            default:
                return respond(id: id, failure: Self.invalid("Unknown command."))
            }
        } catch {
            return respond(id: id, failure: error)
        }
    }

    private func requireTrusted() throws(HelperFailure) {
        if case .untrusted = signing {
            throw HelperFailure(code: .helperUntrustedSignature, message: "The helper signature is not trusted.")
        }
    }

    /// Kein Dateizugriff: weder Schema noch Zaehler.
    private func untrustedProbe() -> ProbeResult {
        ProbeResult(osVersion: MailStore.osVersionString, mailDir: nil, access: .untrustedSignature,
                    schema: nil, counts: nil,
                    accountNames: AccountNamesState(status: .unavailable, unmatchedAccounts: 0, reason: Accounts.notChecked))
    }

    private static func invalid(_ message: String) -> HelperFailure {
        HelperFailure(code: .invalidInput, message: message)
    }

    private static func requestId(_ value: Any?) -> Int64? {
        guard let n = value as? NSNumber, CFGetTypeID(n) != CFBooleanGetTypeID() else { return nil }
        let d = n.doubleValue
        guard d == d.rounded(), abs(d) < 9.0e15 else { return nil }
        return n.int64Value
    }

    /// Laengster Schluesselname, der in einer Meldung erscheint; der Rest wird abgeschnitten.
    static let maxEchoedKeyLength = 64

    /// Fremde Schluessel, auch in verschachtelten Objekten: die Meldung nennt nur den
    /// (gekuerzten) Schluessel, nie einen Wert.
    private static func checkKeys<P: StrictPayload>(_ payload: [String: Any], _: P.Type) throws(HelperFailure) {
        if let key = payload.keys.filter({ !P.allowedKeys.contains($0) }).min() {
            throw invalid("Unknown field: \(echo(key))")
        }
        for (field, allowed) in P.nestedKeys.sorted(by: { $0.key < $1.key }) {
            // Kein Objekt (null, falscher Typ): das entscheidet der Decoder.
            guard let nested = payload[field] as? [String: Any] else { continue }
            if let key = nested.keys.filter({ !allowed.contains($0) }).min() {
                throw invalid("Unknown field: \(field).\(echo(key))")
            }
        }
    }

    private static func echo(_ key: String) -> String {
        key.count > maxEchoedKeyLength ? key.prefix(maxEchoedKeyLength) + "..." : key
    }

    private static func decode<P: StrictPayload>(_ line: Data, _ payload: [String: Any]) throws(HelperFailure) -> P {
        try checkKeys(payload, P.self)
        do {
            return try JSONDecoder().decode(Wrapped<P>.self, from: line).payload
        } catch let error as DecodingError {
            let context: DecodingError.Context
            switch error {
            case .typeMismatch(_, let c), .valueNotFound(_, let c), .dataCorrupted(let c): context = c
            case .keyNotFound(let key, let c): context = .init(codingPath: c.codingPath + [key], debugDescription: "")
            @unknown default: throw invalid("Invalid payload.")
            }
            // Nur Schluessel aus dem Schema, keine Array-Indizes und keine Werte.
            let names = context.codingPath.map(\.stringValue).filter { $0 != "payload" && $0 != "Index" && !$0.hasPrefix("Index ") }
            throw invalid("Invalid value for \(names.first ?? "payload").")
        } catch {
            throw invalid("Invalid payload.")
        }
    }

    private func respond<R: Encodable>(id: Int64?, result: R) -> Data {
        encode(ResponseEnvelope(id: id, result: result, error: nil))
    }

    private func respond(id: Int64?, failure: HelperFailure) -> Data {
        encode(ResponseEnvelope<HelloResult>(id: id, result: nil, error: .init(code: failure.code, message: failure.message)))
    }

    private func encode<R: Encodable>(_ envelope: ResponseEnvelope<R>) -> Data {
        (try? Self.encoder.encode(envelope)) ?? Self.fallback
    }
}
