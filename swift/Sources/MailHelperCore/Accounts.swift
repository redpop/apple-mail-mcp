import Foundation

public struct AccountInfo: Codable, Equatable, Sendable {
    public let uuid: String
    public let description: String?
    public let username: String?
    /// Ob Mail fuer das Konto aktiviert ist (AMM-22). nil: unbestimmt, das Konto bleibt sichtbar.
    public let mailEnabled: Bool?

    public init(uuid: String, description: String?, username: String?, mailEnabled: Bool? = nil) {
        self.uuid = uuid
        self.description = description
        self.username = username
        self.mailEnabled = mailEnabled
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
            // Mail-Dataclass: ein eigener Fehlschlag laesst nur mailEnabled offen, die Namen bleiben.
            if parentColumns.isSubset(of: present) {
                let enabled = MailDataclass.enabled(db, marks: marks, uuids: uuids)
                found = found.map { AccountInfo(uuid: $0.uuid, description: $0.description, username: $0.username,
                                                mailEnabled: enabled[$0.uuid]) }
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

/// Ob Mail fuer ein Konto aktiviert ist (AMM-22), aus den aktivierten Dataclasses in Accounts4.
/// CoreData-Schema: Verknuepfungstabelle `Z_<a>ENABLEDDATACLASSES(Z_<a>ENABLEDACCOUNTS, Z_<d>ENABLEDDATACLASSES)`,
/// Entitaet <a> ist `Account`, Entitaet <d> ist `Dataclass` mit Tabelle `ZDATACLASS`; die Nummern stehen in
/// Z_PRIMARYKEY und werden geprueft, nicht angenommen. Fail-open: Jede Abweichung ergibt "unbestimmt".
enum MailDataclass {
    static let mail = "com.apple.Dataclass.Mail"

    static let prefix = "com.apple.Dataclass."

    /// Entitaetsnummer aus `Z_<n><suffix>` (1 bis 4 Ziffern), sonst nil. Tabellen- und Spaltennamen aus dem
    /// Schema werden nur in dieser Form ins SQL eingesetzt.
    static func entity(_ name: String, suffix: String) -> String? {
        guard name.hasPrefix("Z_"), name.hasSuffix(suffix) else { return nil }
        let digits = name.dropFirst(2).dropLast(suffix.count)
        guard (1...4).contains(digits.count), digits.allSatisfy({ ("0"..."9").contains($0) }) else { return nil }
        return String(digits)
    }

    /// Nur `com.apple.Dataclass.` plus 1 bis 80 Zeichen aus A-Z, a-z, 0-9 und Punkt.
    static func isIdentifier(_ s: String) -> Bool {
        guard s.hasPrefix(prefix) else { return false }
        let rest = s.unicodeScalars.dropFirst(prefix.unicodeScalars.count)
        return (1...80).contains(rest.count)
            && rest.allSatisfy { ("A"..."Z").contains($0) || ("a"..."z").contains($0) || ("0"..."9").contains($0) || $0 == "." }
    }

    struct Links: Equatable {
        let table: String
        let accountColumn: String
        let dataclassColumn: String
    }

    /// Je Konto-UUID true/false; fehlt ein Eintrag, ist es unbestimmt. Wirft nie.
    static func enabled(_ db: Database, marks: String, uuids: [String]) -> [String: Bool] {
        do {
            guard let links = try links(db) else { return [:] }
            // Z_PK und Elternkonto der gefragten Konten; das Elternkonto selbst muss kein Mail-Konto sein.
            var accounts: [(uuid: String, pk: Int64, parent: Int64?)] = []
            try db.query("SELECT ZIDENTIFIER, Z_PK, ZPARENTACCOUNT FROM ZACCOUNT WHERE ZIDENTIFIER IN (\(marks))",
                         uuids.map { SQLValue.text($0) }) { row in
                if let id = row.text(0), !row.isNull(1) {
                    accounts.append((id, row.int(1), row.isNull(2) ? nil : row.int(2)))
                }
            }
            let pks = Array(Set(accounts.flatMap { [$0.pk] + ($0.parent.map { [$0] } ?? []) })).sorted()
            if pks.isEmpty { return [:] }
            var states: [Int64: LinkState] = [:]
            let pkMarks = Array(repeating: "?", count: pks.count).joined(separator: ", ")
            // Namen kommen nur aus links(db) und passen auf die festen Muster oben; Werte sind gebunden.
            // LEFT JOIN: Eine Verknuepfung ohne Dataclass-Zeile zaehlt als nicht lesbar.
            let sql = "SELECT l.\(links.accountColumn), d.ZNAME FROM \(links.table) l "
                + "LEFT JOIN ZDATACLASS d ON d.Z_PK = l.\(links.dataclassColumn) WHERE l.\(links.accountColumn) IN (\(pkMarks))"
            try db.query(sql, pks.map { SQLValue.int($0) }) { row in
                var s = states[row.int(0)] ?? LinkState()
                s.add(name(row))
                states[row.int(0)] = s
            }
            var out: [String: Bool] = [:]
            for a in accounts {
                // Ohne eigene aktivierte Dataclasses gelten die des Elternkontos (IMAP unter iCloud oder Google).
                let s = states[a.pk] ?? a.parent.flatMap { states[$0] }
                if let v = s?.mailEnabled { out[a.uuid] = v }
            }
            return out
        } catch {
            return [:]
        }
    }

    /// Prueft Tabellen, Spalten und Entitaeten; nil bei jeder Abweichung.
    static func links(_ db: Database) throws(HelperFailure) -> Links? {
        var tables: [String] = []
        try db.query("SELECT name FROM sqlite_master WHERE type = 'table'") { row in
            if let n = row.text(0) { tables.append(n) }
        }
        let linkTables = tables.filter { entity($0, suffix: "ENABLEDDATACLASSES") != nil }
        guard linkTables.count == 1, let table = linkTables.first,
              let tableEnt = entity(table, suffix: "ENABLEDDATACLASSES"),
              tables.contains("ZDATACLASS"), tables.contains("Z_PRIMARYKEY") else { return nil }
        let cols = try columns(db, table)
        let acc = cols.compactMap { c in entity(c, suffix: "ENABLEDACCOUNTS").map { (c, $0) } }
        let dc = cols.compactMap { c in entity(c, suffix: "ENABLEDDATACLASSES").map { (c, $0) } }
        // Die Kontospalte traegt dieselbe Entitaetsnummer wie der Tabellenname.
        guard acc.count == 1, dc.count == 1, acc[0].1 == tableEnt,
              let accEnt = Int64(acc[0].1), let dcEnt = Int64(dc[0].1) else { return nil }
        guard try columns(db, "Z_PRIMARYKEY").isSuperset(of: ["Z_ENT", "Z_NAME"]),
              try columns(db, "ZDATACLASS").isSuperset(of: ["Z_PK", "ZNAME"]) else { return nil }
        var entities: [Int64: String] = [:]
        try db.query("SELECT Z_ENT, Z_NAME FROM Z_PRIMARYKEY WHERE Z_ENT IN (?, ?)", [.int(accEnt), .int(dcEnt)]) { row in
            if let n = row.text(1) { entities[row.int(0)] = n }
        }
        guard entities[accEnt] == "Account", entities[dcEnt] == "Dataclass" else { return nil }
        return Links(table: table, accountColumn: acc[0].0, dataclassColumn: dc[0].0)
    }

    private static func columns(_ db: Database, _ table: String) throws(HelperFailure) -> Set<String> {
        var out = Set<String>()
        // table ist ZDATACLASS, Z_PRIMARYKEY oder ein Name der Form Z_<n>ENABLEDDATACLASSES.
        try db.query("PRAGMA table_info(\(table))") { row in
            if let n = row.text(1) { out.insert(n) }
        }
        return out
    }

    /// ZNAME als Text oder als NSKeyedArchiver-bplist mit einem String als Wurzel; nil, wenn nicht lesbar
    /// oder keine Dataclass-Kennung.
    static func name(_ row: Row) -> String? {
        if row.isText(1) { return row.text(1).flatMap(accept) }
        return row.blob(1).flatMap(decodeArchivedString).flatMap(accept)
    }

    private static func accept(_ s: String) -> String? { isIdentifier(s) ? s : nil }

    /// Liest das Archiv nur als Plist, ohne NSKeyedUnarchiver und ohne Klassen. Die Wurzel-UID ist in Swift
    /// nicht lesbar; darum gilt nur die Form eines archivierten Strings: `$objects` ist genau
    /// `["$null", <String>]`, dann kann die Wurzel nur Index 1 sein.
    static func decodeArchivedString(_ data: Data) -> String? {
        guard data.starts(with: Array("bplist".utf8)),
              let plist = try? PropertyListSerialization.propertyList(from: data, options: [], format: nil),
              let dict = plist as? [String: Any],
              dict["$archiver"] as? String == "NSKeyedArchiver",
              let top = dict["$top"] as? [String: Any], top.count == 1, top["root"] != nil,
              let objects = dict["$objects"] as? [Any], objects.count == 2,
              objects[0] as? String == "$null" else { return nil }
        return objects[1] as? String
    }

    /// Aktivierte Dataclasses eines Kontos, soweit gelesen.
    struct LinkState {
        var hasMail = false
        var unreadable = false

        mutating func add(_ name: String?) {
            if name == MailDataclass.mail { hasMail = true } else if name == nil { unreadable = true }
        }

        /// Mail gefunden: true. Mail fehlt und alles war lesbar: false. Sonst unbestimmt.
        var mailEnabled: Bool? { hasMail ? true : (unreadable ? nil : false) }
    }
}
