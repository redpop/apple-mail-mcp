import Foundation

public struct AccountInfo: Codable, Equatable, Sendable {
    public let uuid: String
    public let description: String?
    public let username: String?

    public init(uuid: String, description: String?, username: String?) {
        self.uuid = uuid
        self.description = description
        self.username = username
    }
}

/// Ergebnis der einmaligen Accounts4-Abfrage (Spec 5.6). Wird im MailStore gecacht.
struct AccountNamesLookup: Sendable {
    var available: Bool
    var reason: String?
    var accounts: [AccountInfo]
    /// Mail-Konto-UUIDs ohne ZACCOUNT-Zeile (0, wenn nicht verfuegbar).
    var unmatched: Int

    static func unavailable(_ reason: String) -> AccountNamesLookup {
        AccountNamesLookup(available: false, reason: reason, accounts: [], unmatched: 0)
    }
}

enum Accounts {
    /// Feste Saetze, keine Pfade.
    static let notFound = "Accounts database not found"
    static let notReadable = "Accounts database not readable"
    static let badSchema = "Accounts database has an unexpected schema"
    /// probe ohne Zugriff auf Mail-Daten: die Kontodatenbank wurde gar nicht gelesen.
    static let notChecked = "Account names were not checked"

    static let requiredColumns: Set<String> = ["ZIDENTIFIER", "ZACCOUNTDESCRIPTION", "ZUSERNAME"]
    /// Optional: ohne sie gibt es keinen Rueckfall auf die Beschreibung des Elternkontos.
    static let parentColumns: Set<String> = ["Z_PK", "ZPARENTACCOUNT"]

    /// Die zwei festen Abfragen; nur die "?"-Liste haengt an der Zahl der UUIDs.
    /// Leere Beschreibung zaehlt als fehlend. Mit Elternkonto: dessen Beschreibung, nie dessen ZUSERNAME
    /// (IMAP-Konten unter Google oder iCloud haben oft keine eigene Beschreibung).
    static func query(marks: String, withParent: Bool) -> String {
        withParent
            ? "SELECT a.ZIDENTIFIER, COALESCE(NULLIF(a.ZACCOUNTDESCRIPTION, ''), NULLIF(p.ZACCOUNTDESCRIPTION, '')), a.ZUSERNAME "
                + "FROM ZACCOUNT a LEFT JOIN ZACCOUNT p ON p.Z_PK = a.ZPARENTACCOUNT WHERE a.ZIDENTIFIER IN (\(marks))"
            : "SELECT ZIDENTIFIER, NULLIF(ZACCOUNTDESCRIPTION, ''), ZUSERNAME FROM ZACCOUNT WHERE ZIDENTIFIER IN (\(marks))"
    }

    /// Oeffnet Accounts4 schreibgeschuetzt, fuehrt genau eine Datenabfrage aus und schliesst die Verbindung
    /// (die lokale `db` wird beim Verlassen der Funktion freigegeben). Wirft nie.
    static func lookup(at url: URL, uuids: [String]) -> AccountNamesLookup {
        let db: Database
        do { db = try Database(readOnlyAt: url) } catch {
            return .unavailable(error.code == .mailDataNotFound ? notFound : notReadable)
        }
        do {
            var present = Set<String>()
            // Feste Tabelle, keine Eingabe im Statement.
            try db.query("PRAGMA table_info(ZACCOUNT)") { row in
                if let n = row.text(1) { present.insert(n) }
            }
            guard requiredColumns.isSubset(of: present) else { return .unavailable(badSchema) }
            if uuids.isEmpty { return AccountNamesLookup(available: true, reason: nil, accounts: [], unmatched: 0) }
            // Nur "?"-Platzhalter werden zusammengesetzt, die Werte sind gebunden.
            let marks = Array(repeating: "?", count: uuids.count).joined(separator: ", ")
            var found: [AccountInfo] = []
            try db.query(query(marks: marks, withParent: parentColumns.isSubset(of: present)),
                         uuids.map { SQLValue.text($0) }) { row in
                if let id = row.text(0) { found.append(AccountInfo(uuid: id, description: row.text(1), username: row.text(2))) }
            }
            found.sort { $0.uuid < $1.uuid }
            let matched = Set(found.map(\.uuid))
            return AccountNamesLookup(available: true, reason: nil, accounts: found,
                                      unmatched: uuids.filter { !matched.contains($0) }.count)
        } catch {
            // Kaputte Datei o.ae.: nie ein Fehler fuer den Aufrufer.
            return .unavailable(error.code == .databaseBusy ? notReadable : badSchema)
        }
    }
}
