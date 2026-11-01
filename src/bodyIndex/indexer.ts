import { basename } from 'node:path'
import type { Config } from '../config.js'
import { HelperError } from '../errors.js'
import type { HelperRunner } from '../helper.js'
import { indexFingerprintOf, type Policy } from '../policy.js'
import { getMessagesResult, probeResult, searchResult } from '../schemas.js'
import { classify } from '../securityMail.js'
import { createLease, LEASE_RENEW_MS, type Lease } from './lease.js'
import { indexFeedResult, indexGidsResult } from './schemas.js'
import { ensureIndexDir, isCorrupt, openStore, removeIndexFiles, type SkipReason, type Sqlite, type Store } from './store.js'
import { indexText, type Classify } from './text.js'
import { classifierVersion, parserVersion } from './versions.js'

export const FEED_PAGE = 500
export const GIDS_PAGE = 20_000
export const BLOCK = 50
export const RECLASSIFY_BLOCK = 200
export const CATCH_UP_INTERVAL_MS = 60_000
export const RECONCILE_INTERVAL_MS = 30 * 60_000
export const PAUSED_PROBE_INTERVAL_MS = 60_000
const BACKOFF_MIN_MS = 5_000
const BACKOFF_MAX_MS = 10 * 60_000
// Gleiche Obergrenzen wie der Live-Scan (bodyScan.ts), damit gleiche Treffer.
const BYTES_PER_MESSAGE = 256 * 1024
const BYTES_TOTAL = 16 * 1024 * 1024

export type IndexerState =
  | 'idle' // wartet auf den ersten erfolgreichen Helper-Aufruf
  | 'building'
  | 'ready'
  | 'paused' // kein FDA bzw. inkompatibles Schema; weiter nach dem naechsten erfolgreichen probe
  | 'foreign' // eine andere Instanz haelt den Lease
  | 'error' // wartet auf den naechsten Versuch (Backoff)
  | 'stopped'

export interface IndexerStatus {
  state: IndexerState
  holdsLease: boolean
  buildComplete: boolean
  indexed: number
  skipped: number
  /** Zahl erlaubter gid aus dem letzten Abgleich; null vor dem ersten. */
  total: number | null
  /** Letzte erfolgreiche Aktualisierung (ms seit Epoch). */
  lastUpdated: number | null
}

export interface Indexer {
  /** Ein Helper-Aufruf hat geklappt: startet den Indexer bzw. setzt ihn nach einer Pause fort. */
  notify(): void
  /** Ein voller Durchgang (probe, Konsistenz, Nachzug, Abgleich); fuer Tests und den Start. */
  runCycle(): Promise<void>
  /** Nachzug ab highWater, hoechstens budgetMs lang (vor einer bodyContains-Suche, AMM-17). */
  catchUp(budgetMs: number): Promise<void>
  status(): IndexerStatus
  /** Wartet, bis die Warteschlange leer ist (Tests). */
  idle(): Promise<void>
  stop(): void
}

export interface IndexerDeps {
  runner: HelperRunner
  config: Config
  policy: () => Promise<Policy>
  sqlite: Sqlite
  dir: string
  exclude?: (dir: string) => void
  lease?: Lease
  now?: () => number
  log?: (line: string) => void
  /** Pause zwischen zwei Bloecken, damit Tool-Aufrufe in die Helper-Warteschlange kommen. */
  yieldFn?: () => Promise<void>
  /** Periodische Arbeit planen; Tests schalten das ab und rufen runCycle selbst. */
  timers?: boolean
  versions?: { classifier: string; parser: string }
  classify?: Classify
}

class LeaseLost extends Error {}
class Stopped extends Error {}
class EnvelopeChanged extends Error {}

const errCode = (e: unknown): string =>
  e instanceof HelperError ? e.code : typeof (e as { code?: unknown } | null)?.code === 'string' ? (e as { code: string }).code : 'error'

export function createIndexer(deps: IndexerDeps): Indexer {
  const now = deps.now ?? Date.now
  const log = deps.log ?? ((line: string) => process.stderr.write(`apple-mail-mcp: ${line}\n`))
  const yieldFn = deps.yieldFn ?? (() => new Promise<void>((r) => setImmediate(r)))
  const timers = deps.timers !== false
  const lease = deps.lease ?? createLease(deps.dir)
  const versions = deps.versions ?? { classifier: classifierVersion(), parser: parserVersion() }
  const cls = deps.classify ?? classify
  const fingerprint = indexFingerprintOf(deps.config)

  let state: IndexerState = 'idle'
  let store: Store | null = null
  let holds = false
  let stopped = false
  let lastProbe = 0
  let lastReconcile = 0
  let envelope: string | null = null
  let backoff = BACKOFF_MIN_MS
  let chain: Promise<void> = Promise.resolve()
  let tick: NodeJS.Timeout | null = null
  let renewTimer: NodeJS.Timeout | null = null

  // Zwischen zwei await: abgebrochen oder Lease verloren? Vor jeder Schreibtransaktion.
  const checkpoint = (): Store => {
    if (stopped) throw new Stopped()
    if (store === null || !lease.held()) throw new LeaseLost()
    return store
  }

  const closeStore = (): void => {
    try {
      store?.close()
    } catch {
      // schon zu
    }
    store = null
  }

  const resetStore = (): Store => {
    closeStore()
    removeIndexFiles(deps.dir)
    store = openStore(deps.sqlite, deps.dir, { exclude: deps.exclude })
    return store
  }

  const allowed = async (): Promise<number[]> => (await deps.policy()).allowedMailboxIds

  // --- Bodys holen und schreiben -------------------------------------------------------------

  type Fetched = { subject: string; fromAddress: string | null; raw: string } | null

  /** Wie fetchBatch im Live-Scan, mit Betreff und Absender fuer die Sicherheitspruefung. */
  async function fetchRaw(ids: number[], mailboxIds: number[]): Promise<Map<number, Fetched>> {
    const out = new Map<number, Fetched>()
    let pending = ids
    while (pending.length > 0) {
      const res = getMessagesResult.parse(
        await deps.runner.run('get-messages', { allowedMailboxIds: mailboxIds, gids: pending, maxBytesPerMessage: BYTES_PER_MESSAGE, maxBytesTotal: BYTES_TOTAL }),
      )
      const retry: number[] = []
      const got = new Set<number>()
      for (const m of res.messages) {
        got.add(m.gid)
        if (m.raw === null) {
          if (res.budgetExhausted && m.file !== 'none') retry.push(m.gid)
          else out.set(m.gid, null)
          continue
        }
        const from = m.sender === null || m.sender.address === '' ? null : m.sender.address
        out.set(m.gid, { subject: m.subject, fromAddress: from, raw: m.raw })
      }
      for (const g of res.missing) out.set(g, null)
      for (const g of pending) {
        if (got.has(g) || res.missing.includes(g)) continue
        if (res.budgetExhausted) retry.push(g)
        else out.set(g, null)
      }
      pending = retry.length < pending.length ? retry : []
    }
    return out
  }

  /** Indiziert einen Block von gid (schon dedupliziert); `after` laeuft in derselben Transaktion. */
  async function indexBlock(ids: number[], mailboxIds: number[], after?: (s: Store) => void): Promise<void> {
    const results: { gid: number; text: string | null; reason: SkipReason | null }[] = []
    if (ids.length > 0) {
      const fetched = await fetchRaw(ids, mailboxIds)
      for (const gid of ids) {
        const f = fetched.get(gid) ?? null
        if (f === null) {
          results.push({ gid, text: null, reason: 'unavailable' })
          continue
        }
        const r = await indexText(f.raw, f.subject, f.fromAddress, cls)
        results.push(r.kind === 'text' ? { gid, text: r.text, reason: null } : { gid, text: null, reason: r.reason })
      }
    }
    const s = checkpoint()
    s.tx(() => {
      for (const r of results) {
        if (s.known(r.gid)) continue
        if (r.text !== null) s.addDoc(r.gid, r.text)
        else s.addSkipped(r.gid, r.reason!)
      }
      after?.(s)
      s.setMeta('lastUpdated', String(now()))
    })
    await yieldFn()
  }

  // --- Phasen -----------------------------------------------------------------------------------

  async function probe(): Promise<boolean> {
    lastProbe = now()
    const p = probeResult.parse(await deps.runner.run('probe', {}))
    if (p.access !== 'granted' || p.schema === undefined || !p.schema.compatible) return false
    envelope = `${p.schema.fingerprint}|${p.mailDir === null ? '' : basename(p.mailDir)}`
    return true
  }

  /** Spec 5.6 und 5.9: Envelope Index, Konfiguration, Klassifizierer, Parser. Liefert, ob ein Abgleich noetig ist. */
  async function consistency(mailboxIds: number[]): Promise<boolean> {
    let s = checkpoint()
    const env = s.meta('envelopeFingerprint')
    if (env !== null && env !== envelope) s = resetStore()
    let reconcile = false
    s.tx(() => {
      if (s.meta('envelopeFingerprint') === null) s.setMeta('envelopeFingerprint', envelope!)
      if (s.meta('highWater') === null) s.setMeta('highWater', '0')
      if (s.meta('buildComplete') === null) s.setMeta('buildComplete', '0')
      if (s.meta('classifierVersion') === null) s.setMeta('classifierVersion', versions.classifier)
      if (s.meta('parserVersion') === null) s.setMeta('parserVersion', versions.parser)
      if (s.meta('indexFingerprint') !== fingerprint) {
        s.setMeta('indexFingerprint', fingerprint)
        s.setMeta('buildComplete', '0')
        reconcile = true
      }
      if (s.meta('parserVersion') !== versions.parser) {
        s.clearSkipped(['parse_failed', 'empty'])
        s.setMeta('parserVersion', versions.parser)
        reconcile = true
      }
    })
    if (s.meta('classifierVersion') !== versions.classifier) {
      await reclassify(mailboxIds)
      reconcile = true
    }
    return reconcile
  }

  /**
   * Neuer Klassifizierer: alte security-Eintraege freigeben (der Abgleich holt sie neu und prueft sie
   * mit dem neuen), dann alle gespeicherten Texte pruefen. Betreff und Absender kommen per search
   * mit gids, ohne die Bodys erneut zu lesen.
   */
  async function reclassify(mailboxIds: number[]): Promise<void> {
    checkpoint().tx(() => checkpoint().clearSkipped(['security']))
    let after = 0
    for (;;) {
      const docs = checkpoint().docs(after, RECLASSIFY_BLOCK)
      if (docs.length === 0) break
      after = docs[docs.length - 1]!.rowid
      const ids = [...new Set(docs.map((d) => d.gid))]
      const res = searchResult.parse(
        await deps.runner.run('search', { allowedMailboxIds: mailboxIds, gids: ids, limit: ids.length, maxRecipients: 5, countTotal: false }),
      )
      const rows = new Map(res.messages.map((m) => [m.gid, m]))
      const s = checkpoint()
      s.tx(() => {
        for (const d of docs) {
          const row = rows.get(d.gid)
          // Nicht mehr erlaubt: entfernt der Abgleich.
          if (row === undefined) continue
          const from = row.sender === null || row.sender.address === '' ? null : row.sender.address
          if (cls({ subject: row.subject, fromAddress: from, text: d.text }).security) {
            s.remove(d.gid)
            s.addSkipped(d.gid, 'security')
          }
        }
      })
      await yieldFn()
    }
    checkpoint().tx(() => checkpoint().setMeta('classifierVersion', versions.classifier))
  }

  /** Nachzug ab highWater (Spec 5.5). Liefert true, wenn das Ende der Tabelle erreicht wurde. */
  async function feed(mailboxIds: number[], deadline: number | null): Promise<boolean> {
    for (;;) {
      const hw = Number(checkpoint().meta('highWater') ?? '0')
      const page = indexFeedResult.parse(await deps.runner.run('index-feed', { allowedMailboxIds: mailboxIds, afterRowid: hw, limit: FEED_PAGE }))
      // Mail hat den Envelope Index neu aufgebaut: gid und ROWID sind andere.
      if (page.maxRowid < hw) throw new EnvelopeChanged()
      for (let b = 0; b < page.rows.length; b += BLOCK) {
        if (deadline !== null && now() >= deadline) return false
        const block = page.rows.slice(b, b + BLOCK)
        const s = checkpoint()
        const ids = [...new Set(block.map((r) => r.gid))].filter((g) => !s.known(g))
        const last = block[block.length - 1]!.rowid
        await indexBlock(ids, mailboxIds, (st) => st.setMeta('highWater', String(last)))
      }
      if (!page.hasMore || page.rows.length === 0) {
        // Was zwischen der letzten Zeile und maxRowid liegt, ist nicht erlaubt oder geloescht; das holt der Abgleich.
        const s = checkpoint()
        const cur = Number(s.meta('highWater') ?? '0')
        if (page.maxRowid > cur) s.tx(() => s.setMeta('highWater', String(page.maxRowid)))
        return true
      }
    }
  }

  /** Abgleich mit allen erlaubten gid: Loeschen, Einengen, Erweitern, spaet geladene Bodys (Spec 5.5). */
  async function reconcile(mailboxIds: number[]): Promise<void> {
    const live = new Map<number, boolean>()
    let after = 0
    for (;;) {
      const page = indexGidsResult.parse(await deps.runner.run('index-gids', { allowedMailboxIds: mailboxIds, afterGid: after, limit: GIDS_PAGE }))
      for (const [gid, hasFile] of page.gids) live.set(gid, hasFile)
      if (!page.hasMore || page.gids.length === 0) break
      after = page.gids[page.gids.length - 1]![0]
    }
    const s = checkpoint()
    s.tx(() => {
      for (const gid of s.docGids()) if (!live.has(gid)) s.remove(gid)
      for (const [gid, reason] of s.skipped()) {
        if (!live.has(gid)) s.remove(gid)
        else if (reason === 'unavailable' && live.get(gid) === true) s.remove(gid)
      }
    })
    const missing = [...live.keys()].filter((g) => !s.known(g))
    for (let b = 0; b < missing.length; b += BLOCK) await indexBlock(missing.slice(b, b + BLOCK), mailboxIds)
    checkpoint().tx(() => checkpoint().setMeta('total', String(live.size)))
    lastReconcile = now()
  }

  // --- Ablauf -------------------------------------------------------------------------------------

  /** Lease holen bzw. pruefen und den Index oeffnen; false, wenn eine andere Instanz schreibt. */
  function claim(): boolean {
    ensureIndexDir(deps.dir, deps.exclude)
    if (!(lease.held() || lease.acquire())) {
      holds = false
      closeStore()
      return false
    }
    holds = true
    store ??= openStore(deps.sqlite, deps.dir, { exclude: deps.exclude })
    if (timers && renewTimer === null) {
      renewTimer = setInterval(() => {
        if (!lease.renew()) holds = false
      }, LEASE_RENEW_MS)
      renewTimer.unref()
    }
    return true
  }

  async function cycle(full: boolean, deadline: number | null): Promise<void> {
    if (full || envelope === null) {
      if (!(await probe())) {
        state = 'paused'
        return
      }
    }
    if (!claim()) {
      state = 'foreign'
      return
    }
    const mailboxIds = await allowed()
    let needReconcile = full || lastReconcile === 0 || now() - lastReconcile >= RECONCILE_INTERVAL_MS
    if (full || deadline === null) needReconcile = (await consistency(mailboxIds)) || needReconcile
    const s = checkpoint()
    if (s.meta('buildComplete') !== '1') state = 'building'
    const reachedEnd = await feed(mailboxIds, deadline)
    if (!reachedEnd || deadline !== null) return
    if (needReconcile) await reconcile(mailboxIds)
    const st = checkpoint()
    if (st.meta('buildComplete') !== '1') st.tx(() => st.setMeta('buildComplete', '1'))
    state = 'ready'
  }

  function schedule(ms: number): void {
    if (!timers || stopped) return
    if (tick !== null) clearTimeout(tick)
    tick = setTimeout(() => {
      tick = null
      // Faelliger Abgleich laeuft als voller Durchgang mit probe (Envelope Index neu aufgebaut?).
      void enqueue(lastReconcile === 0 || now() - lastReconcile >= RECONCILE_INTERVAL_MS, null)
    }, ms)
    tick.unref()
  }

  async function guarded(full: boolean, deadline: number | null): Promise<void> {
    if (stopped) return
    try {
      await cycle(full, deadline)
      backoff = BACKOFF_MIN_MS
      if (state === 'paused') return
      schedule(CATCH_UP_INTERVAL_MS)
    } catch (e) {
      if (stopped || e instanceof Stopped) return
      if (e instanceof LeaseLost) {
        holds = false
        closeStore()
        state = 'foreign'
        schedule(CATCH_UP_INTERVAL_MS)
      } else if (e instanceof HelperError && e.code === 'FULL_DISK_ACCESS_REQUIRED') {
        state = 'paused'
      } else if (e instanceof EnvelopeChanged || isCorrupt(e)) {
        // Datei verwerfen und neu aufbauen; der naechste Durchgang beginnt bei highWater 0.
        try {
          if (holds) resetStore()
        } catch {
          closeStore()
        }
        log(`body index: rebuilding (${e instanceof EnvelopeChanged ? 'mail index changed' : 'file damaged'})`)
        state = 'error'
        envelope = null
        schedule(0)
      } else {
        log(`body index: paused after ${errCode(e)}, retrying in ${Math.round(backoff / 1000)} s`)
        state = 'error'
        schedule(backoff)
        backoff = Math.min(backoff * 2, BACKOFF_MAX_MS)
      }
    }
  }

  function enqueue(full: boolean, deadline: number | null): Promise<void> {
    const run = chain.then(() => guarded(full, deadline))
    chain = run
    return run
  }

  return {
    notify() {
      if (stopped) return
      if (state === 'idle') {
        state = 'building'
        void enqueue(true, null)
      } else if (state === 'paused' && now() - lastProbe >= PAUSED_PROBE_INTERVAL_MS) {
        void enqueue(true, null)
      }
    },
    runCycle: () => enqueue(true, null),
    async catchUp(budgetMs) {
      if (stopped || !holds || store === null) return
      const run = enqueue(false, now() + budgetMs)
      let timer: NodeJS.Timeout | undefined
      await Promise.race([run, new Promise<void>((r) => (timer = setTimeout(r, budgetMs)))])
      clearTimeout(timer)
    },
    status() {
      const s = store
      const counts = s === null ? { docs: 0, skipped: 0 } : s.counts()
      const total = s?.meta('total')
      const updated = s?.meta('lastUpdated')
      return {
        state,
        holdsLease: holds,
        buildComplete: s?.meta('buildComplete') === '1',
        indexed: counts.docs,
        skipped: counts.skipped,
        total: total == null ? null : Number(total),
        lastUpdated: updated == null ? null : Number(updated),
      }
    },
    idle: async () => {
      let c: Promise<void>
      do {
        c = chain
        await c
      } while (c !== chain)
    },
    stop() {
      stopped = true
      state = 'stopped'
      if (tick !== null) clearTimeout(tick)
      if (renewTimer !== null) clearInterval(renewTimer)
      closeStore()
      if (holds) lease.release()
      holds = false
    },
  }
}
