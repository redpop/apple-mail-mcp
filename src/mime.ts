import PostalMime from 'postal-mime'
import { convert } from 'html-to-text'

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

/** Alle Zeichensatz-Angaben aus Content-Type-Kopfzeilen (inklusive Fortsetzungszeilen). */
function declaredCharsets(raw: Buffer): string[] {
  const out: string[] = []
  const lines = raw.toString('latin1').split(/\r?\n/)
  let inContentType = false
  for (const line of lines) {
    if (/^content-type:/i.test(line)) inContentType = true
    else if (!/^[ \t]/.test(line)) inContentType = false
    if (!inContentType) continue
    for (const m of line.matchAll(/charset\s*=\s*"?([A-Za-z0-9_.:-]+)/gi)) out.push(m[1] as string)
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

function normalise(s: string): string {
  return s
    .normalize('NFC')
    .replace(/\r\n?/g, '\n')
    .replace(/\n{4,}/g, '\n\n\n')
    .trim()
}

function htmlToText(html: string): string {
  return convert(html, {
    wordwrap: false,
    selectors: [
      { selector: 'a', options: { linkBrackets: ['[', ']'], hideLinkHrefIfSameAsText: true } },
      { selector: 'img', format: 'skip' },
    ],
  })
}

/** Rahmen entfernen, MIME parsen, HTML zu Text, normalisieren. Wirft nie. */
export async function parseMessage(raw: Buffer): Promise<ParsedMessage> {
  try {
    const mime = stripEmlxFrame(raw)
    const charsets = declaredCharsets(mime)
    const unknownOnly = charsets.length > 0 && !charsets.some(isKnownCharset)
    if (unknownOnly) return { ok: false }

    const email = await PostalMime.parse(mime)
    let text: string
    let format: 'plain' | 'html'
    if (typeof email.text === 'string' && email.text.trim() !== '') {
      text = email.text
      format = 'plain'
    } else if (typeof email.html === 'string' && email.html.trim() !== '') {
      text = htmlToText(email.html)
      format = 'html'
    } else {
      return { ok: false }
    }

    return {
      ok: true,
      text: normalise(text),
      format,
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
