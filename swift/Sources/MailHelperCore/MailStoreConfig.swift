import Foundation

/// Pfade, auf denen MailStore arbeitet. Das Executable setzt echte Pfade, Tests Fixture-Pfade.
public struct MailStoreConfig: Sendable {
    /// Entspricht `~/Library/Mail` (enthaelt `V10/`).
    public let mailRoot: URL
    /// Entspricht `~/Library/Accounts/Accounts4.sqlite`.
    public let accountsDB: URL

    public init(mailRoot: URL, accountsDB: URL) {
        self.mailRoot = mailRoot
        self.accountsDB = accountsDB
    }
}
