import Foundation

public enum Access: String, Codable, Sendable {
    case granted
    case denied
    case noMailData = "no_mail_data"
    case untrustedSignature = "untrusted_signature"
}

public struct Counts: Codable, Equatable, Sendable {
    public let mailboxes: Int64
    public let messages: Int64
    public let uniqueMessages: Int64
}

public struct AccountNamesState: Codable, Equatable, Sendable {
    public enum Status: String, Codable, Sendable { case available, unavailable }
    public var status: Status
    public var unmatchedAccounts: Int

    public init(status: Status, unmatchedAccounts: Int) {
        self.status = status
        self.unmatchedAccounts = unmatchedAccounts
    }
}

/// JSON-Form von `probe` (Spec 7.3). Fehlende Optionals werden nicht kodiert.
public struct ProbeResult: Codable, Sendable {
    public var osVersion: String
    public var mailDir: String?
    public var access: Access
    public var schema: SchemaReport?
    public var counts: Counts?
    public var accountNames: AccountNamesState

    enum CodingKeys: String, CodingKey { case osVersion, mailDir, access, schema, counts, accountNames }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(osVersion, forKey: .osVersion)
        try c.encode(mailDir, forKey: .mailDir)   // null bleibt null (zod: nullable, nicht optional)
        try c.encode(access, forKey: .access)
        try c.encodeIfPresent(schema, forKey: .schema)
        try c.encodeIfPresent(counts, forKey: .counts)
        try c.encode(accountNames, forKey: .accountNames)
    }
}

extension MailStore {
    static var osVersionString: String {
        let v = ProcessInfo.processInfo.operatingSystemVersion
        return "\(v.majorVersion).\(v.minorVersion).\(v.patchVersion)"
    }

    /// Liefert nie einen Fehler, sondern einen Zustand.
    public func probe() -> ProbeResult {
        func result(_ access: Access, dir: String? = nil, schema: SchemaReport? = nil, counts: Counts? = nil,
                    names: AccountNamesLookup = .unavailable(Accounts.notFound)) -> ProbeResult {
            ProbeResult(osVersion: Self.osVersionString, mailDir: dir, access: access, schema: schema, counts: counts,
                        accountNames: AccountNamesState(status: names.available ? .available : .unavailable,
                                                        unmatchedAccounts: names.unmatched))
        }
        let located: MailRoot.Located
        do { located = try MailRoot.locate(root: config.mailRoot) } catch {
            return result(error.code == .fullDiskAccessRequired ? .denied : .noMailData)
        }
        do {
            // Nutzt die gecachte Verbindung (Spec 5.2); Fehlschlaege werden nicht gecacht, der FDA-Zustand bleibt aktuell.
            let db = try envelopeDatabase()
            let schema = try Schema.check(db)
            guard schema.compatible else { return result(.granted, dir: located.name, schema: schema) }
            var counts: Counts?
            try db.query("""
                SELECT (SELECT COUNT(*) FROM mailboxes),
                       (SELECT COUNT(*) FROM messages),
                       (SELECT COUNT(DISTINCT global_message_id) FROM messages)
                """) { row in
                counts = Counts(mailboxes: row.int(0), messages: row.int(1), uniqueMessages: row.int(2))
            }
            let names = accountNames(for: try readMailboxes())
            return result(.granted, dir: located.name, schema: schema, counts: counts, names: names)
        } catch {
            switch error.code {
            case .fullDiskAccessRequired: return result(.denied)
            case .mailDataNotFound: return result(.noMailData)
            default: return result(.granted, dir: located.name)
            }
        }
    }
}
