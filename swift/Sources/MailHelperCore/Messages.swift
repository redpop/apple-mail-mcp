import Foundation

/// Obergrenze fuer `maxBytesTotal`, einzige Stelle (Task 8: eine Zeile darf 32 MiB nicht ueberschreiten,
/// Base64 blaeht 24 MiB auf 32 MiB auf).
public let getMessagesTotalByteCap = 24 * 1024 * 1024
private let maxGids = 50
private let getMessagesMaxRecipients = 100

/// Spec 7.3 `get-messages`.
public struct GetMessagesRequest: Codable, Equatable, Sendable {
    public var allowedMailboxIds: [Int64]
    public var gids: [Int64]
    public var maxBytesPerMessage: Int
    public var maxBytesTotal: Int

    public init(allowedMailboxIds: [Int64], gids: [Int64], maxBytesPerMessage: Int, maxBytesTotal: Int) {
        self.allowedMailboxIds = allowedMailboxIds
        self.gids = gids
        self.maxBytesPerMessage = maxBytesPerMessage
        self.maxBytesTotal = maxBytesTotal
    }
}

/// `MessageRow` plus `raw` (Base64, mit .emlx-Rahmen), `rawSize`, `rawTruncated`. Auf der Leitung flach.
public struct RawMessage: Codable, Equatable, Sendable {
    public let row: MessageRow
    public let raw: String?
    public let rawSize: Int64
    public let rawTruncated: Bool

    enum ExtraKeys: String, CodingKey { case raw, rawSize, rawTruncated }

    init(row: MessageRow, raw: String?, rawSize: Int64, rawTruncated: Bool) {
        self.row = row
        self.raw = raw
        self.rawSize = rawSize
        self.rawTruncated = rawTruncated
    }

    public init(from decoder: Decoder) throws {
        row = try MessageRow(from: decoder)
        let c = try decoder.container(keyedBy: ExtraKeys.self)
        raw = try c.decodeIfPresent(String.self, forKey: .raw)
        rawSize = try c.decode(Int64.self, forKey: .rawSize)
        rawTruncated = try c.decode(Bool.self, forKey: .rawTruncated)
    }

    // raw ist fuer zod nullable, nicht optional: nil wird als null geschrieben.
    public func encode(to encoder: Encoder) throws {
        try row.encode(to: encoder)
        var c = encoder.container(keyedBy: ExtraKeys.self)
        try c.encode(raw, forKey: .raw)
        try c.encode(rawSize, forKey: .rawSize)
        try c.encode(rawTruncated, forKey: .rawTruncated)
    }
}

public struct GetMessagesResult: Codable, Equatable, Sendable {
    public var messages: [RawMessage]
    public var missing: [Int64]
    public var budgetExhausted: Bool
}

extension MailStore {
    public func getMessages(_ r: GetMessagesRequest) throws(HelperFailure) -> GetMessagesResult {
        func invalid(_ field: String) -> HelperFailure {
            HelperFailure(code: .invalidInput, message: "Invalid value for \(field).")
        }
        guard !r.allowedMailboxIds.isEmpty else { throw invalid("allowedMailboxIds") }
        guard (1...maxGids).contains(r.gids.count) else { throw invalid("gids") }
        guard r.maxBytesPerMessage >= 1 else { throw invalid("maxBytesPerMessage") }
        guard r.maxBytesTotal >= 1 else { throw invalid("maxBytesTotal") }

        var seen = Set<Int64>()
        let gids = r.gids.filter { seen.insert($0).inserted }
        let detailed = try loadDetailed(gids: gids, allowed: r.allowedMailboxIds, maxRecipients: getMessagesMaxRecipients)
        let found = Set(detailed.map(\.row.gid))
        let missing = gids.filter { !found.contains($0) }

        // Das Gesamtbudget begrenzt auch eine einzelne Nachricht, damit die erste immer hineinpasst.
        let total = min(r.maxBytesTotal, getMessagesTotalByteCap)
        let perMessage = min(r.maxBytesPerMessage, total)
        let locator = try emlxLocator()
        var used = 0
        var exhausted = false
        var out: [RawMessage] = []
        for (row, located) in detailed {
            guard !exhausted, let located, let content = locator.read(located, maxBytes: perMessage) else {
                out.append(RawMessage(row: row, raw: nil, rawSize: 0, rawTruncated: false))
                continue
            }
            if used + content.data.count > total {
                exhausted = true
                out.append(RawMessage(row: row, raw: nil, rawSize: 0, rawTruncated: false))
                continue
            }
            used += content.data.count
            out.append(RawMessage(row: row, raw: content.data.base64EncodedString(), rawSize: content.size,
                                  rawTruncated: content.size > Int64(perMessage)))
        }
        return GetMessagesResult(messages: out, missing: missing, budgetExhausted: exhausted)
    }
}
