import Foundation

/// Eine Anfragezeile rein, eine Antwortzeile raus (ohne Zeilenumbruch). Wirft nie.
public struct Dispatcher {
    // Apple-Event-Nummern, die eine eigene Bedeutung haben.
    private static let procNotFound = -600
    private static let notPermitted = -1743
    private static let wouldRequireConsent = -1744
    private static let objectNotFound = -1728
    private static let invalidIndex = -1719

    let events: any AppleEvents
    /// Einmal beim Start gelesen; fuer Tests austauschbar.
    let environment: [String: String]

    public init(events: any AppleEvents, environment: [String: String] = ProcessInfo.processInfo.environment) {
        self.events = events
        self.environment = environment
    }

    private static let encoder: JSONEncoder = {
        let e = JSONEncoder()
        e.outputFormatting = [.withoutEscapingSlashes]
        return e
    }()

    private static let fallback = Data(
        #"{"id":null,"ok":false,"error":{"code":"MOVE_FAILED","message":"Internal error."}}"#.utf8)

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
        do throws(ActionFailure) {
            switch command {
            case "hello":
                try Self.checkKeys(payload, EmptyPayload.self)
                return respond(id: id, result: HelloResult(protocolVersion: protocolVersion, helperVersion: helperVersion))
            case "permission":
                try Self.checkKeys(payload, EmptyPayload.self)
                return respond(id: id, result: permission(ask: false))
            case "request-permission":
                try Self.checkKeys(payload, EmptyPayload.self)
                return respond(id: id, result: permission(ask: true))
            case "move":
                let request: MoveRequest = try Self.decode(line, payload)
                try Self.validate(request)
                return respond(id: id, result: try move(request))
            case "save-attachment":
                let request: SaveAttachmentRequest = try Self.decode(line, payload)
                try Self.validate(request)
                return respond(id: id, result: try saveAttachment(request))
            default:
                return respond(id: id, failure: Self.invalid("Unknown command."))
            }
        } catch {
            return respond(id: id, failure: error)
        }
    }

    // MARK: - Befehle

    /// Mail laeuft nicht: kein Aufruf, kein Dialog, und Mail wird nicht gestartet.
    private func permission(ask: Bool) -> PermissionResult {
        guard events.isMailRunning else { return PermissionResult(status: .mailNotRunning) }
        return PermissionResult(status: Self.status(events.determinePermission(ask: ask)))
    }

    /// Unbekannte Werte gelten als `denied`: nur ein klares Ja darf zu einem Verschieben fuehren.
    private static func status(_ code: Int32) -> PermissionResult.Status {
        switch Int(code) {
        case 0: return .granted
        case procNotFound: return .mailNotRunning
        case wouldRequireConsent: return .undetermined
        default: return .denied
        }
    }

    private func move(_ request: MoveRequest) throws(ActionFailure) -> MoveResult {
        guard events.isMailRunning else { throw Self.mailNotRunning }
        // Die Pruefung ohne Dialog steht vor dem Skript: das wuerde sonst selbst nachfragen.
        switch Self.status(events.determinePermission(ask: false)) {
        case .granted: break
        case .mailNotRunning: throw Self.mailNotRunning
        case .denied, .undetermined: throw Self.notGranted
        }
        let source = Script.move(
            account: request.account, source: request.source, target: request.target,
            rowid: request.rowid, expectedMessageId: request.expectedMessageId)
        let (descriptor, number) = events.execute(source: source)
        switch number {
        case 0:
            // Nur die vier festen Woerter; alles andere wird nie zurueckgegeben.
            guard let value = descriptor?.stringValue, let outcome = MoveResult.Outcome(rawValue: value) else {
                throw ActionFailure(code: .moveFailed, message: "Unexpected result from Mail.")
            }
            return MoveResult(outcome: outcome)
        case Self.objectNotFound, Self.invalidIndex:
            return MoveResult(outcome: .notFound, code: number)
        case Self.procNotFound:
            throw Self.mailNotRunning
        case Self.notPermitted, Self.wouldRequireConsent:
            throw Self.notGranted
        default:
            throw ActionFailure(code: .moveFailed, message: "Apple Event error \(number).")
        }
    }

    private func saveAttachment(_ request: SaveAttachmentRequest) throws(ActionFailure) -> SaveAttachmentResult {
        // HOME aus der Umgebung; NSHomeDirectory nur, wenn der Schluessel fehlt.
        let home = environment["HOME"] ?? NSHomeDirectory()
        guard let base = AttachmentDir.resolve(env: environment, home: home) else {
            throw Self.invalid("Invalid attachment folder setting.")
        }
        guard events.isMailRunning else { throw Self.mailNotRunning }
        switch Self.status(events.determinePermission(ask: false)) {
        case .granted: break
        case .mailNotRunning: throw Self.mailNotRunning
        case .denied, .undetermined: throw Self.notGranted
        }
        // Nur Pfadtext: das Bundle liest, schreibt und legt nichts an.
        let path = base + "/" + request.slot + "/" + request.fileName
        let source = Script.saveAttachment(
            account: request.account, source: request.source, rowid: request.rowid,
            expectedMessageId: request.expectedMessageId, partId: request.partId,
            path: path, maxBytes: request.maxBytes)
        let (descriptor, number) = events.execute(source: source)
        switch number {
        case 0:
            guard let value = descriptor?.stringValue,
                  let outcome = SaveAttachmentResult.Outcome(rawValue: value) else {
                throw ActionFailure(code: .saveFailed, message: "Unexpected result from Mail.")
            }
            return SaveAttachmentResult(outcome: outcome)
        case Self.objectNotFound, Self.invalidIndex:
            return SaveAttachmentResult(outcome: .notFound, code: number)
        case Self.procNotFound:
            throw Self.mailNotRunning
        case Self.notPermitted, Self.wouldRequireConsent:
            throw Self.notGranted
        default:
            throw ActionFailure(code: .saveFailed, message: "Apple Event error \(number).")
        }
    }

    private static let mailNotRunning = ActionFailure(code: .mailNotRunning, message: "Apple Mail is not running.")
    private static let notGranted = ActionFailure(
        code: .automationNotGranted, message: "The Automation permission for Apple Mail is not granted.")

    // MARK: - Eingabe

    private static func invalid(_ message: String) -> ActionFailure {
        ActionFailure(code: .invalidInput, message: message)
    }

    private static func requestId(_ value: Any?) -> Int64? {
        guard let n = value as? NSNumber, CFGetTypeID(n) != CFBooleanGetTypeID() else { return nil }
        let d = n.doubleValue
        guard d == d.rounded(), abs(d) < 9.0e15 else { return nil }
        return n.int64Value
    }

    /// Laengster Schluesselname, der in einer Meldung erscheint; der Rest wird abgeschnitten.
    static let maxEchoedKeyLength = 64

    /// Fremde Schluessel: die Meldung nennt nur den (gekuerzten) Schluessel, nie einen Wert.
    private static func checkKeys<P: StrictPayload>(_ payload: [String: Any], _: P.Type) throws(ActionFailure) {
        if let key = payload.keys.filter({ !P.allowedKeys.contains($0) }).min() {
            let echoed = key.count > maxEchoedKeyLength ? key.prefix(maxEchoedKeyLength) + "..." : key
            throw invalid("Unknown field: \(echoed)")
        }
    }

    private static func decode<P: StrictPayload>(_ line: Data, _ payload: [String: Any]) throws(ActionFailure) -> P {
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
            // Nur Schluessel aus dem Schema, keine Werte.
            let names = context.codingPath.map(\.stringValue).filter { $0 != "payload" }
            throw invalid("Invalid value for \(names.first ?? "payload").")
        } catch {
            throw invalid("Invalid payload.")
        }
    }

    /// Steuerzeichen haben in Konto-, Ordnernamen und Message-IDs nichts zu suchen, und ein NUL im
    /// Skripttext ist nicht sicher ein gewoehnliches Zeichen. Die rowid ist positiv: der Skripttext
    /// enthaelt danach an dieser Stelle nur Ziffern.
    private static func validate(_ request: MoveRequest) throws(ActionFailure) {
        guard request.rowid > 0 else { throw invalid("Invalid value for rowid.") }
        let fields = [
            ("account", request.account), ("source", request.source),
            ("target", request.target), ("expectedMessageId", request.expectedMessageId),
        ]
        for (name, value) in fields {
            let hasControl = value.unicodeScalars.contains { $0.value < 0x20 || $0.value == 0x7F }
            if value.isEmpty || hasControl { throw invalid("Invalid value for \(name).") }
        }
    }

    private static func validate(_ request: SaveAttachmentRequest) throws(ActionFailure) {
        guard request.rowid > 0 else { throw invalid("Invalid value for rowid.") }
        guard (1...104_857_600).contains(request.maxBytes) else { throw invalid("Invalid value for maxBytes.") }
        let fields = [
            ("account", request.account), ("source", request.source),
            ("expectedMessageId", request.expectedMessageId),
        ]
        for (name, value) in fields {
            let hasControl = value.unicodeScalars.contains { $0.value < 0x20 || $0.value == 0x7F }
            if value.isEmpty || hasControl { throw invalid("Invalid value for \(name).") }
        }
        guard AttachmentDir.isPartId(request.partId) else { throw invalid("Invalid value for partId.") }
        guard AttachmentDir.isSlot(request.slot) else { throw invalid("Invalid value for slot.") }
        guard AttachmentDir.isSafeFileName(request.fileName) else { throw invalid("Invalid value for fileName.") }
    }

    // MARK: - Antwort

    private func respond<R: Encodable>(id: Int64?, result: R) -> Data {
        encode(ResponseEnvelope(id: id, result: result, error: nil))
    }

    private func respond(id: Int64?, failure: ActionFailure) -> Data {
        encode(ResponseEnvelope<HelloResult>(id: id, result: nil, error: .init(code: failure.code, message: failure.message)))
    }

    private func encode<R: Encodable>(_ envelope: ResponseEnvelope<R>) -> Data {
        (try? Self.encoder.encode(envelope)) ?? Self.fallback
    }
}
