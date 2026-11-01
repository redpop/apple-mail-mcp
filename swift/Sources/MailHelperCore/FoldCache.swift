import Foundation

/// Gefaltete Woerterbuecher fuer die Textfilter (Spec 5.4, Abschnitt 18).
///
/// Ohne Cache faltet jede Suche mit Textfilter die ganze Tabelle `subjects` (bei `query` auch
/// `addresses`) mit `mcp_fold`, auf einer echten Ablage rund 240 ms je Durchgang. Stattdessen haelt die
/// Envelope-Index-Verbindung die gefalteten Texte in zwei TEMP-Tabellen:
///
///     temp.fold_subjects(id, f)        -- f = mcp_fold(subjects.subject)
///     temp.fold_addresses(id, a, c)    -- a = mcp_fold(addresses.address), c = mcp_fold(addresses.comment)
///
/// Nichts davon landet in Mails Dateien: die Verbindung bleibt SQLITE_OPEN_READONLY, `main` ist
/// schreibgeschuetzt, und TEMP-Tabellen gehoeren zur Verbindung, nicht zur Datenbankdatei. Mit
/// `temp_store = MEMORY` (gesetzt beim Oeffnen, Database.init) liegen sie im Arbeitsspeicher des Helpers
/// (ohne das Pragma laege die TEMP-Datenbank in einer anonymen Datei im Temp-Verzeichnis des Systems,
/// nie neben dem Envelope Index).
/// Geprueft 2026-10-25 mit SQLite 3.54: eine READONLY-Verbindung darf TEMP-Tabellen anlegen und
/// beschreiben; `ATTACH ':memory:'` dagegen erbt READONLY und scheitert, deshalb TEMP.
///
/// Gefuellt wird lazy bei der ersten Suche mit Textfilter, danach vor jeder solchen Suche nur um Zeilen
/// mit hoeherer ROWID ergaenzt. Beide Tabellen sind AUTOINCREMENT und werden von Mail praktisch nur
/// angehaengt; ROWIDs werden nicht wiederverwendet. Verschwundene Zeilen schaden nicht, weil die Treffer
/// nur ueber `messages.subject`, `messages.sender` und `recipients.address` wirken. Ein in place
/// geaenderter Text (gleiche ROWID) wuerde erst nach dem Neuoeffnen der Verbindung neu gefaltet; das
/// geschieht, wenn Mail den Index neu anlegt (neue Inode, MailStore.envelopeConnection).
extension Database {
    func refreshFoldedDictionaries() throws(HelperFailure) {
        var known = foldedMax ?? (0, 0)
        if foldedMax == nil {
            try execute("CREATE TEMP TABLE IF NOT EXISTS fold_subjects (id INTEGER PRIMARY KEY, f TEXT NOT NULL)")
            try execute("CREATE TEMP TABLE IF NOT EXISTS fold_addresses (id INTEGER PRIMARY KEY, a TEXT NOT NULL, c TEXT NOT NULL)")
        }
        // INSERT OR REPLACE: scheitert nach einem erfolgreichen INSERT das Nachlesen des Maximums, faltet der
        // naechste Aufruf dieselben Zeilen erneut, ohne an der Primaerschluessel-Bedingung zu scheitern.
        try execute("""
            INSERT OR REPLACE INTO temp.fold_subjects (id, f)
            SELECT ROWID, coalesce(mcp_fold(subject), '') FROM main.subjects WHERE ROWID > ?
            """, [.int(known.subjects)])
        known.subjects = try maxId("temp.fold_subjects", known.subjects)
        foldedMax = known
        try execute("""
            INSERT OR REPLACE INTO temp.fold_addresses (id, a, c)
            SELECT ROWID, coalesce(mcp_fold(address), ''), coalesce(mcp_fold(comment), '') FROM main.addresses WHERE ROWID > ?
            """, [.int(known.addresses)])
        known.addresses = try maxId("temp.fold_addresses", known.addresses)
        foldedMax = known
    }

    private func maxId(_ table: String, _ fallback: Int64) throws(HelperFailure) -> Int64 {
        var n = fallback
        try query("SELECT coalesce(max(id), ?) FROM \(table)", [.int(fallback)]) { n = $0.int(0) }
        return n
    }
}

/// gids fuer `search` mit `gids` (Body-Index-Spec 5.3), wie die Woerterbuecher eine TEMP-Tabelle der
/// Verbindung im Arbeitsspeicher, nie in Mails Dateien. Wird je Suche geleert und neu gefuellt; laeuft in
/// der Lesetransaktion der Suche, ein Fehler rollt die Zeilen mit zurueck.
extension Database {
    func fillSearchGids(_ gids: [Int64]) throws(HelperFailure) {
        try execute("CREATE TEMP TABLE IF NOT EXISTS search_gids (gid INTEGER PRIMARY KEY)")
        try execute("DELETE FROM temp.search_gids")
        try insertEach("INSERT OR IGNORE INTO temp.search_gids (gid) VALUES (?)", gids)
    }
}
