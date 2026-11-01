import Foundation

/// Version des NDJSON-Protokolls (Spec 7.1). Node vergleicht sie im `hello`.
public let protocolVersion = 2

/// Spec 7.3 `hello`: Ergebnis.
public struct HelloResult: Codable, Equatable, Sendable {
    public var protocolVersion: Int
    public var helperVersion: String
}

/// Erlaubte Payload-Schluessel je Request-Typ (Spec 7.1: unbekannte Felder sind ein Fehler).
protocol StrictPayload: Decodable {
    static var allowedKeys: Set<String> { get }
    /// Erlaubte Schluessel verschachtelter Objekte, je Feldname (z. B. `search.after`).
    static var nestedKeys: [String: Set<String>] { get }
}

extension StrictPayload {
    static var nestedKeys: [String: Set<String>] { [:] }
}

extension SearchRequest: StrictPayload {
    static let allowedKeys: Set<String> = [
        "allowedMailboxIds", "mailboxIds", "from", "to", "subject", "query", "since", "before", "unread",
        "flagged", "hasAttachment", "gids", "after", "limit", "maxRecipients", "countTotal",
    ]
    static let nestedKeys: [String: Set<String>] = ["after": ["date", "gid"]]
}

extension GetMessagesRequest: StrictPayload {
    static let allowedKeys: Set<String> = ["allowedMailboxIds", "gids", "maxBytesPerMessage", "maxBytesTotal"]
}

extension ThreadRequest: StrictPayload {
    static let allowedKeys: Set<String> = ["allowedMailboxIds", "gid", "limit", "maxRecipients"]
}

extension IndexFeedRequest: StrictPayload {
    static let allowedKeys: Set<String> = ["allowedMailboxIds", "afterRowid", "limit"]
}

extension IndexGidsRequest: StrictPayload {
    static let allowedKeys: Set<String> = ["allowedMailboxIds", "afterGid", "limit"]
}

/// hello, probe und list-mailboxes nehmen nur `{}`.
struct EmptyPayload: StrictPayload {
    static let allowedKeys: Set<String> = []
}

/// Antwort-Huelle. `id` ist null, wenn die Anfrage keine numerische id trug.
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
