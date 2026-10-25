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

/// Gemeinsame errno-Pruefung vor SQLite: SQLite meldet EPERM und ENOENT beide als CANTOPEN.
enum FileProbe {
    /// `nil` = lesbar, sonst errno.
    static func openErrno(_ path: String) -> Int32? {
        let fd = open(path, O_RDONLY)
        if fd >= 0 { close(fd); return nil }
        return errno
    }
}

/// Schreibgeschuetzte SQLite-Verbindung mit der Funktion `mcp_fold`.
final class Database {
    private var db: OpaquePointer?

    init(readOnlyAt url: URL) throws(HelperFailure) {
        let path = url.path
        if let e = FileProbe.openErrno(path) {
            switch e {
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
