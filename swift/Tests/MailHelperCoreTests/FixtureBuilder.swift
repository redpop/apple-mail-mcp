import Foundation
import SQLite3
import MailHelperCore

// Abbild von fixtures/seed.json.
struct Seed: Codable, Sendable {
    struct Account: Codable, Sendable {
        let name: String
        let uuid: String
        let type: String
        let description: String
        let username: String
        let inAccounts4: Bool
    }
    struct Mailbox: Codable, Sendable {
        let id: Int64
        let name: String
        let account: String
        let url: String
        let total: Int64
        let unread: Int64
        let stores: [String]
    }
    struct Address: Codable, Sendable {
        let address: String
        let comment: String
    }
    struct Recipient: Codable, Sendable {
        let type: Int
        let address: String
        let comment: String
    }
    struct Message: Codable, Sendable {
        let name: String
        let gid: Int64
        let rowid: Int64
        let mailbox: String
        let subjectPrefix: String
        let subject: String
        let sender: Address?
        let recipients: [Recipient]
        let dateReceived: Int64
        let dateSent: Int64
        let read: Bool
        let flagged: Bool
        let deleted: Bool
        let conversationId: Int64
        let messageIdHeader: String?
        let attachments: [String]
        let file: String          // "full" | "partial" | "none"
        let storeIndex: Int
        let senderStored: String?   // nur bei sender == nil: "zero" | "null" | "dangling"
        let emlx: String?
        let body: String
    }
    let accounts: [Account]
    let mailboxes: [Mailbox]
    let messages: [Message]
}

struct FixtureError: Error, CustomStringConvertible {
    let description: String
}

/// Loescht das Fixture-Verzeichnis, sobald die letzte Kopie des Fixtures freigegeben ist.
final class FixtureCleanup: Sendable {
    let directory: URL
    init(directory: URL) { self.directory = directory }
    deinit { try? FileManager.default.removeItem(at: directory) }
}

struct Fixture: Sendable {
    let mailRoot: URL
    let accountsDB: URL
    let seed: Seed
    /// Haelt das temporaere Verzeichnis am Leben; Fixtures muessen so lange leben wie ihre MailStores.
    let cleanup: FixtureCleanup

    var config: MailStoreConfig { MailStoreConfig(mailRoot: mailRoot, accountsDB: accountsDB) }
    var envelopeIndex: URL { mailRoot.appending(path: "V10/MailData/Envelope Index") }

    /// gid der ersten Mail mit diesem Namen (Kopien teilen Name und gid).
    func gid(named name: String) -> Int64 {
        guard let m = seed.messages.first(where: { $0.name == name }) else {
            preconditionFailure("Seed hat keine Mail namens \(name)")
        }
        return m.gid
    }

    func mailboxId(named name: String) -> Int64 {
        guard let m = seed.mailboxes.first(where: { $0.name == name }) else {
            preconditionFailure("Seed hat keine Mailbox namens \(name)")
        }
        return m.id
    }

    var allMailboxIds: [Int64] { seed.mailboxes.map(\.id) }

    /// gids mit mindestens einer nicht geloeschten Kopie (deleted = 0), in irgendeiner Mailbox.
    var visibleGids: Set<Int64> {
        Set(seed.messages.filter { !$0.deleted }.map(\.gid))
    }

    func accountUUID(_ name: String) -> String {
        guard let a = seed.accounts.first(where: { $0.name == name }) else {
            preconditionFailure("Seed hat kein Konto namens \(name)")
        }
        return a.uuid
    }

    func urlOfMessage(rowid: Int64) -> String {
        guard let m = seed.messages.first(where: { $0.rowid == rowid }),
              let box = seed.mailboxes.first(where: { $0.name == m.mailbox }) else {
            preconditionFailure("Seed hat keine Mail mit ROWID \(rowid)")
        }
        return box.url
    }

    /// Erwarteter Pfad der .emlx (Orakel fuer den EmlxLocator). Rein aus dem Seed
    /// berechnet, ohne das Dateisystem zu lesen. Bei `file == "none"` der Pfad der
    /// vollstaendigen Datei, die nicht existiert.
    func expectedEmlxPath(rowid: Int64) -> URL {
        guard let m = seed.messages.first(where: { $0.rowid == rowid }),
              let box = seed.mailboxes.first(where: { $0.name == m.mailbox }) else {
            preconditionFailure("Seed hat keine Mail mit ROWID \(rowid)")
        }
        // Unabhaengig vom Builder (andere Zerlegung, andere Ziffernlogik), aus festen Regeln:
        // V10/<konto>/<seg>.mbox/.../<store>/Data/<ziffern>/Messages/<rowid>[.partial].emlx
        let comps = URLComponents(string: box.url)!
        var rel = "V10/" + comps.host!
        for seg in comps.path.split(separator: "/") {
            rel += "/" + seg.removingPercentEncoding! + ".mbox"
        }
        rel += "/" + box.stores[m.storeIndex] + "/Data"
        let q = String(rowid / 1000)
        if q != "0" { for ch in q.reversed() { rel += "/" + String(ch) } }
        rel += "/Messages/" + String(rowid) + (m.file == "partial" ? ".partial.emlx" : ".emlx")
        return mailRoot.appending(path: rel)
    }

    /// Fuehrt eine Abfrage mit einer Ganzzahl-Ergebnisspalte gegen den Envelope Index aus.
    func count(_ sql: String) throws -> Int64 {
        let db = try SQLiteHandle(path: envelopeIndex.path, readOnly: true)
        return try db.scalarInt(sql)
    }
}

// MARK: - SQLite-Hilfe

private let sqliteTransient = unsafeBitCast(-1, to: sqlite3_destructor_type.self)

enum SQLValue {
    case int(Int64)
    case text(String)
    case null
}

final class SQLiteHandle {
    private var db: OpaquePointer?

    init(path: String, readOnly: Bool = false) throws {
        let flags = readOnly ? SQLITE_OPEN_READONLY : (SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE)
        guard sqlite3_open_v2(path, &db, flags, nil) == SQLITE_OK else {
            let msg = db.map { String(cString: sqlite3_errmsg($0)) } ?? "open failed"
            sqlite3_close(db)
            throw FixtureError(description: "sqlite open \(path): \(msg)")
        }
    }

    deinit { sqlite3_close(db) }

    private var lastError: String { String(cString: sqlite3_errmsg(db)) }

    func exec(_ sql: String) throws {
        var err: UnsafeMutablePointer<CChar>?
        guard sqlite3_exec(db, sql, nil, nil, &err) == SQLITE_OK else {
            let msg = err.map { String(cString: $0) } ?? "unknown"
            sqlite3_free(err)
            throw FixtureError(description: "sqlite exec: \(msg)")
        }
    }

    func run(_ sql: String, _ params: [SQLValue] = []) throws {
        var stmt: OpaquePointer?
        guard sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK else {
            throw FixtureError(description: "sqlite prepare: \(lastError) in \(sql)")
        }
        defer { sqlite3_finalize(stmt) }
        for (i, p) in params.enumerated() {
            let idx = Int32(i + 1)
            switch p {
            case .int(let v): sqlite3_bind_int64(stmt, idx, v)
            case .text(let s): sqlite3_bind_text(stmt, idx, s, -1, sqliteTransient)
            case .null: sqlite3_bind_null(stmt, idx)
            }
        }
        guard sqlite3_step(stmt) == SQLITE_DONE else {
            throw FixtureError(description: "sqlite step: \(lastError) in \(sql)")
        }
    }

    /// Erste Spalte aller Ergebniszeilen als Text.
    func texts(_ sql: String) throws -> [String] {
        var stmt: OpaquePointer?
        guard sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK else {
            throw FixtureError(description: "sqlite prepare: \(lastError) in \(sql)")
        }
        defer { sqlite3_finalize(stmt) }
        var out: [String] = []
        while sqlite3_step(stmt) == SQLITE_ROW {
            if let p = sqlite3_column_text(stmt, 0) { out.append(String(cString: p)) }
        }
        return out
    }

    /// Alle Ergebniszeilen, je Spalte als Text, NULL als nil.
    func rows(_ sql: String) throws -> [[String?]] {
        var stmt: OpaquePointer?
        guard sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK else {
            throw FixtureError(description: "sqlite prepare: \(lastError) in \(sql)")
        }
        defer { sqlite3_finalize(stmt) }
        var out: [[String?]] = []
        let n = sqlite3_column_count(stmt)
        while sqlite3_step(stmt) == SQLITE_ROW {
            out.append((0..<n).map { i in sqlite3_column_text(stmt, i).map { String(cString: $0) } })
        }
        return out
    }

    func lastInsertRowid() -> Int64 { sqlite3_last_insert_rowid(db) }

    func scalarInt(_ sql: String) throws -> Int64 {
        var stmt: OpaquePointer?
        guard sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK else {
            throw FixtureError(description: "sqlite prepare: \(lastError) in \(sql)")
        }
        defer { sqlite3_finalize(stmt) }
        guard sqlite3_step(stmt) == SQLITE_ROW else {
            throw FixtureError(description: "sqlite: keine Zeile fuer \(sql)")
        }
        return sqlite3_column_int64(stmt, 0)
    }
}

// MARK: - Builder

enum FixtureBuilder {
    /// Wurzel des Repos: das Verzeichnis mit package.json, ausgehend von dieser Datei.
    static func repoRoot(from file: String = #filePath) throws -> URL {
        var dir = URL(fileURLWithPath: file).deletingLastPathComponent()
        while dir.path != "/" {
            if FileManager.default.fileExists(atPath: dir.appending(path: "package.json").path) { return dir }
            dir = dir.deletingLastPathComponent()
        }
        throw FixtureError(description: "Repo-Wurzel (package.json) nicht gefunden")
    }

    /// Ziffernverzeichnisse nach Spec 6: q = rowid / 1000; q == 0 -> keine Ebene,
    /// sonst die Dezimalziffern von q in umgekehrter Reihenfolge.
    static func digitDirs(rowid: Int64) -> [String] {
        let q = rowid / 1000
        if q == 0 { return [] }
        return String(q).reversed().map { String($0) }
    }

    /// `<root>/V10/<konto-uuid>/<seg1>.mbox/<seg2>.mbox...` aus der Mailbox-URL; Segmente percent-dekodiert.
    static func mboxDirectory(root: URL, url: String) -> URL {
        let rest = url.drop(while: { $0 != ":" }).dropFirst(3)   // nach "scheme://"
        let parts = rest.split(separator: "/", omittingEmptySubsequences: false).map(String.init)
        var dir = root.appending(path: "V10").appending(path: parts[0])
        for seg in parts.dropFirst() {
            dir.append(path: (seg.removingPercentEncoding ?? seg) + ".mbox")
        }
        return dir
    }

    static func loadSeed() throws -> Seed {
        let url = try repoRoot().appending(path: "fixtures/seed.json")
        return try JSONDecoder().decode(Seed.self, from: Data(contentsOf: url))
    }

    /// Form der Massenzeilen: `uniform` ist die kleine, gleichfoermige Variante (500 Betreffs, 300 Absender,
    /// 400 Empfaenger); `varied` naehert die Verhaeltnisse einer echten Ablage an (30000 Betreffs,
    /// 6000 Adressen, Umlaute, zweite Kopien, mehrere Empfaenger, einige Anhaenge).
    /// `realSize` bildet die Verteilung der Ablage des Maintainers nach (2026-10-26: 238642 Zeilen in
    /// messages, 120904 gids, rund 27700 Zeilen in attachments, 190 von 221 Mailboxen erlaubt):
    /// `extraMessages` ist dort die Zahl der gids, jede hat im Mittel zwei Kopien in 200 zusaetzlichen
    /// Mailboxen (`realSizeMailboxes`, davon `realSizeExcluded` nicht erlaubt).
    enum BulkShape { case uniform, varied, realSize }

    static let realSizeMailboxes: ClosedRange<Int64> = 1000...1199
    static let realSizeExcluded: ClosedRange<Int64> = 1170...1199

    /// Erlaubte Mailboxen fuer `realSize`: alle des Seeds und die zusaetzlichen ohne `realSizeExcluded`.
    static func realSizeAllowed(_ f: Fixture) -> [Int64] {
        f.allMailboxIds + realSizeMailboxes.filter { !realSizeExcluded.contains($0) }
    }

    /// `extraSeedMessages` haengt Mails an den Seed an (nur fuer einzelne Tests, ohne seed.json und die
    /// Contract-Dateien zu veraendern).
    static func build(extraMessages: Int = 0, bulk: BulkShape = .uniform,
                      extraSeedMessages: [Seed.Message] = [],
                      dropping: (table: String, column: String)? = nil) throws -> Fixture {
        let root = try repoRoot()
        let base = try loadSeed()
        let seed = Seed(accounts: base.accounts, mailboxes: base.mailboxes, messages: base.messages + extraSeedMessages)
        let fm = FileManager.default

        let tmp = fm.temporaryDirectory.appending(path: "mail-fixture-\(UUID().uuidString)")
        let mailRoot = tmp.appending(path: "Mail")
        let accountsDir = tmp.appending(path: "Accounts")
        try fm.createDirectory(at: mailRoot.appending(path: "V10/MailData"), withIntermediateDirectories: true)
        try fm.createDirectory(at: accountsDir, withIntermediateDirectories: true)
        let fixture = Fixture(mailRoot: mailRoot,
                              accountsDB: accountsDir.appending(path: "Accounts4.sqlite"),
                              seed: seed,
                              cleanup: FixtureCleanup(directory: tmp))

        try buildEnvelopeIndex(fixture, root: root, extraMessages: extraMessages, bulk: bulk)
        if let d = dropping { try dropColumn(fixture, table: d.table, column: d.column) }
        try buildAccounts(fixture, root: root)
        try writeMailTree(fixture)
        return fixture
    }

    private static func buildEnvelopeIndex(_ f: Fixture, root: URL, extraMessages: Int, bulk: BulkShape) throws {
        let db = try SQLiteHandle(path: f.envelopeIndex.path)
        let ddl = try String(contentsOf: root.appending(path: "fixtures/schema/envelope-index-macos27.sql"), encoding: .utf8)
        try db.exec(ddl)
        try db.exec("BEGIN")

        for b in f.seed.mailboxes {
            try db.run("INSERT INTO mailboxes (ROWID, url, total_count, unread_count) VALUES (?, ?, ?, ?)",
                       [.int(b.id), .text(b.url), .int(b.total), .int(b.unread)])
        }

        var subjectIds: [String: Int64] = [:]
        var addressIds: [String: Int64] = [:]
        var seenGids: Set<Int64> = []

        func subjectId(_ s: String) throws -> Int64 {
            if let id = subjectIds[s] { return id }
            try db.run("INSERT INTO subjects (subject) VALUES (?)", [.text(s)])
            let id = db.lastInsertRowid()
            subjectIds[s] = id
            return id
        }
        func addressId(_ address: String, _ comment: String) throws -> Int64 {
            let key = address + "\u{0}" + comment
            if let id = addressIds[key] { return id }
            try db.run("INSERT INTO addresses (address, comment) VALUES (?, ?)", [.text(address), .text(comment)])
            let id = db.lastInsertRowid()
            addressIds[key] = id
            return id
        }

        for m in f.seed.messages {
            if seenGids.insert(m.gid).inserted {
                try db.run("INSERT INTO message_global_data (ROWID, message_id_header) VALUES (?, ?)",
                           [.int(m.gid), m.messageIdHeader.map { .text($0) } ?? .null])
            }
            let subj = try subjectId(m.subject)
            var sender: Int64 = 0
            if let s = m.sender {
                sender = try addressId(s.address, s.comment)
            } else if m.senderStored == "dangling" {
                sender = 9_999_999   // verweist auf keine Zeile in addresses
            }
            let senderValue: SQLValue = m.senderStored == "null" ? .null : .int(sender)
            let mailbox = f.mailboxId(named: m.mailbox)
            try db.run("""
                INSERT INTO messages (ROWID, global_message_id, sender, subject_prefix, subject,
                    date_sent, date_received, mailbox, read, flagged, deleted, conversation_id)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                [.int(m.rowid), .int(m.gid), senderValue, .text(m.subjectPrefix), .int(subj),
                 .int(m.dateSent), .int(m.dateReceived), .int(mailbox),
                 .int(m.read ? 1 : 0), .int(m.flagged ? 1 : 0), .int(m.deleted ? 1 : 0), .int(m.conversationId)])
            for (pos, r) in m.recipients.enumerated() {
                let a = try addressId(r.address, r.comment)
                try db.run("INSERT INTO recipients (message, address, type, position) VALUES (?, ?, ?, ?)",
                           [.int(m.rowid), .int(a), .int(Int64(r.type)), .int(Int64(pos))])
            }
            for (i, name) in m.attachments.enumerated() {
                try db.run("INSERT INTO attachments (message, attachment_id, name) VALUES (?, ?, ?)",
                           [.int(m.rowid), .text("\(i + 1)"), .text(name)])
            }
        }

        if extraMessages > 0, bulk == .varied {
            try insertVariedBulk(db, f, count: extraMessages)
        } else if extraMessages > 0, bulk == .realSize {
            try insertRealSizeBulk(db, count: extraMessages)
        } else if extraMessages > 0 {
            // Massenzeilen ohne Dateien, alle in INBOX; Datum faellt je Zeile um eine Sekunde.
            let inbox = f.mailboxId(named: "inbox")
            // Woerterbuecher mit Vielfalt: 500 Betreffs, 300 Absender, 400 Empfaenger, reihum vergeben.
            let subjects = try (0..<500).map { try subjectId("Massenmail Thema \($0)") }
            let senders = try (0..<300).map { try addressId("bulk\($0)@example.com", "Bulk Absender \($0)") }
            let rcpts = try (0..<400).map { try addressId("empfaenger\($0)@example.org", "Empfaenger \($0)") }
            let baseRowid: Int64 = 10_000_000
            let baseGid: Int64 = 5_000_000
            let baseDate: Int64 = 1_600_000_000
            for i in 0..<Int64(extraMessages) {
                try db.run("INSERT INTO message_global_data (ROWID, message_id_header) VALUES (?, ?)",
                           [.int(baseGid + i), .text("<bulk-\(i)@example.com>")])
                try db.run("""
                    INSERT INTO messages (ROWID, global_message_id, sender, subject_prefix, subject,
                        date_sent, date_received, mailbox, read, flagged, deleted, conversation_id)
                    VALUES (?, ?, ?, '', ?, ?, ?, ?, 1, 0, 0, 0)
                    """,
                    [.int(baseRowid + i), .int(baseGid + i), .int(senders[Int(i) % 300]), .int(subjects[Int(i) % 500]),
                     .int(baseDate + i), .int(baseDate + i), .int(inbox)])
                try db.run("INSERT INTO recipients (message, address, type, position) VALUES (?, ?, 0, 0)",
                           [.int(baseRowid + i), .int(rcpts[Int(i) % 400])])
            }
        }
        try db.exec("COMMIT")
    }

    /// Massenzeilen ohne Dateien in SQL erzeugt (rekursive CTE statt einzelner INSERTs, damit 50000 Zeilen
    /// schnell entstehen). Jede zweite Nachricht hat eine zweite Kopie in archiv2024, jede Zeile zwei
    /// Empfaenger (an, Kopie), jede zehnte einen Anhang, jede dritte ist ungelesen.
    private static func insertVariedBulk(_ db: SQLiteHandle, _ f: Fixture, count n: Int) throws {
        let subjectCount: Int64 = 30_000, senderCount: Int64 = 2_500, recipientCount: Int64 = 3_500
        let s0 = try db.scalarInt("SELECT coalesce(max(ROWID), 0) FROM subjects")
        let a0 = try db.scalarInt("SELECT coalesce(max(ROWID), 0) FROM addresses")
        let r0 = a0 + senderCount   // erste Empfaengeradresse ist r0 + 1
        let inbox = f.mailboxId(named: "inbox"), archive = f.mailboxId(named: "archiv2024")
        let baseRowid: Int64 = 10_000_000, copyRowid: Int64 = 11_000_000
        let baseGid: Int64 = 5_000_000, baseDate: Int64 = 1_600_000_000
        func seq(_ count: Int64) -> String {
            "WITH RECURSIVE seq(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM seq WHERE i + 1 < \(count)) "
        }
        try db.exec(seq(subjectCount) + """
            INSERT INTO subjects (ROWID, subject) SELECT \(s0) + 1 + i,
                CASE i % 5 WHEN 0 THEN 'Ihre Überweisung an die Hausverwaltung Straße Nr. ' || i
                WHEN 1 THEN 'Ärger mit der Lieferung vom Versandhändler, Vorgang ' || i
                ELSE 'Massenmail Thema ' || i || ': Neuigkeiten aus dem Verein und Termine' END FROM seq
            """)
        try db.exec(seq(senderCount) + """
            INSERT INTO addresses (ROWID, address, comment) SELECT \(a0) + 1 + i,
                CASE WHEN i % 4 = 0 THEN 'buelent' || i || '@example.com' ELSE 'bulk' || i || '@example.com' END,
                CASE WHEN i % 4 = 0 THEN 'Bülent Größe ' || i ELSE 'Bulk Absender ' || i END FROM seq
            """)
        try db.exec(seq(recipientCount) + """
            INSERT INTO addresses (ROWID, address, comment) SELECT \(r0) + 1 + i, 'empfaenger' || i || '@example.org',
                CASE WHEN i % 3 = 0 THEN 'Empfänger Jürgen ' || i ELSE 'Empfaenger ' || i END FROM seq
            """)
        let count = Int64(n)
        try db.exec(seq(count) + """
            INSERT INTO message_global_data (ROWID, message_id_header) SELECT \(baseGid) + i, '<bulk-' || i || '@example.com>' FROM seq
            """)
        try db.exec(seq(count) + """
            INSERT INTO messages (ROWID, global_message_id, sender, subject_prefix, subject,
                date_sent, date_received, mailbox, read, flagged, deleted, conversation_id)
            SELECT \(baseRowid) + i, \(baseGid) + i, \(a0) + 1 + i % \(senderCount), '', \(s0) + 1 + i % \(subjectCount),
                \(baseDate) + i, \(baseDate) + i, \(inbox), i % 3 <> 0, i % 50 = 0, 0, 0 FROM seq
            """)
        try db.exec(seq(count) + """
            INSERT INTO messages (ROWID, global_message_id, sender, subject_prefix, subject,
                date_sent, date_received, mailbox, read, flagged, deleted, conversation_id)
            SELECT \(copyRowid) + i, \(baseGid) + i, \(a0) + 1 + i % \(senderCount), '', \(s0) + 1 + i % \(subjectCount),
                \(baseDate) + i, \(baseDate) + i, \(archive), 1, 0, 0, 0 FROM seq WHERE i % 2 = 0
            """)
        try db.exec("""
            INSERT INTO recipients (message, address, type, position)
            SELECT ROWID, \(r0) + 1 + (ROWID % \(baseRowid)) % \(recipientCount), 0, 0 FROM messages WHERE ROWID >= \(baseRowid)
            UNION ALL
            SELECT ROWID, \(r0) + 1 + ((ROWID % \(baseRowid)) * 7 + 1) % \(recipientCount), 1, 1 FROM messages WHERE ROWID >= \(baseRowid)
            """)
        try db.exec(seq(count) + """
            INSERT INTO attachments (message, attachment_id, name) SELECT \(baseRowid) + i, '1', 'anhang-' || i || '.pdf'
            FROM seq WHERE i % 10 = 0
            """)
    }

    /// Massenzeilen in der Verteilung einer echten Ablage, ohne Dateien. Je gid i:
    /// - erste Kopie: 60 % in Mailbox 1000 (wie "Alle Nachrichten"), sonst verteilt auf 1001...1199;
    ///   jede 40. geloescht
    /// - zweite Kopie bei 90 % (i % 10 != 0), verteilt, jede 30. geloescht; dritte bei 10 % (i % 10 == 9)
    /// - Anhaenge: i % 32 == 3 an allen Kopien, i % 16 == 7 nur an der zweiten Kopie (die geloescht oder in
    ///   einer nicht erlaubten Mailbox liegen kann); 1 oder 2 Zeilen je Nachricht, im Mittel 1,8
    /// - jede siebte erste Kopie ungelesen, jede 50. markiert; Datum steigt mit i
    /// Ergibt bei 121000 gids rund 242000 Zeilen in messages und 26000 in attachments auf 14000 Nachrichten.
    private static func insertRealSizeBulk(_ db: SQLiteHandle, count n: Int) throws {
        let subjectCount: Int64 = 30_000, addressCount: Int64 = 6_000
        let s0 = try db.scalarInt("SELECT coalesce(max(ROWID), 0) FROM subjects")
        let a0 = try db.scalarInt("SELECT coalesce(max(ROWID), 0) FROM addresses")
        let first = realSizeMailboxes.lowerBound, spread = Int64(realSizeMailboxes.count - 1)
        let baseRowid: Int64 = 10_000_000, thirdRowid: Int64 = 13_000_000
        let baseGid: Int64 = 5_000_000, baseDate: Int64 = 1_600_000_000
        func seq(_ count: Int64) -> String {
            "WITH RECURSIVE seq(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM seq WHERE i + 1 < \(count)) "
        }
        let count = Int64(n)
        try db.exec(seq(Int64(realSizeMailboxes.count)) + """
            INSERT INTO mailboxes (ROWID, url) SELECT \(first) + i, 'imap://bulk.example.com/Ordner%20' || i FROM seq
            """)
        try db.exec(seq(subjectCount) + """
            INSERT INTO subjects (ROWID, subject) SELECT \(s0) + 1 + i,
                CASE i % 3 WHEN 0 THEN 'Rechnung Nr. ' || i || ' für Straße ' || (i % 90)
                ELSE 'Thema ' || i || ': Neuigkeiten und Termine' END FROM seq
            """)
        try db.exec(seq(addressCount) + """
            INSERT INTO addresses (ROWID, address, comment) SELECT \(a0) + 1 + i, 'person' || i || '@example.com',
                CASE WHEN i % 5 = 0 THEN 'Jürgen Größe ' || i ELSE 'Person ' || i END FROM seq
            """)
        try db.exec(seq(count) + """
            INSERT INTO message_global_data (ROWID, message_id_header) SELECT \(baseGid) + i, '<real-' || i || '@example.com>' FROM seq
            """)
        let columns = """
            INSERT INTO messages (ROWID, global_message_id, sender, subject_prefix, subject,
                date_sent, date_received, mailbox, read, flagged, deleted, conversation_id)
            """
        let common = "\(baseGid) + i, \(a0) + 1 + i % \(addressCount), '', \(s0) + 1 + i % \(subjectCount), \(baseDate) + i * 600"
        try db.exec(seq(count) + columns + """
            SELECT \(baseRowid) + 2 * i, \(common), \(baseDate) + i * 600,
                CASE WHEN i % 5 < 3 THEN \(first) ELSE \(first) + 1 + (i * 7919) % \(spread) END,
                i % 7 <> 0, i % 50 = 0, i % 40 = 0, 0 FROM seq
            """)
        try db.exec(seq(count) + columns + """
            SELECT \(baseRowid) + 2 * i + 1, \(common), \(baseDate) + i * 600 + 1,
                \(first) + 1 + (i * 104729) % \(spread), 1, 0, i % 30 = 0, 0 FROM seq WHERE i % 10 <> 0
            """)
        try db.exec(seq(count) + columns + """
            SELECT \(thirdRowid) + i, \(common), \(baseDate) + i * 600,
                \(first) + 1 + (i * 1299709) % \(spread), 1, 0, 0, 0 FROM seq WHERE i % 10 = 9
            """)
        try db.exec("""
            INSERT INTO recipients (message, address, type, position)
            SELECT ROWID, \(a0) + 1 + (global_message_id * 7 + 1) % \(addressCount), 0, 0 FROM messages WHERE ROWID >= \(baseRowid)
            """)
        try db.exec("""
            WITH k(n) AS (VALUES (1), (2))
            INSERT INTO attachments (message, attachment_id, name)
            SELECT m.ROWID, k.n, 'anhang-' || m.ROWID || '-' || k.n || '.pdf' FROM messages m, k
            WHERE m.ROWID >= \(baseRowid)
                AND ((m.global_message_id - \(baseGid)) % 32 = 3
                    OR ((m.global_message_id - \(baseGid)) % 16 = 7 AND m.ROWID < \(thirdRowid) AND m.ROWID % 2 = 1))
                AND (k.n = 1 OR m.ROWID % 5 <> 0)
            """)
    }

    /// Entfernt eine Spalte nachtraeglich (fuer Schema-Kompatibilitaetstests).
    private static func dropColumn(_ f: Fixture, table: String, column: String) throws {
        let db = try SQLiteHandle(path: f.envelopeIndex.path)
        // SQLite verweigert DROP COLUMN, solange ein Index die Spalte nennt: diese Indizes vorher entfernen.
        let indexes = try db.texts("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = '\(table)' AND sql LIKE '%\(column)%'")
        for name in indexes { try db.exec("DROP INDEX \"\(name)\"") }
        try db.exec("ALTER TABLE \(table) DROP COLUMN \(column)")
    }

    private static func buildAccounts(_ f: Fixture, root: URL) throws {
        let db = try SQLiteHandle(path: f.accountsDB.path)
        let ddl = try String(contentsOf: root.appending(path: "fixtures/schema/accounts4-min.sql"), encoding: .utf8)
        try db.exec(ddl)
        var pk: Int64 = 1
        for a in f.seed.accounts where a.inAccounts4 {
            let bundle = a.type == "imap" ? "com.apple.mail" : "com.apple.calendar"
            try db.run("INSERT INTO ZACCOUNT (Z_PK, ZIDENTIFIER, ZACCOUNTDESCRIPTION, ZUSERNAME, ZOWNINGBUNDLEID) VALUES (?, ?, ?, ?, ?)",
                       [.int(pk), .text(a.uuid), .text(a.description), .text(a.username), .text(bundle)])
            pk += 1
        }
    }

    private static func writeMailTree(_ f: Fixture) throws {
        let fm = FileManager.default
        // Info.plist fuer jede .mbox entlang der Pfade, auch fuer Elternordner ohne Nachrichten.
        for b in f.seed.mailboxes {
            let leaf = mboxDirectory(root: f.mailRoot, url: b.url)
            var dir = leaf
            var chain: [URL] = []
            let accountDir = f.mailRoot.appending(path: "V10").appending(path: f.accountUUID(b.account))
            while dir.pathComponents.count > accountDir.pathComponents.count {
                chain.append(dir)
                dir = dir.deletingLastPathComponent()
            }
            for d in chain {
                try fm.createDirectory(at: d, withIntermediateDirectories: true)
                let name = String(d.lastPathComponent.dropLast(".mbox".count))
                let plist: [String: Any] = ["MailboxID": "\(b.account)-\(name)", "MailboxName": name]
                let data = try PropertyListSerialization.data(fromPropertyList: plist, format: .xml, options: 0)
                try data.write(to: d.appending(path: "Info.plist"))
            }
            // Store-Verzeichnisse mit Data/, auch wenn eines davon keine Datei bekommt.
            for s in b.stores {
                try fm.createDirectory(at: leaf.appending(path: s).appending(path: "Data"), withIntermediateDirectories: true)
            }
        }
        for m in f.seed.messages where m.file != "none" {
            let path = writerPath(f, m)
            try fm.createDirectory(at: path.deletingLastPathComponent(), withIntermediateDirectories: true)
            try emlxData(for: m).write(to: path)
        }
    }

    /// Eigene Pfadroutine des Builders (nicht das Orakel `expectedEmlxPath`).
    private static func writerPath(_ f: Fixture, _ m: Seed.Message) -> URL {
        let box = f.seed.mailboxes.first { $0.name == m.mailbox }!
        var dir = mboxDirectory(root: f.mailRoot, url: box.url)
        dir.append(path: box.stores[m.storeIndex])
        dir.append(path: "Data")
        for d in digitDirs(rowid: m.rowid) { dir.append(path: d) }
        dir.append(path: "Messages")
        return dir.appending(path: "\(m.rowid)" + (m.file == "partial" ? ".partial.emlx" : ".emlx"))
    }

    /// Rahmen: `<laenge>\n<rfc822-bytes><plist>`.
    static func emlxData(for m: Seed.Message) -> Data {
        var headers = ""
        if let s = m.sender {
            headers += "From: \(s.comment.isEmpty ? s.address : "\(s.comment) <\(s.address)>")\r\n"
        }
        let to = m.recipients.filter { $0.type == 0 }.map { $0.comment.isEmpty ? $0.address : "\($0.comment) <\($0.address)>" }
        if !to.isEmpty { headers += "To: \(to.joined(separator: ", "))\r\n" }
        let cc = m.recipients.filter { $0.type == 1 }.map { $0.comment.isEmpty ? $0.address : "\($0.comment) <\($0.address)>" }
        if !cc.isEmpty { headers += "Cc: \(cc.joined(separator: ", "))\r\n" }
        headers += "Subject: \(m.subjectPrefix)\(m.subject)\r\n"
        let date = Date(timeIntervalSince1970: TimeInterval(m.dateSent))
        let fmt = DateFormatter()
        fmt.locale = Locale(identifier: "en_US_POSIX")
        fmt.timeZone = TimeZone(identifier: "UTC")
        fmt.dateFormat = "EEE, dd MMM yyyy HH:mm:ss '+0000'"
        headers += "Date: \(fmt.string(from: date))\r\n"
        if let id = m.messageIdHeader { headers += "Message-ID: \(id)\r\n" }
        headers += "MIME-Version: 1.0\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: 8bit\r\n"
        let message = Data((headers + "\r\n" + m.body.replacingOccurrences(of: "\n", with: "\r\n")).utf8)
        let trailer = """
            <?xml version="1.0" encoding="UTF-8"?>
            <!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
            <plist version="1.0">
            <dict>
            <key>flags</key>
            <integer>\(m.read ? 1 : 0)</integer>
            </dict>
            </plist>

            """
        var out = Data("\(message.count)\n".utf8)
        out.append(message)
        out.append(Data(trailer.utf8))
        return out
    }
}
