import CryptoKit
import Foundation

/// Ergebnis der Schemapruefung (Spec 5.3).
public struct SchemaReport: Codable, Equatable, Sendable {
    public let compatible: Bool
    public let missing: [String]
    public let fingerprint: String
}

enum Schema {
    /// Feste Liste benoetigter Spalten, exakt Spec 5.3.
    static let required: [(table: String, columns: [String])] = [
        ("messages", ["ROWID", "global_message_id", "conversation_id", "sender", "subject", "subject_prefix",
                      "date_received", "date_sent", "mailbox", "read", "flagged", "deleted", "size"]),
        ("message_global_data", ["ROWID", "message_id_header"]),
        ("mailboxes", ["ROWID", "url", "total_count", "unread_count"]),
        ("subjects", ["ROWID", "subject"]),
        ("addresses", ["ROWID", "address", "comment"]),
        ("recipients", ["message", "address", "type", "position"]),
        ("attachments", ["message", "name"]),
    ]

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
        return SchemaReport(compatible: missing.isEmpty, missing: missing, fingerprint: try fingerprint(db))
    }

    /// sqlite_*-Tabellen (sqlite_sequence, ANALYZE) sind ausgenommen, damit sie den Wert nie aendern.
    /// SHA-256 ueber die nach Tabellenname sortierten CREATE-TABLE-Anweisungen.
    static func fingerprint(_ db: Database) throws(HelperFailure) -> String {
        var statements: [String] = []
        try db.query("SELECT sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name") { row in
            if let s = row.text(0) { statements.append(s) }
        }
        let digest = SHA256.hash(data: Data(statements.joined(separator: "\n").utf8))
        return "sha256:" + digest.map { String(format: "%02x", $0) }.joined()
    }
}
