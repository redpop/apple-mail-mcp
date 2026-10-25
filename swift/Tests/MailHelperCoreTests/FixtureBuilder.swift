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

struct Fixture: Sendable {
    let mailRoot: URL
    let accountsDB: URL
    let seed: Seed

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

    static func build(extraMessages: Int = 0, dropping: (table: String, column: String)? = nil) throws -> Fixture {
        let root = try repoRoot()
        let seed = try loadSeed()
        let fm = FileManager.default

        let tmp = fm.temporaryDirectory.appending(path: "mail-fixture-\(UUID().uuidString)")
        let mailRoot = tmp.appending(path: "Mail")
        let accountsDir = tmp.appending(path: "Accounts")
        try fm.createDirectory(at: mailRoot.appending(path: "V10/MailData"), withIntermediateDirectories: true)
        try fm.createDirectory(at: accountsDir, withIntermediateDirectories: true)
        let fixture = Fixture(mailRoot: mailRoot,
                              accountsDB: accountsDir.appending(path: "Accounts4.sqlite"),
                              seed: seed)

        try buildEnvelopeIndex(fixture, root: root, extraMessages: extraMessages)
        if let d = dropping { try dropColumn(fixture, table: d.table, column: d.column) }
        try buildAccounts(fixture, root: root)
        try writeMailTree(fixture)
        return fixture
    }

    private static func buildEnvelopeIndex(_ f: Fixture, root: URL, extraMessages: Int) throws {
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

        if extraMessages > 0 {
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
