import Foundation

public struct MailboxInfo: Codable, Equatable, Sendable {
    public let id: Int64
    public let url: String
    public let total: Int64
    public let unread: Int64
}

/// JSON-Form von `list-mailboxes` (Spec 7.3). `accountNamesReason` fehlt, wenn die Namen verfuegbar sind.
public struct ListMailboxesResult: Codable, Equatable, Sendable {
    public var mailboxes: [MailboxInfo]
    public var accounts: [AccountInfo]
    public var accountNames: AccountNamesState.Status
    public var accountNamesReason: String?

    enum CodingKeys: String, CodingKey { case mailboxes, accounts, accountNames, accountNamesReason }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(mailboxes, forKey: .mailboxes)
        try c.encode(accounts, forKey: .accounts)
        try c.encode(accountNames, forKey: .accountNames)
        try c.encodeIfPresent(accountNamesReason, forKey: .accountNamesReason)
    }
}

extension AccountInfo {
    enum CodingKeys: String, CodingKey { case uuid, description, username }

    // description/username sind fuer zod nullable, nicht optional: null bleibt null.
    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(uuid, forKey: .uuid)
        try c.encode(description, forKey: .description)
        try c.encode(username, forKey: .username)
    }
}

extension MailStore {
    /// Host-Teil von imap://, local:// und ews:// (Schema ohne Beachtung der Gross-/Kleinschreibung).
    static func accountUUID(fromMailboxURL url: String) -> String? {
        guard let r = url.range(of: "://") else { return nil }
        let scheme = url[..<r.lowerBound].lowercased()
        guard ["imap", "local", "ews"].contains(scheme) else { return nil }
        let host = url[r.upperBound...].prefix { $0 != "/" }
        return host.isEmpty ? nil : String(host)
    }

    func readMailboxes() throws(HelperFailure) -> [MailboxInfo] {
        let db = try envelopeDatabase()
        var out: [MailboxInfo] = []
        try db.query("SELECT ROWID, url, total_count, unread_count FROM mailboxes ORDER BY ROWID") { row in
            out.append(MailboxInfo(id: row.int(0), url: row.text(1) ?? "", total: row.int(2), unread: row.int(3)))
        }
        return out
    }

    public func listMailboxes() throws(HelperFailure) -> ListMailboxesResult {
        let mailboxes = try readMailboxes()
        let names = accountNames(for: mailboxes)
        return ListMailboxesResult(mailboxes: mailboxes, accounts: names.accounts,
                                   accountNames: names.available ? .available : .unavailable,
                                   accountNamesReason: names.reason)
    }

    /// Einmal pro Helper-Lebenszeit; spaetere Aufrufe nutzen den Cache.
    func accountNames(for mailboxes: [MailboxInfo]) -> AccountNamesLookup {
        var seen = Set<String>()
        var uuids: [String] = []
        for m in mailboxes {
            if let u = Self.accountUUID(fromMailboxURL: m.url), seen.insert(u).inserted { uuids.append(u) }
        }
        // Cache nur fuer "available" und nur solange die UUID-Menge gleich bleibt.
        if let c = accountNamesCache, c.uuids == seen { return c.lookup }
        let result = Accounts.lookup(at: config.accountsDB, uuids: uuids)
        accountNamesCache = result.available ? (seen, result) : nil
        return result
    }
}
