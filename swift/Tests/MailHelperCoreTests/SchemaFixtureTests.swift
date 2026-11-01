import Foundation
import SQLite3
import Testing
@testable import MailHelperCore

/// Gesammeltes Schema des Envelope Index aus `fixtures/schema/` (AMM-11). Zwei Formate:
/// - `envelope-index-<name>.sql`: SQL, z. B. die Ausgabe von `sqlite3 ... .schema`. Eine Zeile
///   `-- expect-missing: tabelle.spalte, ...` nennt die Spalten, die dort fehlen duerfen; ohne sie
///   muss das Schema kompatibel sein.
/// - `envelope-index-<name>.txt`: die unveraenderte Ausgabe von `doctor --schema`. Erste Zeile ist der
///   Fingerabdruck, Zeilen ohne `CREATE ` sind die gemeldeten fehlenden Spalten, und genau die erwartet
///   der Test auch.
struct CollectedSchema {
    let sql: String
    let expectedMissing: [String]

    static let directory = "fixtures/schema"
    static let prefix = "envelope-index-"

    /// Dateinamen aller gesammelten Schemas, sortiert. Wirft nicht, weil `@Test(arguments:)` es nicht darf;
    /// dass mindestens das macOS-27-Schema gefunden wird, prueft ein eigener Test.
    static func fileNames() -> [String] {
        guard let root = try? FixtureBuilder.repoRoot(),
              let names = try? FileManager.default.contentsOfDirectory(atPath: root.appending(path: directory).path)
        else { return [] }
        return names.filter { $0.hasPrefix(prefix) && ($0.hasSuffix(".sql") || $0.hasSuffix(".txt")) }.sorted()
    }

    static func load(_ name: String) throws -> CollectedSchema {
        let url = try FixtureBuilder.repoRoot().appending(path: directory).appending(path: name)
        let text = try String(contentsOf: url, encoding: .utf8)
        return name.hasSuffix(".txt") ? try parseDoctorOutput(text) : parseSQL(text)
    }

    static func parseSQL(_ text: String) -> CollectedSchema {
        let marker = "-- expect-missing:"
        var missing: [String] = []
        for line in text.split(separator: "\n") where line.hasPrefix(marker) {
            missing += line.dropFirst(marker.count).split(separator: ",")
                .map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
        }
        return CollectedSchema(sql: text, expectedMissing: missing)
    }

    static func parseDoctorOutput(_ text: String) throws -> CollectedSchema {
        let lines = text.split(separator: "\n").map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
        guard let first = lines.first, first.hasPrefix("sha256:") else {
            throw FixtureError(description: "doctor --schema output must start with the sha256 fingerprint")
        }
        let creates = lines.dropFirst().filter { $0.hasPrefix("CREATE ") }
        let missing = lines.dropFirst().filter { !$0.hasPrefix("CREATE ") }
        return CollectedSchema(sql: creates.map { $0 + ";" }.joined(separator: "\n"), expectedMissing: missing)
    }

    /// Legt eine leere Datenbank mit diesem Schema an. Anweisung fuer Anweisung: `CREATE TABLE sqlite_*`
    /// (aus `.schema`) ist reserviert und wird uebersprungen, ebenso Indizes, Trigger und Views, die sich
    /// ohne Mails eigene Funktionen nicht anlegen lassen. Eine Tabelle, die scheitert, ist ein Fehler.
    func materialize(at path: String) throws {
        var db: OpaquePointer?
        guard sqlite3_open_v2(path, &db, SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE, nil) == SQLITE_OK else {
            sqlite3_close(db)
            throw FixtureError(description: "sqlite open \(path)")
        }
        defer { sqlite3_close(db) }
        try sql.withCString { start in
            var cursor: UnsafePointer<CChar>? = start
            while let current = cursor, current.pointee != 0 {
                var stmt: OpaquePointer?
                var tail: UnsafePointer<CChar>?
                let rc = sqlite3_prepare_v2(db, current, -1, &stmt, &tail)
                defer { sqlite3_finalize(stmt) }
                let length = current.distance(to: tail ?? current)
                let text = String(decoding: UnsafeRawBufferPointer(start: current, count: length), as: UTF8.self)
                    .trimmingCharacters(in: .whitespacesAndNewlines)
                cursor = tail
                // Leere Reste (Kommentare, Leerraum) ergeben kein Statement.
                guard stmt != nil || rc != SQLITE_OK else { continue }
                let isTable = text.uppercased().hasPrefix("CREATE TABLE")
                if text.hasPrefix("CREATE TABLE sqlite_") { continue }
                if rc == SQLITE_OK, sqlite3_step(stmt) == SQLITE_DONE { continue }
                if isTable {
                    throw FixtureError(description: "sqlite: \(String(cString: sqlite3_errmsg(db))) in \(text.prefix(80))")
                }
                // Kein Fortschritt moeglich: der Rest ist nicht zu parsen.
                if tail == nil || tail == current { break }
            }
        }
    }
}

@Suite struct SchemaFixtureTests {
    @Test func collectedSchemasAreFound() {
        #expect(CollectedSchema.fileNames().contains("envelope-index-macos27.sql"))
    }

    /// Die Spaltenpruefung des Helpers gegen jedes gesammelte Schema. Ein neues Schema braucht nur eine
    /// Datei unter fixtures/schema/, keine Codeaenderung.
    @Test(arguments: CollectedSchema.fileNames())
    func columnCheckMatchesExpectation(_ name: String) throws {
        let schema = try CollectedSchema.load(name)
        let report = try check(schema)
        #expect(report.missing == schema.expectedMissing, "\(name)")
        #expect(report.compatible == schema.expectedMissing.isEmpty, "\(name)")
        #expect(!report.ddl.isEmpty, "\(name)")
    }

    /// Das .txt-Format: `doctor --schema`-Ausgabe aus dem macOS-27-Schema, einmal vollstaendig und einmal
    /// ohne eine benoetigte Spalte.
    @Test func doctorOutputFormatRoundTrips() throws {
        let full = try check(CollectedSchema.load("envelope-index-macos27.sql"))
        let parsed = try CollectedSchema.parseDoctorOutput(doctorOutput(full))
        let parsedReport = try check(parsed)
        #expect(parsed.expectedMissing == [])
        #expect(parsedReport.compatible)

        let reduced = full.ddl.map { $0.hasPrefix("CREATE TABLE subjects ") ? "CREATE TABLE subjects (ROWID INTEGER PRIMARY KEY)" : $0 }
        let withoutColumn = try CollectedSchema.parseDoctorOutput(
            doctorOutput(SchemaReport(compatible: false, missing: ["subjects.subject"], fingerprint: full.fingerprint, ddl: reduced)))
        let reducedReport = try check(withoutColumn)
        #expect(withoutColumn.expectedMissing == ["subjects.subject"])
        #expect(reducedReport.missing == ["subjects.subject"])
    }

    @Test func doctorOutputWithoutFingerprintIsRejected() {
        #expect(throws: FixtureError.self) {
            try CollectedSchema.parseDoctorOutput("Full Disk Access is required to read the Mail database.\n")
        }
    }

    @Test func expectMissingDirectiveIsRead() {
        let s = CollectedSchema.parseSQL("-- expect-missing: messages.size, attachments.name\nCREATE TABLE t (a);\n")
        #expect(s.expectedMissing == ["messages.size", "attachments.name"])
    }

    /// Nachbau von `schemaLines` in src/cli/doctor.ts: Fingerabdruck, fehlende Spalten, CREATE-Zeilen.
    private func doctorOutput(_ r: SchemaReport) -> String {
        let creates = r.ddl.filter { $0.hasPrefix("CREATE ") }
            .map { $0.split(whereSeparator: \.isWhitespace).joined(separator: " ") }
        return ([r.fingerprint] + r.missing + creates).joined(separator: "\n") + "\n"
    }

    private func check(_ schema: CollectedSchema) throws -> SchemaReport {
        let dir = FileManager.default.temporaryDirectory.appending(path: "schema-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: dir) }
        let path = dir.appending(path: "Envelope Index")
        try schema.materialize(at: path.path)
        let db = try Database(readOnlyAt: path)
        return try Schema.check(db)
    }
}
