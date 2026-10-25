import PostalMime, { type Email } from 'postal-mime'
import { convert } from 'html-to-text'
import { trimForScan } from './mimeTrim.js'
import { quickHtmlText } from './quickHtml.js'

export interface Address {
  address: string
  name: string | null
}

export type ParsedMessage =
  | {
      ok: true
      text: string
      format: 'plain' | 'html'
      headers: { from: Address | null; to: Address[]; cc: Address[]; replyTo: Address[]; date: Date | null }
    }
  | { ok: false }

/**
 * Entfernt den .emlx-Rahmen: erste Zeile ist die Laenge der Nachricht in Bytes,
 * der Rest (Plist) wird verworfen. Ohne Zahl oder bei zu grosser Laenge bleibt alles.
 */
export function stripEmlxFrame(raw: Buffer): Buffer {
  const nl = raw.indexOf(0x0a)
  if (nl < 1 || nl > 20) return raw
  const first = raw.subarray(0, nl).toString('latin1').trim()
  if (!/^\d+$/.test(first)) return raw
  const length = Number(first)
  const body = raw.subarray(nl + 1)
  if (!Number.isSafeInteger(length) || length > body.length) return body
  return body.subarray(0, length)
}

/**
 * Alle Zeichensatz-Angaben aus Content-Type-Kopfzeilen (inklusive Fortsetzungszeilen).
 * Sucht die Kopfzeilen direkt, statt die ganze Nachricht in Zeilen zu zerlegen; Zeilen enden
 * an LF, ein CR davor gehoert nicht zur Zeile (wie ein Split an /\r?\n/).
 */
export function declaredCharsets(raw: Buffer): string[] {
  const out: string[] = []
  const s = raw.toString('latin1')
  const header = /(?:^|\n)content-type:/gi
  for (const h of s.matchAll(header)) {
    let start = h[0].startsWith('\n') ? h.index + 1 : h.index
    for (;;) {
      const nl = s.indexOf('\n', start)
      const end = nl < 0 ? s.length : nl
      const line = s.slice(start, end > start && s.charCodeAt(end - 1) === 0x0d && nl >= 0 ? end - 1 : end)
      for (const m of line.matchAll(/charset\s*=\s*"?([A-Za-z0-9_.:-]+)/gi)) out.push(m[1] as string)
      if (nl < 0) break
      start = nl + 1
      const next = s.charCodeAt(start)
      if (next !== 0x20 && next !== 0x09) break
    }
  }
  return out
}

function isKnownCharset(label: string): boolean {
  try {
    new TextDecoder(label)
    return true
  } catch {
    return false
  }
}

function toAddress(a: { address?: string; name?: string }): Address | null {
  if (!a.address) return null
  return { address: a.address, name: a.name ? a.name : null }
}

function toAddresses(list: { address?: string; name?: string }[] | undefined): Address[] {
  return (list ?? []).map(toAddress).filter((a): a is Address => a !== null)
}

export function normalise(s: string): string {
  return s
    .normalize('NFC')
    .replace(/\r\n?/g, '\n')
    .replace(/\n{4,}/g, '\n\n\n')
    .trim()
}

export function htmlToText(html: string): string {
  return convert(html, {
    wordwrap: false,
    selectors: [
      { selector: 'a', options: { linkBrackets: ['[', ']'], hideLinkHrefIfSameAsText: true } },
      { selector: 'img', format: 'skip' },
    ],
  })
}

type Source = { format: 'plain'; text: string } | { format: 'html'; html: string }

/**
 * Zeichensaetze pruefen, MIME parsen und den Textteil waehlen: `text`, sonst `html`. Null, wenn
 * nur unbekannte Zeichensaetze angegeben sind oder kein Text vorliegt. Erwartet die Nachricht
 * ohne .emlx-Rahmen.
 */
async function decode(mime: Buffer): Promise<{ email: Email; source: Source } | null> {
  const charsets = declaredCharsets(mime)
  const unknownOnly = charsets.length > 0 && !charsets.some(isKnownCharset)
  if (unknownOnly) return null

  const email = await PostalMime.parse(mime)
  if (typeof email.text === 'string' && email.text.trim() !== '') return { email, source: { format: 'plain', text: email.text } }
  if (typeof email.html === 'string' && email.html.trim() !== '') return { email, source: { format: 'html', html: email.html } }
  return null
}

/** Rahmen entfernen, MIME parsen, HTML zu Text, normalisieren. Wirft nie. */
export async function parseMessage(raw: Buffer): Promise<ParsedMessage> {
  try {
    const decoded = await decode(stripEmlxFrame(raw))
    if (decoded === null) return { ok: false }
    const { email, source } = decoded
    const text = source.format === 'plain' ? source.text : htmlToText(source.html)

    return {
      ok: true,
      text: normalise(text),
      format: source.format,
      headers: {
        from: email.from ? toAddress(email.from) : null,
        to: toAddresses(email.to),
        cc: toAddresses(email.cc),
        replyTo: toAddresses(email.replyTo),
        date: email.date && !Number.isNaN(new Date(email.date).getTime()) ? new Date(email.date) : null,
      },
    }
  } catch {
    return { ok: false }
  }
}

/**
 * Text fuer den Body-Scan. Ist `exact` gesetzt, ist `quick` genau der Text von parseMessage.
 * Sonst ist `quick` nur eine Naeherung zum Vorfiltern: bei reinem HTML die grobe Fassung
 * (quickHtmlText), bei einer fuer den Scan gekuerzten Nachricht (trimForScan) der Text ohne die
 * entfernten Teile. null heisst: kein verlaesslicher Vorfilter (unbekanntes Entity), gleich
 * `full()` pruefen. `full()` liefert dann den Text von parseMessage aus der ungekuerzten
 * Nachricht, oder null, wenn er nicht entsteht. So zahlt nur ein moeglicher Treffer den teuren
 * Weg, und Treffer sowie Sicherheitspruefung sehen denselben Text wie get_message. Wirft nie.
 */
export type ScanBody =
  | { ok: false }
  | { ok: true; exact: true; quick: string; full: () => Promise<string | null> }
  | { ok: true; exact: false; quick: string | null; full: () => Promise<string | null> }

export async function parseForScan(raw: Buffer): Promise<ScanBody> {
  try {
    const mime = stripEmlxFrame(raw)
    const trimmed = trimForScan(mime)
    let decoded = trimmed === null ? null : await decode(trimmed).catch(() => null)
    const approximate = decoded !== null
    // Ungekuerzt, oder gekuerzt kein Text (etwa leerer Klartext neben entferntem HTML).
    decoded ??= await decode(mime)
    if (decoded === null) return { ok: false }
    const { source } = decoded
    const full = async (): Promise<string | null> => {
      const parsed = await parseMessage(raw)
      return parsed.ok ? parsed.text : null
    }
    if (source.format === 'plain') {
      const text = normalise(source.text)
      if (approximate) return { ok: true, exact: false, quick: text, full }
      return { ok: true, exact: true, quick: text, full: async () => text }
    }
    const quick = quickHtmlText(source.html)
    return { ok: true, exact: false, quick: quick.sure ? quick.text : null, full }
  } catch {
    return { ok: false }
  }
}

/** Kuerzt an einer Wortgrenze. `totalChars` ist die Laenge vor dem Kuerzen. */
export function truncateText(
  text: string,
  maxChars: number,
): { text: string; truncated: boolean; totalChars: number } {
  const totalChars = text.length
  if (totalChars <= maxChars) return { text, truncated: false, totalChars }
  let cut = text.slice(0, maxChars)
  // Mitten im Wort? Dann bis zum letzten Leerraum zurueck.
  if (!/\s/.test(text.charAt(maxChars))) {
    const ws = cut.search(/\s\S*$/)
    if (ws > 0) cut = cut.slice(0, ws)
  }
  return { text: cut.trimEnd(), truncated: true, totalChars }
}
