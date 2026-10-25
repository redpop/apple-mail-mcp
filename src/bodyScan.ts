import type { Config } from './config.js'
import { fold } from './fold.js'
import type { HelperRunner } from './helper.js'
import { parseMessage } from './mime.js'
import type { Policy } from './policy.js'
import { getMessagesResult, searchResult, type MessageRow } from './schemas.js'
import { classify } from './securityMail.js'
import { HelperError } from './errors.js'

export const CANDIDATE_CAP = 2000
export const TIME_BUDGET_MS = 3000
export const CANDIDATE_PAGE = 200
export const BATCH = 50
export const SCAN_BYTES_PER_MESSAGE = 256 * 1024
export const SCAN_BYTES_TOTAL = 16 * 1024 * 1024
export const CONTEXT_CHARS = 160

export interface ScanInfo {
  scanned: number
  unavailable: number
  stoppedBy: 'limit' | 'cap' | 'time' | null
  complete: boolean
}

export interface ScanResult {
  matches: { row: MessageRow; matchContext: string }[]
  scan: ScanInfo
  resumeAfter: { d: number; g: number } | null
}

const isSpace = (c: string): boolean => /^\s$/u.test(c)

/** Zieht jede Leerraumfolge zu einem Leerzeichen zusammen und trimmt. */
function collapse(s: string): string {
  return s.replace(/\s+/gu, ' ').trim()
}

/**
 * Faltet pro Codepoint und merkt sich, aus welcher Position des Originals jedes gefaltete
 * Zeichen stammt. So bleiben Fundstellen auch dort exakt, wo die Faltung die Laenge aendert
 * (ß wird zu ss). Pro Codepoint zu falten weicht nur bei kontextabhaengigen Faellen
 * (griechisches Schluss-Sigma) von der Faltung des ganzen Strings ab; Suchbegriff und Text
 * werden hier gleich behandelt, die Treffer sind also in sich stimmig.
 */
function foldWithMap(text: string): { folded: string; origin: number[] } {
  let folded = ''
  const origin: number[] = []
  let i = 0
  for (const ch of text) {
    const f = fold(ch)
    for (let k = 0; k < f.length; k++) origin.push(i)
    folded += f
    i += ch.length
  }
  return { folded, origin }
}

function foldTerm(term: string): string {
  return collapse(foldWithMap(collapse(term)).folded)
}

/** Erste Fundstelle des gefalteten Begriffs; Kontext aus dem Original (nur Leerraum zusammengezogen). */
export function findMatch(rawText: string, foldedTerm: string): string | null {
  const text = collapse(rawText)
  const { folded, origin } = foldWithMap(text)
  const at = folded.indexOf(foldedTerm)
  if (at < 0) return null
  const start = origin[at]!
  const last = origin[at + foldedTerm.length - 1]!
  // Ende des Originalzeichens, das das letzte gefaltete Zeichen erzeugt hat.
  const endCp = text.codePointAt(last)!
  const end = last + (endCp > 0xffff ? 2 : 1)
  const len = end - start
  let from = start
  let to = end
  if (len < CONTEXT_CHARS) {
    const pad = Math.floor((CONTEXT_CHARS - len) / 2)
    from = Math.max(0, start - pad)
    to = Math.min(text.length, from + CONTEXT_CHARS)
    from = Math.max(0, to - CONTEXT_CHARS)
  } else {
    to = from + CONTEXT_CHARS
  }
  // Keine halben Surrogatpaare an den Raendern.
  if (from > 0 && /[\udc00-\udfff]/.test(text[from]!)) from++
  if (to < text.length && /[\ud800-\udbff]/.test(text[to - 1]!)) to--
  return text.slice(from, to).trim()
}

interface Fetched {
  text: string | null
}

async function fetchBatch(runner: HelperRunner, policy: Policy, batch: MessageRow[]): Promise<Map<number, Fetched>> {
  const out = new Map<number, Fetched>()
  let pending = batch.filter((r) => r.file !== 'none').map((r) => r.gid)
  for (const r of batch) if (r.file === 'none') out.set(r.gid, { text: null })
  while (pending.length > 0) {
    const res = getMessagesResult.parse(
      await runner.run('get-messages', {
        allowedMailboxIds: policy.allowedMailboxIds,
        gids: pending,
        maxBytesPerMessage: SCAN_BYTES_PER_MESSAGE,
        maxBytesTotal: SCAN_BYTES_TOTAL,
      }),
    )
    const retry: number[] = []
    const got = new Set<number>()
    for (const m of res.messages) {
      got.add(m.gid)
      if (m.raw === null) {
        if (res.budgetExhausted && m.file !== 'none') retry.push(m.gid)
        else out.set(m.gid, { text: null })
        continue
      }
      const parsed = await parseMessage(Buffer.from(m.raw, 'base64'))
      out.set(m.gid, { text: parsed.ok ? parsed.text : null })
    }
    for (const g of res.missing) out.set(g, { text: null })
    // Weder geliefert noch als fehlend gemeldet: bei Budgetende nachfordern, sonst nicht verfuegbar.
    for (const g of pending) {
      if (got.has(g) || res.missing.includes(g)) continue
      if (res.budgetExhausted) retry.push(g)
      else out.set(g, { text: null })
    }
    // Ohne Fortschritt nicht endlos nachfordern; was dann fehlt, zaehlt als nicht verfuegbar.
    pending = retry.length < pending.length ? retry : []
  }
  return out
}

export async function scanBodies(a: {
  runner: HelperRunner
  policy: Policy
  config: Config
  filters: Record<string, unknown>
  term: string
  after: { d: number; g: number } | null
  limit: number
  now?: () => number
}): Promise<ScanResult> {
  const now = a.now ?? Date.now
  const started = now()
  const term = foldTerm(a.term)
  if (term === '') throw new HelperError('INVALID_INPUT', 'bodyContains must contain a visible character.')

  const matches: ScanResult['matches'] = []
  let scanned = 0
  let unavailable = 0
  let stoppedBy: ScanInfo['stoppedBy'] = null
  let resumeAfter: ScanResult['resumeAfter'] = null
  let cursor = a.after

  outer: for (;;) {
    const page = searchResult.parse(
      await a.runner.run('search', {
        allowedMailboxIds: a.policy.allowedMailboxIds,
        ...a.filters,
        ...(cursor ? { after: { date: cursor.d, gid: cursor.g } } : {}),
        limit: CANDIDATE_PAGE,
        maxRecipients: 5,
        countTotal: false,
      }),
    )
    const rows = page.messages
    for (let b = 0; b < rows.length; b += BATCH) {
      const batch = rows.slice(b, b + BATCH)
      let fetched: Map<number, Fetched> | null = null
      for (let i = 0; i < batch.length; i++) {
        // Mindestens ein Kandidat pro Aufruf, damit Weiterblaettern immer vorankommt.
        if (scanned > 0 && now() - started >= TIME_BUDGET_MS) {
          stoppedBy = 'time'
          break outer
        }
        fetched ??= await fetchBatch(a.runner, a.policy, batch)
        const row = batch[i]!
        scanned++
        resumeAfter = { d: row.dateReceived, g: row.gid }
        cursor = resumeAfter
        const text = fetched.get(row.gid)?.text ?? null
        if (text === null) {
          unavailable++
        } else {
          const verdict = classify({ subject: row.subject, fromAddress: row.sender === null || row.sender.address === '' ? null : row.sender.address, text })
          if (!verdict.security || a.config.showSecurityMails) {
            const ctx = findMatch(text, term)
            if (ctx !== null) matches.push({ row, matchContext: ctx })
          }
        }
        const more = i < batch.length - 1 || b + BATCH < rows.length || page.hasMore
        if (!more) break outer
        if (matches.length >= a.limit) {
          stoppedBy = 'limit'
          break outer
        }
        if (scanned >= CANDIDATE_CAP) {
          stoppedBy = 'cap'
          break outer
        }
      }
    }
    if (!page.hasMore || rows.length === 0) break
  }

  const complete = stoppedBy === null
  return {
    matches,
    scan: { scanned, unavailable, stoppedBy, complete },
    resumeAfter: complete ? null : resumeAfter,
  }
}
