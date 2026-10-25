import Foundation

/// Nicht thread-sicher: der Helper arbeitet seriell (eine Anfrage nach der anderen).
public final class MailStore {
    let config: MailStoreConfig
    /// Eine Envelope-Index-Verbindung pro Helper-Lebenszeit (Spec 5.2), lazy geoeffnet.
    private var envelope: (path: String, dev: dev_t, ino: ino_t, db: Database)?
    /// Nur "available"-Ergebnisse, geschluesselt nach der UUID-Menge der Mail-Konten.
    var accountNamesCache: (uuids: Set<String>, lookup: AccountNamesLookup)?

    private var locator: (name: String, locator: EmlxLocator)?

    /// Ein Locator je Mail-Verzeichnis `V<n>`; sein Store-UUID-Cache lebt so lange wie der Helper.
    func emlxLocator() throws(HelperFailure) -> EmlxLocator {
        let located = try MailRoot.locate(root: config.mailRoot)
        if let l = locator, l.name == located.name { return l.locator }
        let l = EmlxLocator(versionDir: config.mailRoot.appending(path: located.name))
        locator = (located.name, l)
        return l
    }

    public init(config: MailStoreConfig) {
        self.config = config
    }

    /// Liefert die gecachte Verbindung oder oeffnet sie. Fehlschlaege werden nicht gecacht,
    /// so dass ein spaeter erteiltes Full Disk Access beim naechsten Aufruf greift.
    func envelopeDatabase() throws(HelperFailure) -> Database {
        let located = try MailRoot.locate(root: config.mailRoot)
        let path = located.envelopeIndex.path
        // Datei bei jeder Anfrage per stat pruefen: wird sie am selben Pfad neu angelegt (andere Inode),
        // liest die alte Verbindung nur die entlinkte Datei. Dann neu oeffnen und Kontonamen verwerfen.
        var st = stat()
        let statted = stat(path, &st) == 0
        if let e = envelope, e.path == path, statted, e.dev == st.st_dev, e.ino == st.st_ino { return e.db }
        envelope = nil
        accountNamesCache = nil
        let db = try Database(readOnlyAt: located.envelopeIndex)
        // Nach dem Oeffnen erneut stat, damit dev/ino zur geoeffneten Datei passen.
        if stat(path, &st) == 0 { envelope = (path, st.st_dev, st.st_ino, db) }
        return db
    }
}
