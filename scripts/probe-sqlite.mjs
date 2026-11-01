#!/usr/bin/env node
// Prueft, ob die laufende Node-Laufzeit den Body-Index tragen kann (Spec AMM-12, 5.2 und 5.11):
// node:sqlite, FTS5, trigram mit case_sensitive, contentless_delete. Gibt nur Versionen und
// Faehigkeiten als eine JSON-Zeile aus, nie Pfade oder Inhalte. Arbeitet in einer
// In-Memory-Datenbank und schreibt nichts auf die Platte.
//
// Ausgabe auf stderr, damit dieselbe Datei auch als Server einer Probe-MCPB laufen kann: Claude
// Desktop schreibt stderr des Servers in ~/Library/Logs/Claude/mcp-server-<Name>.log, stdout waere
// dort das MCP-Protokoll.
//
// Aufruf: node scripts/probe-sqlite.mjs

const result = {
  node: process.version,
  electron: process.versions.electron ?? null,
  processType: process.type ?? null,
  versionsSqlite: process.versions.sqlite ?? null,
  nodeSqlite: false,
  sqlite: null,
  fts5: false,
  trigram: false,
  trigramCaseSensitive: false,
  contentlessDelete: false,
  phraseMatch: false,
  error: null,
}

const step = (name, fn) => {
  try {
    fn()
    return true
  } catch (error) {
    result.error ??= `${name}: ${error?.code ?? error?.name ?? 'error'}: ${String(error?.message ?? '').slice(0, 160)}`
    return false
  }
}

let db = null
try {
  const { DatabaseSync } = await import('node:sqlite')
  result.nodeSqlite = true
  db = new DatabaseSync(':memory:')
  result.sqlite = db.prepare('SELECT sqlite_version() AS v').get().v
} catch (error) {
  result.error = `import: ${error?.code ?? error?.name ?? 'error'}: ${String(error?.message ?? '').slice(0, 160)}`
}

if (db !== null) {
  result.fts5 = step('fts5', () => db.exec('CREATE VIRTUAL TABLE t0 USING fts5(x)'))
  result.trigram = result.fts5 && step('trigram', () => db.exec("CREATE VIRTUAL TABLE t1 USING fts5(x, tokenize = 'trigram')"))
  // Genau die Tabelle aus Spec 5.2.
  result.trigramCaseSensitive =
    result.trigram &&
    step('spec table', () =>
      db.exec("CREATE VIRTUAL TABLE fts USING fts5(folded, content = '', contentless_delete = 1, tokenize = 'trigram case_sensitive 1')"),
    )
  if (result.trigramCaseSensitive) {
    // Teilwort und Gross-/Kleinschreibung: gefalteter Text ist klein, ein grosser Begriff darf nicht treffen.
    result.phraseMatch = step('match', () => {
      const insert = db.prepare('INSERT INTO fts (rowid, folded) VALUES (?, ?)')
      insert.run(1, 'die stromrechnung fuer oktober')
      insert.run(2, 'strasse und gruesse')
      const hits = (term) => db.prepare('SELECT rowid FROM fts WHERE fts MATCH ?').all(`"${term}"`).map((r) => Number(r.rowid))
      const ok = hits('rechnung').join() === '1' && hits('Rechnung').length === 0 && hits('strasse').join() === '2'
      if (!ok) throw new Error('unexpected match result')
    })
    result.contentlessDelete = step('delete', () => {
      db.prepare('DELETE FROM fts WHERE rowid = ?').run(1)
      const left = db.prepare('SELECT rowid FROM fts WHERE fts MATCH ?').all('"rechnung"')
      if (left.length !== 0) throw new Error('row still matches after delete')
    })
  }
  db.close()
}

process.stderr.write(`body-index probe ${JSON.stringify(result)}\n`)
