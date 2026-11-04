import Foundation

/// Version des NDJSON-Protokolls. Gleich `PROTOCOL_VERSION` in src/stdioRunner.ts, damit
/// `createStdioRunner` des Lesepakets dieses Bundle unveraendert starten kann.
public let protocolVersion = 4

/// `hello`: Ergebnis.
struct HelloResult: Encodable, Sendable {
    let protocolVersion: Int
    let helperVersion: String
}

/// `permission` und `request-permission`: Ergebnis.
struct PermissionResult: Encodable, Sendable {
    enum Status: String, Encodable, Sendable {
        case granted, denied, undetermined
        case mailNotRunning = "mail_not_running"
    }

    let status: Status
}

/// `move`: Ergebnis. Bewusst nur Status und Nummer: nie Betreff, Pfad oder ein Fehlertext von Mail.
/// `code` fehlt im JSON, wenn es keine Apple-Event-Nummer gibt.
struct MoveResult: Encodable, Sendable {
    enum Outcome: String, Encodable, Sendable {
        case moved, mismatch
        case notFound = "not_found"
        case folderNotFound = "folder_not_found"
    }

    let outcome: Outcome
    var code: Int?
}

/// `move`: Anfrage. Node hat alle Regeln schon geprueft; das Bundle entscheidet nichts ausser dem
/// Vergleich der `message id`.
struct MoveRequest: StrictPayload {
    static let allowedKeys: Set<String> = ["account", "source", "target", "rowid", "expectedMessageId"]

    let account: String
    let source: String
    let target: String
    let rowid: Int64
    let expectedMessageId: String
}

/// Erlaubte Payload-Schluessel je Request-Typ: unbekannte Felder sind ein Fehler.
protocol StrictPayload: Decodable {
    static var allowedKeys: Set<String> { get }
}

/// hello, permission und request-permission nehmen nur `{}`.
struct EmptyPayload: StrictPayload {
    static let allowedKeys: Set<String> = []
}

enum ErrorCode: String, Encodable, Sendable {
    case invalidInput = "INVALID_INPUT"
    case mailNotRunning = "MAIL_NOT_RUNNING"
    case automationNotGranted = "AUTOMATION_NOT_GRANTED"
    case moveFailed = "MOVE_FAILED"
}

/// Fehler mit Code und festem englischem Satz. `message` enthaelt nie Nutzerdaten,
/// bei Apple Events nur die Nummer: Fehlertexte von Mail koennen Inhalte nennen.
struct ActionFailure: Error, Sendable {
    let code: ErrorCode
    let message: String
}

/// Antwort-Huelle wie beim Helper. `id` ist null, wenn die Anfrage keine numerische id trug.
struct ResponseEnvelope<R: Encodable>: Encodable {
    struct Failure: Encodable {
        let code: ErrorCode
        let message: String
    }

    let id: Int64?
    let result: R?
    let error: Failure?

    enum CodingKeys: String, CodingKey { case id, ok, result, error }

    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(id, forKey: .id)
        if let result {
            try c.encode(true, forKey: .ok)
            try c.encode(result, forKey: .result)
        } else {
            try c.encode(false, forKey: .ok)
            try c.encode(error, forKey: .error)
        }
    }
}
