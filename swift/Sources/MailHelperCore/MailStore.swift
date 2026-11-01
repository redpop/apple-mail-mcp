import Foundation

/// Nicht thread-sicher: der Helper arbeitet seriell (eine Anfrage nach der anderen).
public final class MailStore {
    let config: MailStoreConfig
    /// Eine Envelope-Index-Verbindung pro Helper-Lebenszeit (Spec 5.2), lazy geoeffnet, samt ihrer
    /// Schemapruefung (Spec 5.3): einmal pro geoeffneter Datei, nicht pro Anfrage.
    private var envelope: (path: String, dev: dev_t, ino: ino_t, db: Database, schema: SchemaReport,
                           optional: Schema.OptionalColumns)?
    /// Nur "available"-Ergebnisse, geschluesselt nach der UUID-Menge der Mail-Konten.
    var accountNamesCache: (uuids: Set<String>, lookup: AccountNamesLookup)?

    private var locator: (name: String, locator: EmlxLocator)?

    /// Nur fuer Tests: laeuft in `search` zwischen Seitenabfrage und Zeilenaufbau (simuliert Mails Schreiben).
    var testHookAfterPageQuery: (() -> Void)?

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

    /// Verbindung fuer Lese-Kommandos. Fehlen benoetigte Spalten, scheitert jedes Lese-Kommando mit
    /// SCHEMA_UNSUPPORTED (Spec 5.3), auch wenn die konkrete Abfrage die Spalte nicht braucht.
    func envelopeDatabase() throws(HelperFailure) -> Database {
        try envelopeDatabaseWithColumns().db
    }

    /// Wie `envelopeDatabase`, dazu welche optionalen Spalten diese Datei hat.
    func envelopeDatabaseWithColumns() throws(HelperFailure) -> (db: Database, optional: Schema.OptionalColumns) {
        let e = try envelopeConnection()
        guard e.schema.compatible else { throw Schema.failure(e.schema) }
        return (e.db, e.optional)
    }

    /// Liefert die gecachte Verbindung samt Schemabericht oder oeffnet und prueft sie. Wirft nicht bei
    /// inkompatiblem Schema (probe meldet das als Zustand). Fehlschlaege werden nicht gecacht,
    /// so dass ein spaeter erteiltes Full Disk Access beim naechsten Aufruf greift.
    func envelopeConnection() throws(HelperFailure) -> (db: Database, schema: SchemaReport, optional: Schema.OptionalColumns) {
        let located = try MailRoot.locate(root: config.mailRoot)
        let path = located.envelopeIndex.path
        // Datei bei jeder Anfrage per stat pruefen: wird sie am selben Pfad neu angelegt (andere Inode),
        // liest die alte Verbindung nur die entlinkte Datei. Dann neu oeffnen und Kontonamen verwerfen.
        var st = stat()
        let statted = stat(path, &st) == 0
        if let e = envelope, e.path == path, statted, e.dev == st.st_dev, e.ino == st.st_ino { return (e.db, e.schema, e.optional) }
        envelope = nil
        accountNamesCache = nil
        let db = try Database(readOnlyAt: located.envelopeIndex)
        let schema = try Schema.check(db)
        let optional = try Schema.optionalColumns(db)
        // dev/ino vom Deskriptor der Pruefung vor dem Oeffnen (Database.identity), nicht erneut per stat am
        // Pfad: sonst koennte die Inode einer inzwischen ersetzten Datei an der alten Verbindung haengen.
        envelope = (path, db.identity.dev, db.identity.ino, db, schema, optional)
        return (db, schema, optional)
    }
}
