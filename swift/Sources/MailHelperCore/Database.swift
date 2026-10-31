import Foundation
import SQLite3

private let sqliteTransient = unsafeBitCast(-1, to: sqlite3_destructor_type.self)

/// Gebundener Parameterwert. Abfragen sind immer parametrisiert, nie zusammengesetzt.
enum SQLValue {
    case int(Int64)
    case text(String)
    case null
}

/// Lesezugriff auf die Spalten der aktuellen Ergebniszeile.
struct Row {
    fileprivate let stmt: OpaquePointer

    func isNull(_ i: Int32) -> Bool { sqlite3_column_type(stmt, i) == SQLITE_NULL }
    func int(_ i: Int32) -> Int64 { sqlite3_column_int64(stmt, i) }
    func text(_ i: Int32) -> String? {
        guard let p = sqlite3_column_text(stmt, i) else { return nil }
        return String(cString: p)
    }
}

/// Geraet und Inode einer geoeffneten Datei.
struct FileIdentity: Equatable {
    let dev: dev_t
    let ino: ino_t
}

struct OpenErrno: Error {
    let code: Int32
}

/// Gemeinsame errno-Pruefung vor SQLite: SQLite meldet EPERM und ENOENT beide als CANTOPEN.
enum FileProbe {
    /// `nil` = lesbar, sonst errno.
    static func openErrno(_ path: String) -> Int32? {
        if case .failure(let e) = identity(path) { return e.code }
        return nil
    }

    /// Oeffnet die Datei und liest dev/ino per fstat am geoeffneten Deskriptor, nicht per stat am Pfad:
    /// so gehoert die Identitaet sicher zu der Datei, die geoeffnet wurde.
    static func identity(_ path: String) -> Result<FileIdentity, OpenErrno> {
        let fd = open(path, O_RDONLY)
        guard fd >= 0 else { return .failure(OpenErrno(code: errno)) }
        defer { close(fd) }
        var st = stat()
        guard fstat(fd, &st) == 0 else { return .failure(OpenErrno(code: errno)) }
        return .success(FileIdentity(dev: st.st_dev, ino: st.st_ino))
    }
}

/// Schreibgeschuetzte SQLite-Verbindung mit der Funktion `mcp_fold`.
final class Database {
    private var db: OpaquePointer?
    /// Hoechste bereits gefaltete ROWID je Woerterbuchtabelle (FoldCache.swift); nil, solange die
    /// TEMP-Tabellen dieser Verbindung noch nicht angelegt sind.
    var foldedMax: (subjects: Int64, addresses: Int64)?
    /// Identitaet der Datei aus der Pruefung unmittelbar vor `sqlite3_open_v2`. Wird die Datei dazwischen
    /// ersetzt, haelt SQLite die neuere Datei und hier steht die aeltere: die naechste Anfrage sieht eine
    /// andere Inode und oeffnet einmal unnoetig neu. Umgekehrt (stat am Pfad nach dem Oeffnen) bekaeme die
    /// alte Verbindung die neue Inode und bliebe dauerhaft an der entlinkten Datei haengen.
    let identity: FileIdentity

    init(readOnlyAt url: URL) throws(HelperFailure) {
        let path = url.path
        switch FileProbe.identity(path) {
        case .success(let id):
            identity = id
        case .failure(let failure):
            switch failure.code {
            case EPERM, EACCES:
                throw HelperFailure(code: .fullDiskAccessRequired, message: "Full Disk Access is required to read the Mail database.")
            case ENOENT, ENOTDIR:
                throw HelperFailure(code: .mailDataNotFound, message: "The Mail database file does not exist.")
            default:
                throw HelperFailure(code: .databaseError, message: "The Mail database file cannot be opened.")
            }
        }
        // Schlichter Pfad, kein URI, kein immutable.
        var handle: OpaquePointer?
        let rc = sqlite3_open_v2(path, &handle, SQLITE_OPEN_READONLY, nil)
        guard rc == SQLITE_OK, let handle else {
            sqlite3_close(handle)
            throw Database.failure(rc, "The Mail database cannot be opened.")
        }
        db = handle
        sqlite3_busy_timeout(handle, 2000)

        let frc = sqlite3_create_function_v2(handle, "mcp_fold", 1, SQLITE_UTF8 | SQLITE_DETERMINISTIC, nil, { ctx, argc, argv in
            guard argc == 1, let argv, let value = argv[0], sqlite3_value_type(value) != SQLITE_NULL else {
                sqlite3_result_null(ctx)
                return
            }
            guard let p = sqlite3_value_text(value) else {
                sqlite3_result_null(ctx)
                return
            }
            let folded = fold(String(cString: p))
            sqlite3_result_text(ctx, folded, -1, sqliteTransient)
        }, nil, nil, nil)
        guard frc == SQLITE_OK else {
            sqlite3_close(handle)
            db = nil
            throw Database.failure(frc, "The fold function cannot be registered.")
        }
    }

    deinit { sqlite3_close(db) }

    /// Feste Saetze, nie `sqlite3_errmsg` (koennte Werte enthalten).
    private static func failure(_ rc: Int32, _ text: String) -> HelperFailure {
        switch rc & 0xff {
        case SQLITE_BUSY, SQLITE_LOCKED:
            return HelperFailure(code: .databaseBusy, message: "The Mail database is busy.")
        default:
            return HelperFailure(code: .databaseError, message: text)
        }
    }

    /// Anweisung ohne Ergebniszeilen (TEMP-Tabellen, Pragmas der Verbindung).
    func execute(_ sql: String, _ bind: [SQLValue] = []) throws(HelperFailure) {
        try query(sql, bind) { _ in }
    }

    func query(_ sql: String, _ bind: [SQLValue] = [], row: (Row) -> Void) throws(HelperFailure) {
        var stmt: OpaquePointer?
        let prc = sqlite3_prepare_v2(db, sql, -1, &stmt, nil)
        guard prc == SQLITE_OK, let stmt else {
            sqlite3_finalize(stmt)
            throw Database.failure(prc, "The database query cannot be prepared.")
        }
        defer { sqlite3_finalize(stmt) }
        for (i, v) in bind.enumerated() {
            let idx = Int32(i + 1)
            switch v {
            case .int(let n): sqlite3_bind_int64(stmt, idx, n)
            case .text(let s): sqlite3_bind_text(stmt, idx, s, -1, sqliteTransient)
            case .null: sqlite3_bind_null(stmt, idx)
            }
        }
        while true {
            let rc = sqlite3_step(stmt)
            if rc == SQLITE_ROW { row(Row(stmt: stmt)); continue }
            if rc == SQLITE_DONE { return }
            throw Database.failure(rc, "The database query failed.")
        }
    }
}
