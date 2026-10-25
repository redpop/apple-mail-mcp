import type { Config } from './config.js'
import { fold } from './fold.js'
import type { HelperRunner } from './helper.js'
import { parseForScan } from './mime.js'
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
 * (ß wird zu ss). Pro Codepoint zu falten weicht bei kontextabhaengigen Faellen (griechisches
 * Schluss-Sigma) von der Faltung des ganzen Strings ab, und NFC kann pro Codepoint nichts
 * zusammensetzen: ein zerlegtes "o" + Trema bleibt zerlegt. Deshalb wird der Suchbegriff vorher
 * als Ganzes nach NFC gebracht (foldTerm); Mailtexte sind praktisch immer schon NFC.
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

const foldCache = new Map<string, string>()

/** fold fuer einen Lauf ohne ASCII, pro Codepoint wie foldWithMap (mit Zwischenspeicher). */
function foldRun(run: string): string {
  let out = ''
  for (const ch of run) {
    let f = foldCache.get(ch)
    if (f === undefined) {
      f = fold(ch)
      if (foldCache.size < 4096) foldCache.set(ch, f)
    }
    out += f
  }
  return out
}

// Unterhalb von U+0340 gleicht fold(c) fuer jedes Zeichen ausser dem scharfen s (U+00DF) dem
// einfachen toLowerCase
// (tests/bodyScan.test.ts prueft das fuer jeden Codepoint); nur der Rest braucht fold pro Zeichen.
const NEEDS_FOLD = /\u00df|[^\x00-\u033f]+/g

/**
 * Liefert genau foldWithMap(text).folded, nur schnell: U+00DF und Laeufe ab U+0340 werden pro
 * Codepoint gefaltet, danach schreibt toLowerCase den Rest klein. Das ist gleichwertig, weil die
 * Ausgabe von fold fuer jeden Codepoint schon klein ist (toLowerCase aendert sie nicht) und kein
 * grosses Sigma enthaelt, die einzige kontextabhaengige Abbildung von toLowerCase. Die
 * Positionstabelle entsteht erst bei einem Treffer (findMatch).
 */
export function foldFast(text: string): string {
  return text.replace(NEEDS_FOLD, foldRun).toLowerCase()
}

/** Suchbegriff: erst als Ganzes NFC (zerlegte Umlaute aus der Eingabe), dann wie der Text falten. */
function foldTerm(term: string): string {
  return collapse(foldWithMap(collapse(term.normalize('NFC'))).folded)
}

/** Erste Fundstelle des gefalteten Begriffs; Kontext aus dem Original (nur Leerraum zusammengezogen). */
export function findMatch(rawText: string, foldedTerm: string): string | null {
  const text = collapse(rawText)
  if (!foldFast(text).includes(foldedTerm)) return null
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

/** Holt die Rohtexte eines Blocks (base64, null = nicht verfuegbar). Geparst wird erst im Scan. */
async function fetchBatch(runner: HelperRunner, policy: Policy, batch: MessageRow[]): Promise<Map<number, string | null>> {
  const out = new Map<number, string | null>()
  let pending = batch.filter((r) => r.file !== 'none').map((r) => r.gid)
  for (const r of batch) if (r.file === 'none') out.set(r.gid, null)
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
        else out.set(m.gid, null)
        continue
      }
      out.set(m.gid, m.raw)
    }
    for (const g of res.missing) out.set(g, null)
    // Weder geliefert noch als fehlend gemeldet: bei Budgetende nachfordern, sonst nicht verfuegbar.
    for (const g of pending) {
      if (got.has(g) || res.missing.includes(g)) continue
      if (res.budgetExhausted) retry.push(g)
      else out.set(g, null)
    }
    // Ohne Fortschritt nicht endlos nachfordern; was dann fehlt, zaehlt als nicht verfuegbar.
    pending = retry.length < pending.length ? retry : []
  }
  return out
}

// Leerraum fuer den Vorfilter; U+200B zaehlt dazu, wie bei html-to-text.
const LOOSE_SPACE = /[\s\u200b]+/g

/**
 * Prueft eine Nachricht: Treffer-Kontext, null ohne Treffer, undefined wenn nicht verfuegbar.
 * Erst wird gesucht, dann klassifiziert: die Klassifikation entscheidet nur ueber Treffer.
 * Ist der Scan-Text nur eine Naeherung (reines HTML oder gekuerzte Nachricht, siehe
 * parseForScan), filtert er ohne Leerraum vor; ein moeglicher Treffer wird am Text von
 * parseMessage bestaetigt, und genau dieser Text geht in die Sicherheitspruefung (E2).
 *
 * "Nicht verfuegbar" haengt nur vom Rohtext und vom schnellen Parsen ab, nie vom Suchbegriff.
 * Scheitert der volle Text nach einem Vorfilter-Treffer, zaehlt das wie ein Fehlschlag des
 * Vorfilters. Sonst verriete `unavailable` bei Begriffen wie "4", "48", ... einen Code.
 */
export async function examine(raw: string, row: MessageRow, term: string, looseTerm: string, showSecurityMails: boolean): Promise<string | null | undefined> {
  const body = await parseForScan(Buffer.from(raw, 'base64'))
  if (!body.ok) return undefined
  let text: string | null = body.quick
  if (!body.exact) {
    if (body.quick !== null && !foldFast(body.quick.replace(LOOSE_SPACE, '')).includes(looseTerm)) return null
    text = await body.full()
  }
  if (text === null) return null
  const ctx = findMatch(text, term)
  if (ctx === null) return null
  if (showSecurityMails) return ctx
  const verdict = classify({ subject: row.subject, fromAddress: row.sender === null || row.sender.address === '' ? null : row.sender.address, text })
  return verdict.security ? null : ctx
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
  const looseTerm = term.replace(LOOSE_SPACE, '')

  const matches: ScanResult['matches'] = []
  let scanned = 0
  let unavailable = 0
  let stoppedBy: ScanInfo['stoppedBy'] = null
  let resumeAfter: ScanResult['resumeAfter'] = null
  let cursor = a.after

  // Zeitbudget vor jedem Helper-Abruf und vor jeder Nachricht pruefen. Mindestens ein Kandidat
  // pro Aufruf, damit Weiterblaettern immer vorankommt.
  const timeUp = (): boolean => scanned > 0 && now() - started >= TIME_BUDGET_MS

  outer: for (;;) {
    if (timeUp()) {
      stoppedBy = 'time'
      break
    }
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
      if (timeUp()) {
        stoppedBy = 'time'
        break outer
      }
      const batch = rows.slice(b, b + BATCH)
      const fetched = await fetchBatch(a.runner, a.policy, batch)
      for (let i = 0; i < batch.length; i++) {
        if (timeUp()) {
          stoppedBy = 'time'
          break outer
        }
        const row = batch[i]!
        scanned++
        resumeAfter = { d: row.dateReceived, g: row.gid }
        cursor = resumeAfter
        const raw = fetched.get(row.gid) ?? null
        const ctx = raw === null ? undefined : await examine(raw, row, term, looseTerm, a.config.showSecurityMails)
        if (ctx === undefined) unavailable++
        else if (ctx !== null) matches.push({ row, matchContext: ctx })
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
