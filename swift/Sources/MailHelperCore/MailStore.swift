import Foundation

/// Nicht thread-sicher: der Helper arbeitet seriell (eine Anfrage nach der anderen).
public final class MailStore {
    let config: MailStoreConfig
    /// Eine Envelope-Index-Verbindung pro Helper-Lebenszeit (Spec 5.2), lazy geoeffnet.
    private var envelope: (path: String, db: Database)?
    var accountNamesCache: AccountNamesLookup?

    public init(config: MailStoreConfig) {
        self.config = config
    }

    /// Liefert die gecachte Verbindung oder oeffnet sie. Fehlschlaege werden nicht gecacht,
    /// so dass ein spaeter erteiltes Full Disk Access beim naechsten Aufruf greift.
    func envelopeDatabase() throws(HelperFailure) -> Database {
        let located = try MailRoot.locate(root: config.mailRoot)
        let path = located.envelopeIndex.path
        if let e = envelope, e.path == path { return e.db }
        let db = try Database(readOnlyAt: located.envelopeIndex)
        envelope = (path, db)
        return db
    }
}
