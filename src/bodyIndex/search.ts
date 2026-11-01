import { examine, fetchBatch, findMatch, LOOSE_SPACE } from '../bodyScan.js'
import type { Config } from '../config.js'
import type { HelperRunner } from '../helper.js'
import type { Policy } from '../policy.js'
import { searchResult, type MessageRow } from '../schemas.js'
import type { IndexerStatus } from './indexer.js'
import type { ReadStore } from './store.js'

/** Hoechstzahl der gids fuer search (Helper: searchMaxGids); darueber sucht die Suche live (Spec 5.4). */
export const INDEX_MAX_HITS = 200_000
/** Kuerzere Begriffe kann trigram nicht finden; sie werden live gesucht. */
export const INDEX_MIN_TERM = 3
/** Hoechstens so lange wird vor einer Suche nachgezogen (Spec 5.5). */
export const CATCH_UP_BUDGET_MS = 1000
const SECURITY_PAGE = 200

type Keyset = { d: number; g: number }

export type IndexSearch =
  | { kind: 'too_many' }
  | { kind: 'ok'; matches: { row: MessageRow; matchContext: string }[]; resumeAfter: Keyset | null }

const keysetOf = (k: Keyset | null): Record<string, unknown> => (k ? { after: { date: k.d, gid: k.g } } : {})

/**
 * Sicherheitsmails stehen nie im Index (Spec 5.7). Mit APPLE_MAIL_SHOW_SECURITY_MAILS=true findet
 * der Live-Scan sie aber; deshalb werden sie hier live geprueft, wie im Scan ohne Klassifikation.
 */
async function scanSecurityMails(a: SearchArgs, gids: number[]): Promise<Map<number, string>> {
  const hits = new Map<number, string>()
  const looseTerm = a.term.replace(LOOSE_SPACE, '')
  let after = a.after
  for (;;) {
    const page = searchResult.parse(
      await a.runner.run('search', {
        ...a.filters,
        allowedMailboxIds: a.policy.allowedMailboxIds,
        gids,
        ...keysetOf(after),
        limit: SECURITY_PAGE,
        maxRecipients: 0,
        countTotal: false,
      }),
    )
    const fetched = await fetchBatch(a.runner, a.policy, page.messages)
    for (const row of page.messages) {
      const raw = fetched.get(row.gid) ?? null
      const ctx = raw === null ? undefined : await examine(raw, row, a.term, looseTerm, true)
      if (typeof ctx === 'string') hits.set(row.gid, ctx)
    }
    const last = page.messages[page.messages.length - 1]
    if (!page.hasMore || last === undefined) return hits
    after = { d: last.dateReceived, g: last.gid }
  }
}

interface SearchArgs {
  runner: HelperRunner
  policy: Policy
  config: Config
  /** Filter fuer search (ohne allowedMailboxIds, Keyset und limit). */
  filters: Record<string, unknown>
  /** Schon gefaltet (foldTerm), mindestens INDEX_MIN_TERM Zeichen. */
  term: string
  after: Keyset | null
  limit: number
  index: ReadStore
  maxHits?: number
}

/**
 * Suche ueber den Index (Spec 5.4): FTS liefert die gids, ein search mit gids prueft die aktuelle
 * Policy und die Filter und liefert die Reihenfolge des Live-Scans; jede Zeile wird am gespeicherten
 * Text mit findMatch bestaetigt, das liefert matchContext. Ordnung und Keyset kommen nur vom Helper.
 */
export async function searchIndex(a: SearchArgs): Promise<IndexSearch> {
  const maxHits = a.maxHits ?? INDEX_MAX_HITS
  const hits = a.index.matchGids(a.term)
  if (hits.length > maxHits) return { kind: 'too_many' }
  const security = a.config.showSecurityMails ? a.index.skippedGids('security') : []
  const securityHits = security.length > 0 ? await scanSecurityMails(a, security) : new Map<number, string>()
  const gids = [...new Set([...hits, ...securityHits.keys()])]
  if (gids.length > maxHits) return { kind: 'too_many' }

  const matches: { row: MessageRow; matchContext: string }[] = []
  if (gids.length === 0) return { kind: 'ok', matches, resumeAfter: null }
  let cursor = a.after
  for (;;) {
    const page = searchResult.parse(
      await a.runner.run('search', {
        ...a.filters,
        // Nach den Filtern, damit sie die Policy nie ueberschreiben.
        allowedMailboxIds: a.policy.allowedMailboxIds,
        gids,
        ...keysetOf(cursor),
        limit: a.limit,
        maxRecipients: 5,
        countTotal: false,
      }),
    )
    const rows = page.messages
    const texts = a.index.texts(rows.map((r) => r.gid).filter((g) => !securityHits.has(g)))
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i]!
      cursor = { d: row.dateReceived, g: row.gid }
      const text = texts.get(row.gid)
      // Fehltreffer der Trigramm-Abfrage (oder inzwischen entfernt) fallen hier heraus.
      const ctx = securityHits.get(row.gid) ?? (text === undefined ? null : findMatch(text, a.term))
      if (ctx === null) continue
      matches.push({ row, matchContext: ctx })
      if (matches.length >= a.limit) {
        const more = i < rows.length - 1 || page.hasMore
        return { kind: 'ok', matches, resumeAfter: more ? cursor : null }
      }
    }
    if (!page.hasMore || rows.length === 0) return { kind: 'ok', matches, resumeAfter: null }
  }
}

/** Ein Satz fuer die note, wenn der Index die Suche (noch) nicht bedient; haengt nie vom Begriff ab. */
export function indexProgressNote(status: IndexerStatus): string {
  if (status.state === 'idle' || status.state === 'building') {
    const done = status.indexed + status.skipped
    // Hoechstens 99 %: fertig ist der Index erst mit buildComplete.
    const pct = status.total !== null && status.total > 0 ? ` (${Math.min(99, Math.floor((done / status.total) * 100))}% done)` : ''
    return `The body index is still being built${pct}; until it is complete, bodyContains scans live.`
  }
  return 'The body index is not available right now, so bodyContains scanned live.'
}
