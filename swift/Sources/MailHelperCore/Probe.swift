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
    /// Fester Satz ohne Pfad (Accounts.notFound usw.); fehlt im JSON, wenn die Namen verfuegbar sind.
    public var reason: String?

    public init(status: Status, unmatchedAccounts: Int, reason: String? = nil) {
        self.status = status
        self.unmatchedAccounts = unmatchedAccounts
        self.reason = status == .available ? nil : reason
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
                    names: AccountNamesLookup = .unavailable(Accounts.notChecked)) -> ProbeResult {
            ProbeResult(osVersion: Self.osVersionString, mailDir: dir, access: access, schema: schema, counts: counts,
                        accountNames: AccountNamesState(status: names.available ? .available : .unavailable,
                                                        unmatchedAccounts: names.unmatched, reason: names.reason))
        }
        let located: MailRoot.Located
        do { located = try MailRoot.locate(root: config.mailRoot) } catch {
            return result(error.code == .fullDiskAccessRequired ? .denied : .noMailData)
        }
        do {
            // Nutzt die gecachte Verbindung samt Schemabericht (Spec 5.2, 5.3); Fehlschlaege werden nicht
            // gecacht, der FDA-Zustand bleibt aktuell.
            let (db, schema) = try envelopeConnection()
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
