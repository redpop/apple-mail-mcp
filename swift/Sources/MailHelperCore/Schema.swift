import CryptoKit
import Foundation

/// Ergebnis der Schemapruefung (Spec 5.3).
public struct SchemaReport: Codable, Equatable, Sendable {
    public let compatible: Bool
    public let missing: [String]
    public let fingerprint: String
    /// Ob die Kategoriespalten von Mail da sind (`message_global_data.model_category` und
    /// `model_high_impact`, AMM-19). Ohne sie scheitert der Filter `category` mit CATEGORY_UNSUPPORTED.
    public let categories: Bool
    /// Die CREATE-TABLE-Anweisungen, ueber die der Fingerabdruck laeuft (nur Struktur, keine Daten).
    /// Node zeigt sie nur bei `doctor --schema` (Spec 14.5).
    public let ddl: [String]
}

enum Schema {
    /// Feste Liste benoetigter Spalten, exakt Spec 5.3.
    static let required: [(table: String, columns: [String])] = [
        ("messages", ["ROWID", "global_message_id", "conversation_id", "sender", "subject", "subject_prefix",
                      "date_received", "date_sent", "mailbox", "read", "flagged", "deleted", "size"]),
        ("message_global_data", ["ROWID"]),
        ("mailboxes", ["ROWID", "url", "total_count", "unread_count"]),
        ("subjects", ["ROWID", "subject"]),
        ("addresses", ["ROWID", "address", "comment"]),
        ("recipients", ["message", "address", "type", "position"]),
        ("attachments", ["message", "name"]),
    ]

    /// Spalten, die nicht jede Mail-Version hat. Fehlen sie, bleibt das Schema kompatibel und die Abfragen
    /// liefern NULL. macOS 15 (Mail 16.0) hat message_id_header nicht (Schema-Probe, AMM-11).
    /// Die Kategoriespalten (AMM-19): `model_category` und `model_high_impact` aus dem Modell, dazu die
    /// Absender-Uebersteuerung in `business_addresses` und `business_categories`. Fehlt eine
    /// Uebersteuerungstabelle, gibt es keine Uebersteuerung; fehlt eine Modellspalte, gibt es keine Kategorien.
    /// Fehlt `read_later_date`, haben Zeilen keinen Erinnerungstermin und Eingaenge keine faelligen Erinnerungen.
    struct OptionalColumns: Equatable, Sendable {
        var messageIdHeader: Bool
        var modelCategory: Bool = false
        var addressCategory: Bool = false
        var businessCategory: Bool = false
        /// message_global_data.read_later_date ("Erinnern", AMM-20); ohne sie gibt es keine Erinnerungen.
        var readLater: Bool = false
        /// attachments.attachment_id (MIME-Teilnummer); ohne sie gilt kein Anhang als eigene Datei abgelegt.
        var attachmentId: Bool = false
    }

    static func optionalColumns(_ db: Database) throws(HelperFailure) -> OptionalColumns {
        // Tabellennamen aus fester Liste, nie aus Eingaben.
        func columns(_ table: String) throws(HelperFailure) -> Set<String> {
            var present = Set<String>()
            try db.query("PRAGMA table_info(\(table))") { row in
                if let name = row.text(1) { present.insert(name) }
            }
            return present
        }
        let global = try columns("message_global_data")
        let addresses = try columns("business_addresses")
        let businesses = try columns("business_categories")
        let attachments = try columns("attachments")
        let address = addresses.isSuperset(of: ["address", "business", "category"])
        return OptionalColumns(
            messageIdHeader: global.contains("message_id_header"),
            modelCategory: global.isSuperset(of: ["model_category", "model_high_impact"]),
            addressCategory: address,
            // business_categories wird nur ueber business_addresses.business erreicht.
            businessCategory: address && businesses.isSuperset(of: ["business", "category"]),
            readLater: global.contains("read_later_date"),
            attachmentId: attachments.contains("attachment_id"))
    }

    static func check(_ db: Database) throws(HelperFailure) -> SchemaReport {
        var missing: [String] = []
        for (table, columns) in required {
            var present = Set<String>()
            // Tabellenname stammt aus der festen Liste oben, nie aus Eingaben.
            try db.query("PRAGMA table_info(\(table))") { row in
                if let name = row.text(1) { present.insert(name) }
            }
            for c in columns where !present.contains(c) { missing.append("\(table).\(c)") }
        }
        let ddl = try createStatements(db)
        let categories = try optionalColumns(db).modelCategory
        return SchemaReport(compatible: missing.isEmpty, missing: missing, fingerprint: fingerprint(ddl),
                            categories: categories, ddl: ddl)
    }

    /// Fester Satz fuer SCHEMA_UNSUPPORTED: nur Tabellen- und Spaltennamen, nie Werte.
    static func failure(_ report: SchemaReport) -> HelperFailure {
        HelperFailure(code: .schemaUnsupported, message: "Missing columns: \(report.missing.joined(separator: ", "))")
    }

    /// Die nach Tabellenname sortierten CREATE-TABLE-Anweisungen. sqlite_*-Tabellen (sqlite_sequence,
    /// ANALYZE) sind ausgenommen, damit sie den Fingerabdruck nie aendern.
    static func createStatements(_ db: Database) throws(HelperFailure) -> [String] {
        var statements: [String] = []
        try db.query("SELECT sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name") { row in
            if let s = row.text(0) { statements.append(s) }
        }
        return statements
    }

    /// SHA-256 ueber die Anweisungen, mit Zeilenumbruch verbunden.
    static func fingerprint(_ statements: [String]) -> String {
        let digest = SHA256.hash(data: Data(statements.joined(separator: "\n").utf8))
        return "sha256:" + digest.map { String(format: "%02x", $0) }.joined()
    }
}
