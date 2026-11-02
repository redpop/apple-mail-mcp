import Foundation

public struct MailboxInfo: Codable, Equatable, Sendable {
    public let id: Int64
    public let url: String
    public let total: Int64
    public let unread: Int64
}

/// Ob ein Konto noch sein Verzeichnis `V<n>/<konto-uuid>/` hat (AMM-21). Ohne es ist das Konto aus Mail
/// entfernt, seine Zeilen stehen aber noch im Envelope Index.
public struct AccountStore: Codable, Equatable, Sendable {
    public let uuid: String
    public let hasStore: Bool
}

/// JSON-Form von `list-mailboxes` (Spec 7.3). `accountNamesReason` fehlt, wenn die Namen verfuegbar sind.
public struct ListMailboxesResult: Codable, Equatable, Sendable {
    public var mailboxes: [MailboxInfo]
    public var accounts: [AccountInfo]
    public var accountStores: [AccountStore]
    public var accountNames: AccountNamesState.Status
    public var accountNamesReason: String?

    enum CodingKeys: String, CodingKey { case mailboxes, accounts, accountStores, accountNames, accountNamesReason }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(mailboxes, forKey: .mailboxes)
        try c.encode(accounts, forKey: .accounts)
        try c.encode(accountStores, forKey: .accountStores)
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
        let versionDir = config.mailRoot.appending(path: try MailRoot.locate(root: config.mailRoot).name)
        return ListMailboxesResult(mailboxes: mailboxes, accounts: names.accounts,
                                   accountStores: Self.accountStores(versionDir: versionDir, mailboxes: mailboxes),
                                   accountNames: names.available ? .available : .unavailable,
                                   accountNamesReason: names.reason)
    }

    /// Je Konto mit imap://- oder local://-Mailbox, ob `<versionDir>/<konto-uuid>` ein Verzeichnis ist, nach UUID
    /// sortiert. Nur diese zwei Schemata, weil nur fuer sie die Ablage bekannt ist (wie im EmlxLocator); andere
    /// Konten fehlen in der Liste und bleiben fuer Node sichtbar. Der Pfad kommt nur aus der Mailbox-URL.
    static func accountStores(versionDir: URL, mailboxes: [MailboxInfo]) -> [AccountStore] {
        var seen = Set<String>()
        for m in mailboxes {
            guard let sep = m.url.range(of: "://") else { continue }
            let scheme = m.url[..<sep.lowerBound].lowercased()
            guard scheme == "imap" || scheme == "local" else { continue }
            let host = m.url[sep.upperBound...].prefix { $0 != "/" }
            if !host.isEmpty { seen.insert(String(host)) }
        }
        let root = realpathString(versionDir.path)
        return seen.sorted().map { AccountStore(uuid: $0, hasStore: hasStore(versionDir: versionDir.path, realRoot: root, host: $0)) }
    }

    /// Segment wie im EmlxLocator dekodiert und geprueft, dann per realpath unter dem Mail-Verzeichnis.
    /// Fehlt das Verzeichnis (ENOENT/ENOTDIR), zeigt es nach aussen oder ist es keins: kein Store. Jeder andere
    /// Fehler laesst offen, ob das Konto entfernt ist; dann gilt es als vorhanden und bleibt sichtbar.
    static func hasStore(versionDir: String, realRoot: String?, host: String) -> Bool {
        guard let seg = host.removingPercentEncoding, !seg.isEmpty, seg != ".", seg != "..",
              !seg.contains("/"), !seg.unicodeScalars.contains("\u{0}") else { return false }
        guard let root = realRoot else { return true }
        guard let p = realpath(versionDir + "/" + seg, nil) else { return !(errno == ENOENT || errno == ENOTDIR) }
        let resolved = String(cString: p)
        free(p)
        let prefix = root.hasSuffix("/") ? root : root + "/"
        guard resolved.hasPrefix(prefix) else { return false }
        var st = stat()
        return stat(resolved, &st) == 0 && (st.st_mode & S_IFMT) == S_IFDIR
    }

    private static func realpathString(_ path: String) -> String? {
        guard let p = realpath(path, nil) else { return nil }
        defer { free(p) }
        return String(cString: p)
    }

    /// Liest Accounts4, wenn kein passender Cache-Eintrag da ist. Gecacht wird nur ein "available"-Ergebnis,
    /// und nur solange die UUID-Menge der Mail-Konten gleich bleibt; das Neuoeffnen des Envelope Index
    /// (MailStore.envelopeConnection) verwirft den Cache.
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
