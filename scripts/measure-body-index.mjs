#!/usr/bin/env node
// Spike AMM-14: baut einen Wegwerf-Body-Index nach Spec AMM-12 (5.2, 5.4) in einem temporaeren
// Verzeichnis und misst Platz und Zeit. Gibt nur Zahlen aus, nie Inhalte, Betreffs, Adressen
// oder Pfade. Der Index wird am Ende geloescht, auch bei Fehler und Ctrl-C.
//
// Kandidaten kommen wie beim Live-Scan ueber `search` (erlaubte Mailboxen, Keyset), die Rohtexte
// ueber `get-messages` mit denselben Obergrenzen, der Text ueber parseForScan und immer den
// vollen Text, die Sicherheitspruefung ueber classify. Sicherheitsmails kommen nicht in den Index.
//
// Aufruf (nach npm run build und npm run build:helper, Dev-Bundle mit FDA):
//   APPLE_MAIL_HELPER_PATH="$PWD/bin/Mail MCP Helper (Dev).app" node scripts/measure-body-index.mjs [--max=N] [begriff ...]
// Ohne Begriffe misst es "rechnung", "termin" und "danke".
import { mkdtempSync, rmSync, readdirSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { loadConfig } from '../dist/config.js'
import { createHelperRunner } from '../dist/helper.js'
import { computePolicy } from '../dist/policy.js'
import { BATCH, collapse, fetchBatch, findMatch, foldFast, foldTerm } from '../dist/bodyScan.js'
import { parseForScan } from '../dist/mime.js'
import { classify } from '../dist/securityMail.js'

const SEARCH_PAGE = 2000
const QUERY_RUNS = 5
// Wie Spec 5.4 Schritt 5: darueber faellt die Suche auf den Live-Scan zurueck.
const FTS_HIT_CAP = 200000

const SCHEMA = `
  PRAGMA journal_mode = WAL;
  PRAGMA synchronous = NORMAL;
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

function median(values) {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)]
}

const ms = (v) => `${v.toFixed(0)} ms`
const mib = (bytes) => `${(bytes / 1024 / 1024).toFixed(1)} MiB`

/** Text einer Nachricht wie Spec 5.4: voller Text, Leerraum zusammengezogen; sonst Grund fuer skipped. */
async function textOf(raw, row) {
  const body = await parseForScan(Buffer.from(raw, 'base64'))
  if (!body.ok) return { reason: 'parse_failed' }
  const full = body.exact ? body.quick : await body.full()
  if (full === null) return { reason: 'parse_failed' }
  const text = collapse(full)
  if (text === '') return { reason: 'empty' }
  const fromAddress = row.sender === null || row.sender.address === '' ? null : row.sender.address
  if (classify({ subject: row.subject, fromAddress, text }).security) return { reason: 'security' }
  return { text }
}

/** Baut den Index in `dir` und misst die Begriffe. Liefert nur Zahlen. */
export async function measure({ runner, policy, dir, terms, max = Infinity, log = () => {} }) {
  const { DatabaseSync } = await import('node:sqlite')
  const file = join(dir, 'index.sqlite')
  const db = new DatabaseSync(file)
  try {
    db.exec(SCHEMA)
    const insertDoc = db.prepare("INSERT INTO docs (gid, part, text) VALUES (?, 'body', ?)")
    const insertFts = db.prepare('INSERT INTO fts (rowid, folded) VALUES (?, ?)')
    const insertSkipped = db.prepare('INSERT INTO skipped (gid, reason) VALUES (?, ?)')

    const out = {
      sqlite: db.prepare('SELECT sqlite_version() AS v').get().v,
      candidates: 0,
      indexed: 0,
      skipped: { unavailable: 0, parse_failed: 0, empty: 0, security: 0 },
      rawBytes: 0,
      textBytes: 0,
      foldedBytes: 0,
      ms: { total: 0, search: 0, fetch: 0, parse: 0, write: 0 },
    }
    const started = performance.now()
    let after = null
    outer: for (;;) {
      let t = performance.now()
      const page = await runner.run('search', {
        allowedMailboxIds: policy.allowedMailboxIds,
        ...(after ? { after } : {}),
        limit: SEARCH_PAGE,
        maxRecipients: 1,
        countTotal: false,
      })
      out.ms.search += performance.now() - t
      const rows = page.messages
      for (let b = 0; b < rows.length; b += BATCH) {
        const batch = rows.slice(b, b + BATCH)
        if (out.candidates + batch.length > max) batch.length = max - out.candidates
        if (batch.length === 0) break outer
        t = performance.now()
        const fetched = await fetchBatch(runner, policy, batch)
        out.ms.fetch += performance.now() - t

        t = performance.now()
        const results = []
        for (const row of batch) {
          const raw = fetched.get(row.gid) ?? null
          if (raw === null) {
            results.push({ gid: row.gid, reason: 'unavailable' })
            continue
          }
          out.rawBytes += Math.floor((raw.length * 3) / 4)
          results.push({ gid: row.gid, ...(await textOf(raw, row)) })
        }
        out.ms.parse += performance.now() - t

        t = performance.now()
        db.exec('BEGIN')
        for (const r of results) {
          if (r.text === undefined) {
            insertSkipped.run(r.gid, r.reason)
            out.skipped[r.reason]++
            continue
          }
          const folded = foldFast(r.text)
          const { lastInsertRowid } = insertDoc.run(r.gid, r.text)
          insertFts.run(lastInsertRowid, folded)
          out.indexed++
          out.textBytes += Buffer.byteLength(r.text)
          out.foldedBytes += Buffer.byteLength(folded)
        }
        db.exec('COMMIT')
        out.ms.write += performance.now() - t
        out.candidates += batch.length
        if (out.candidates % 1000 < batch.length) log(`  ${out.candidates} messages, ${ms(performance.now() - started)}`)
        // Wie der Indexer im Server: zwischen zwei Bloecken die Ereignisschleife freigeben.
        await new Promise((resolve) => setImmediate(resolve))
      }
      if (!page.hasMore || rows.length === 0) break
      const last = rows[rows.length - 1]
      after = { date: last.dateReceived, gid: last.gid }
    }
    out.ms.total = performance.now() - started

    db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
    out.files = readdirSync(dir).reduce((sum, f) => sum + statSync(join(dir, f)).size, 0)
    try {
      // dbstat fehlt in manchen Builds; dann nur die Dateigroesse.
      out.tables = Object.fromEntries(
        db
          .prepare("SELECT CASE WHEN name LIKE 'fts%' THEN 'fts' WHEN name LIKE 'sqlite_autoindex_docs%' THEN 'docs' ELSE name END AS t, SUM(pgsize) AS bytes FROM dbstat GROUP BY t")
          .all()
          .map((r) => [r.t, Number(r.bytes)]),
      )
    } catch {
      out.tables = null
    }

    // Abfragen. Gegenprobe: jede Zeile in docs mit foldFast(text).includes(term), wie der Live-Scan
    // vor findMatch. So zeigt sich, ob FTS genau dieselben Treffer liefert (Anti-Ziel 1).
    const ftsQuery = db.prepare('SELECT rowid FROM fts WHERE fts MATCH ? LIMIT ?')
    const textById = db.prepare('SELECT text FROM docs WHERE rowid = ?')
    const allDocs = db.prepare('SELECT rowid, text FROM docs')
    out.queries = []
    for (const raw of terms) {
      const term = foldTerm(raw)
      const q = { term: raw, foldedLength: [...term].length }
      if ([...term].length < 3) {
        q.skipped = 'shorter than 3 characters, live scan'
        out.queries.push(q)
        continue
      }
      const phrase = `"${term.replaceAll('"', '""')}"`
      const durations = []
      let hits = []
      for (let i = 0; i < QUERY_RUNS; i++) {
        const t0 = performance.now()
        hits = ftsQuery.all(phrase, FTS_HIT_CAP + 1).map((r) => Number(r.rowid))
        durations.push(performance.now() - t0)
      }
      q.ftsFirst = durations[0]
      q.ftsMedian = median(durations)
      q.ftsHits = hits.length
      q.overCap = hits.length > FTS_HIT_CAP

      const t1 = performance.now()
      let confirmed = 0
      for (const id of hits) if (findMatch(textById.get(id).text, term) !== null) confirmed++
      q.confirmMs = performance.now() - t1
      q.confirmed = confirmed

      const t2 = performance.now()
      const ftsSet = new Set(hits)
      let scanHits = 0
      let missed = 0
      for (const row of allDocs.iterate()) {
        if (!foldFast(row.text).includes(term)) continue
        scanHits++
        if (!ftsSet.has(Number(row.rowid))) missed++
      }
      q.scanAllMs = performance.now() - t2
      q.scanHits = scanHits
      q.missed = missed
      out.queries.push(q)
    }
    return out
  } finally {
    db.close()
  }
}

export function report(r, configured) {
  const p = (label, value) => console.log(`${label.padEnd(30)} ${value}`)
  p('node', process.version)
  p('sqlite', r.sqlite)
  p('max messages', configured.max === Infinity ? 'all' : configured.max)
  p('candidates', r.candidates)
  p('indexed', r.indexed)
  p('skipped', Object.entries(r.skipped).map(([k, v]) => `${k} ${v}`).join(', '))
  p('raw bytes fetched', mib(r.rawBytes))
  p('text bytes (docs.text)', mib(r.textBytes))
  p('folded bytes (fts input)', mib(r.foldedBytes))
  p('index files after checkpoint', mib(r.files))
  if (r.tables) p('by table', Object.entries(r.tables).map(([k, v]) => `${k} ${mib(v)}`).join(', '))
  p('index / text', r.textBytes > 0 ? `${(r.files / r.textBytes).toFixed(2)}x` : '-')
  p('build total', ms(r.ms.total))
  p('  search', ms(r.ms.search))
  p('  get-messages', ms(r.ms.fetch))
  p('  parse + classify', ms(r.ms.parse))
  p('  write', ms(r.ms.write))
  p('per message', r.candidates > 0 ? `${(r.ms.total / r.candidates).toFixed(2)} ms` : '-')
  p('max RSS', mib(process.resourceUsage().maxRSS * 1024))
  r.queries.forEach((q, i) => {
    // Begriffe nur als Nummer und Laenge: sie koennten selbst etwas verraten, wenn die Ausgabe weitergegeben wird.
    const label = `query ${i + 1} (${q.foldedLength} chars)`
    if (q.skipped) return p(label, q.skipped)
    p(label, `fts first ${ms(q.ftsFirst)} median ${ms(q.ftsMedian)}  hits ${q.ftsHits}${q.overCap ? ' (over cap)' : ''}  confirmed ${q.confirmed} in ${ms(q.confirmMs)}  full scan ${q.scanHits} in ${ms(q.scanAllMs)}  missed ${q.missed}`)
  })
}

async function main() {
  const args = process.argv.slice(2)
  const maxArg = args.find((a) => a.startsWith('--max='))
  const max = maxArg ? Number(maxArg.slice(6)) : Infinity
  if (!(max > 0)) {
    console.error('--max must be a positive number')
    process.exit(2)
  }
  const terms = args.filter((a) => !a.startsWith('--'))
  if (terms.length === 0) terms.push('rechnung', 'termin', 'danke')

  const configResult = loadConfig(process.env)
  if (!configResult.ok) {
    console.error(`Config invalid: ${configResult.key}`)
    process.exit(1)
  }
  const config = configResult.config
  const runner = createHelperRunner(config)
  const dir = mkdtempSync(join(tmpdir(), 'amm-body-index-'))
  const cleanup = () => rmSync(dir, { recursive: true, force: true })
  process.once('SIGINT', () => {
    runner.stop()
    cleanup()
    process.exit(130)
  })
  try {
    const policy = computePolicy(config, await runner.run('list-mailboxes', {}))
    const result = await measure({ runner, policy, dir, terms, max, log: (line) => console.error(line) })
    report(result, { max })
  } catch (error) {
    console.error(`Failed: ${error?.code ?? error?.name ?? 'error'}`)
    process.exitCode = 1
  } finally {
    runner.stop()
    cleanup()
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) await main()
