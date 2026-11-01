import { execFile } from 'node:child_process'
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { foldFast } from '../bodyScan.js'
import { defaultStateDir } from '../state.js'

export const SCHEMA_VERSION = 1
export const INDEX_FILE = 'index.sqlite'
const INDEX_FILES = [INDEX_FILE, `${INDEX_FILE}-wal`, `${INDEX_FILE}-shm`, `${INDEX_FILE}-journal`]

export type SkipReason = 'security' | 'unavailable' | 'parse_failed' | 'empty'
export type Sqlite = typeof import('node:sqlite')

export function indexDir(stateDir: string = defaultStateDir()): string {
  return join(stateDir, 'body-index')
}

/** node:sqlite dynamisch: fehlt es (oder FTS5-trigram), bleibt der Index aus, ohne Absturz (Spec 5.11). */
export async function loadSqlite(): Promise<Sqlite | null> {
  try {
    const mod = await import('node:sqlite')
    const db = new mod.DatabaseSync(':memory:')
    try {
      db.exec("CREATE VIRTUAL TABLE t USING fts5(x, content = '', contentless_delete = 1, tokenize = 'trigram case_sensitive 1')")
    } finally {
      db.close()
    }
    return mod
  } catch {
    return null
  }
}

/** SQLITE_CORRUPT (11) oder SQLITE_NOTADB (26), auch als erweiterter Code. */
export function isCorrupt(e: unknown): boolean {
  const code = (e as { errcode?: unknown } | null)?.errcode
  return typeof code === 'number' && ((code & 0xff) === 11 || (code & 0xff) === 26)
}

/** Loescht nur die Datenbankdateien; Verzeichnis (mit Time-Machine-Ausnahme) und writer.lock bleiben. */
export function removeIndexFiles(dir: string): void {
  for (const f of INDEX_FILES) rmSync(join(dir, f), { force: true })
}

function chmodIfExists(path: string, mode: number): void {
  try {
    chmodSync(path, mode)
  } catch {
    // Datei existiert (noch) nicht.
  }
}

export function defaultExclude(dir: string): void {
  // Absoluter Pfad, kein PATH-Lookup; ein Fehler zeigt sich nur in doctor (AMM-17).
  execFile('/usr/bin/tmutil', ['addexclusion', dir], () => {})
}

/** Legt das Verzeichnis mit 0700 an (und zieht die Rechte nach); Time-Machine-Ausnahme nur beim Anlegen. */
export function ensureIndexDir(dir: string, exclude: (dir: string) => void = defaultExclude): void {
  const created = !existsSync(dir)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  chmodSync(dir, 0o700)
  if (created) exclude(dir)
}

export interface DocRow {
  rowid: number
  gid: number
  text: string
}

export interface Store {
  readonly dir: string
  meta(key: string): string | null
  setMeta(key: string, value: string): void
  known(gid: number): boolean
  /** text ist schon zusammengezogen (collapse); indiziert wird foldFast(text) wie im Live-Scan. */
  addDoc(gid: number, text: string): void
  addSkipped(gid: number, reason: SkipReason): void
  /** Entfernt eine gid aus docs, fts und skipped. */
  remove(gid: number): void
  docGids(): number[]
  skipped(): Map<number, SkipReason>
  clearSkipped(reasons: SkipReason[]): number
  docs(afterRowid: number, limit: number): DocRow[]
  /** gid aller Dokumente, deren gefalteter Text die gefaltete Phrase enthaelt (ohne Reihenfolge). */
  matchGids(foldedPhrase: string): number[]
  counts(): { docs: number; skipped: number }
  tx<T>(fn: () => T): T
  close(): void
}

const SCHEMA = `
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE docs (
  rowid INTEGER PRIMARY KEY,
  gid   INTEGER NOT NULL,
  part  TEXT    NOT NULL,
  text  TEXT    NOT NULL,
  UNIQUE (gid, part)
);
CREATE TABLE skipped (gid INTEGER PRIMARY KEY, reason TEXT NOT NULL);
CREATE VIRTUAL TABLE fts USING fts5(
  folded,
  content = '', contentless_delete = 1,
  tokenize = 'trigram case_sensitive 1'
);
`

function openDb(sqlite: Sqlite, file: string): DatabaseSync {
  // Leere Datei vorher mit 0600 anlegen; SQLite uebernimmt die Rechte fuer -wal und -shm.
  if (!existsSync(file)) closeSync(openSync(file, 'a', 0o600))
  const db = new sqlite.DatabaseSync(file)
  try {
    db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;')
    const hasMeta = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'meta'").get() !== undefined
    if (!hasMeta) {
      db.exec('BEGIN')
      db.exec(SCHEMA)
      db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run('schemaVersion', String(SCHEMA_VERSION))
      db.exec('COMMIT')
    }
    return db
  } catch (e) {
    db.close()
    throw e
  }
}

function schemaVersionOf(db: DatabaseSync): string | null {
  const r = db.prepare("SELECT value FROM meta WHERE key = 'schemaVersion'").get() as { value: string } | undefined
  return r?.value ?? null
}

/**
 * Oeffnet oder legt den Index an. Passt schemaVersion nicht oder ist die Datei beschaedigt bzw. keine
 * Datenbank, wird sie geloescht und neu angelegt: die Datei ist nur ein Cache (Spec 5.2, 5.6).
 */
export function openStore(sqlite: Sqlite, dir: string, opts: { exclude?: (dir: string) => void } = {}): Store {
  ensureIndexDir(dir, opts.exclude)
  const file = join(dir, INDEX_FILE)
  let db: DatabaseSync
  try {
    db = openDb(sqlite, file)
    if (schemaVersionOf(db) !== String(SCHEMA_VERSION)) {
      db.close()
      removeIndexFiles(dir)
      db = openDb(sqlite, file)
    }
  } catch (e) {
    if (!isCorrupt(e)) throw e
    removeIndexFiles(dir)
    db = openDb(sqlite, file)
  }
  const fixModes = (): void => {
    for (const f of INDEX_FILES) chmodIfExists(join(dir, f), 0o600)
  }
  fixModes()

  const q = {
    getMeta: db.prepare('SELECT value FROM meta WHERE key = ?'),
    setMeta: db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value'),
    knownDoc: db.prepare('SELECT 1 FROM docs WHERE gid = ? LIMIT 1'),
    knownSkip: db.prepare('SELECT 1 FROM skipped WHERE gid = ?'),
    addDoc: db.prepare("INSERT INTO docs (gid, part, text) VALUES (?, 'body', ?)"),
    addFts: db.prepare('INSERT INTO fts (rowid, folded) VALUES (?, ?)'),
    addSkip: db.prepare('INSERT INTO skipped (gid, reason) VALUES (?, ?) ON CONFLICT (gid) DO UPDATE SET reason = excluded.reason'),
    docRowids: db.prepare('SELECT rowid FROM docs WHERE gid = ?'),
    delFts: db.prepare('DELETE FROM fts WHERE rowid = ?'),
    delDocs: db.prepare('DELETE FROM docs WHERE gid = ?'),
    delSkip: db.prepare('DELETE FROM skipped WHERE gid = ?'),
    docGids: db.prepare('SELECT DISTINCT gid FROM docs'),
    skipped: db.prepare('SELECT gid, reason FROM skipped'),
    docs: db.prepare('SELECT rowid, gid, text FROM docs WHERE rowid > ? ORDER BY rowid LIMIT ?'),
    match: db.prepare('SELECT DISTINCT d.gid AS gid FROM fts JOIN docs d ON d.rowid = fts.rowid WHERE fts MATCH ?'),
    countDocs: db.prepare('SELECT count(DISTINCT gid) AS n FROM docs'),
    countSkip: db.prepare('SELECT count(*) AS n FROM skipped'),
  }

  let depth = 0
  const store: Store = {
    dir,
    meta: (key) => (q.getMeta.get(key) as { value: string } | undefined)?.value ?? null,
    setMeta: (key, value) => void q.setMeta.run(key, value),
    known: (gid) => q.knownDoc.get(gid) !== undefined || q.knownSkip.get(gid) !== undefined,
    addDoc(gid, text) {
      const { lastInsertRowid } = q.addDoc.run(gid, text)
      q.addFts.run(lastInsertRowid, foldFast(text))
      q.delSkip.run(gid)
    },
    addSkipped: (gid, reason) => void q.addSkip.run(gid, reason),
    remove(gid) {
      for (const r of q.docRowids.all(gid) as { rowid: number }[]) q.delFts.run(r.rowid)
      q.delDocs.run(gid)
      q.delSkip.run(gid)
    },
    docGids: () => (q.docGids.all() as { gid: number }[]).map((r) => r.gid),
    skipped: () => new Map((q.skipped.all() as { gid: number; reason: SkipReason }[]).map((r) => [r.gid, r.reason])),
    clearSkipped(reasons) {
      if (reasons.length === 0) return 0
      const { changes } = db.prepare(`DELETE FROM skipped WHERE reason IN (${reasons.map(() => '?').join(',')})`).run(...reasons)
      return Number(changes)
    },
    docs: (afterRowid, limit) => q.docs.all(afterRowid, limit) as unknown as DocRow[],
    matchGids(foldedPhrase) {
      // Phrase in Anfuehrungszeichen, eingebettete verdoppelt; unter drei Zeichen kann trigram nichts.
      if ([...foldedPhrase].length < 3) return []
      return (q.match.all(`"${foldedPhrase.replaceAll('"', '""')}"`) as { gid: number }[]).map((r) => r.gid)
    },
    counts: () => ({
      docs: (q.countDocs.get() as { n: number }).n,
      skipped: (q.countSkip.get() as { n: number }).n,
    }),
    tx(fn) {
      if (depth > 0) return fn()
      db.exec('BEGIN IMMEDIATE')
      depth++
      try {
        const out = fn()
        db.exec('COMMIT')
        return out
      } catch (e) {
        db.exec('ROLLBACK')
        throw e
      } finally {
        depth--
        fixModes()
      }
    },
    close: () => db.close(),
  }
  return store
}
