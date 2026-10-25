/**
 * Kuerzt eine Nachricht fuer den Body-Scan: entfernt den Inhalt von Teilen, die postal-mime
 * nie in den Text uebernimmt (Anhaenge, Bilder, application/*, sonstige text/*-Typen) sowie den
 * HTML-Teil eines multipart/alternative, der einen Klartext-Teil daneben hat. postal-mime muss
 * diese Bytes dann nicht dekodieren; bei einem 200-KB-Anhang ist das fast die ganze Parse-Zeit.
 *
 * Die Kopfzeilen bleiben, nur Koerper fallen weg. Im Zweifel wird nichts gekuerzt (null): ohne
 * Multipart an der Wurzel, ohne Boundary, bei doppelt vergebener Boundary, doppelten
 * Content-Type-Kopfzeilen oder zu tiefer Verschachtelung. Die Grenzen werden wie in postal-mime
 * erkannt: Zeile beginnt mit "--" und einer aktiven Boundary (innerste zuerst), danach optional
 * "--" und nur noch Leerzeichen oder Tabs; abschliessende CR gehoeren nicht zur Zeile.
 *
 * Der Scan verlaesst sich darauf nicht: jeder Treffer in einer gekuerzten Nachricht wird am
 * ungekuerzten Text bestaetigt. Ein Fehler hier kann also einen Treffer verfehlen, aber nie
 * einen falschen oder eine Sicherheitsmail liefern.
 */

const MAX_DEPTH = 16
const MAX_PARTS = 2000

class Abort extends Error {}

interface Headers {
  type: string | null
  boundary: string | null
  disposition: string | null
  bodyStart: number
}

/** Zeilenende ohne LF; abschliessende CR werden wie in postal-mime abgeschnitten. */
function lineAt(s: string, start: number): { text: string; next: number } {
  const nl = s.indexOf('\n', start)
  let end = nl < 0 ? s.length : nl
  const next = nl < 0 ? s.length : nl + 1
  while (end > start && s.charCodeAt(end - 1) === 0x0d) end--
  return { text: s.slice(start, end), next }
}

/** Kopfblock ab `start` bis zur ersten Leerzeile vor `limit`; null, wenn keine Leerzeile kommt. */
function readHeaders(s: string, start: number, limit: number): Headers | null {
  const fields: string[] = []
  let p = start
  while (p < limit) {
    const { text, next } = lineAt(s, p)
    if (text === '') {
      return toHeaders(fields, next)
    }
    if ((text.startsWith(' ') || text.startsWith('\t')) && fields.length > 0) fields[fields.length - 1] += text
    else fields.push(text)
    p = next
  }
  return null
}

function toHeaders(fields: string[], bodyStart: number): Headers {
  let type: string | null = null
  let disposition: string | null = null
  let boundary: string | null = null
  let types = 0
  for (const f of fields) {
    const colon = f.indexOf(':')
    if (colon < 0) continue
    const key = f.slice(0, colon).trim().toLowerCase()
    const value = f.slice(colon + 1)
    if (key === 'content-type') {
      types++
      type = value.split(';')[0]!.trim().toLowerCase()
      const b = /;\s*boundary\s*=\s*(?:"([^"]*)"|([^;\s]+))/i.exec(value)
      boundary = b === null ? null : (b[1] ?? b[2] ?? null)
    } else if (key === 'content-disposition') {
      disposition = value.split(';')[0]!.trim().toLowerCase()
    }
  }
  if (types > 1) throw new Abort()
  return { type, boundary, disposition, bodyStart }
}

interface Delimiter {
  start: number
  next: number
  boundary: string
  terminator: boolean
}

/** Naechste Grenzzeile einer aktiven Boundary ab dem Zeilenanfang `from`. */
function nextDelimiter(s: string, from: number, active: string[]): Delimiter | null {
  let ls = s.startsWith('--', from) ? from : -1
  if (ls < 0) {
    const k = s.indexOf('\n--', from)
    ls = k < 0 ? -1 : k + 1
  }
  while (ls >= 0) {
    const { text, next } = lineAt(s, ls)
    for (let i = active.length - 1; i >= 0; i--) {
      const b = active[i]!
      if (!text.startsWith(b, 2)) continue
      let rest = text.slice(2 + b.length)
      const terminator = rest.startsWith('--')
      if (terminator) rest = rest.slice(2)
      if (/^[ \t]*$/.test(rest)) return { start: ls, next, boundary: b, terminator }
    }
    const k = s.indexOf('\n--', ls)
    ls = k < 0 ? -1 : k + 1
  }
  return null
}

const NEVER_TEXT = /^(?:application|image|audio|video|font|model)\//

function isDroppable(h: Headers, htmlHasPlainSibling: boolean): boolean {
  const type = h.type ?? 'text/plain'
  if (type.startsWith('multipart/') || type.startsWith('message/')) return false
  if (h.disposition === 'attachment') return true
  if (NEVER_TEXT.test(type)) return true
  if (type === 'text/html') return htmlHasPlainSibling
  return type.startsWith('text/') && type !== 'text/plain'
}

interface Walk {
  cuts: Array<[number, number]>
  parts: number
}

/** Geht die Teile eines Multipart-Koerpers durch, der bei `from` beginnt. */
function walk(s: string, from: number, boundary: string, subtype: string, outer: string[], depth: number, w: Walk): void {
  if (depth > MAX_DEPTH || boundary === '' || outer.includes(boundary)) throw new Abort()
  const active = [...outer, boundary]
  const children: Array<{ h: Headers; end: number }> = []
  let d = nextDelimiter(s, from, active)
  // Vorspann bis zur ersten eigenen Grenze; endet sie vorher an einer aeusseren, gibt es keine Teile.
  while (d !== null && d.boundary === boundary && !d.terminator) {
    if (++w.parts > MAX_PARTS) throw new Abort()
    const next = nextDelimiter(s, d.next, active)
    const end = next === null ? s.length : next.start
    const h = readHeaders(s, d.next, end)
    if (h !== null) children.push({ h, end })
    d = next
  }
  const hasPlain = subtype === 'alternative' && children.some(({ h }) => (h.type ?? 'text/plain') === 'text/plain' && h.disposition !== 'attachment')
  for (const { h, end } of children) {
    const type = h.type ?? 'text/plain'
    if (type.startsWith('multipart/')) {
      if (h.boundary === null) throw new Abort()
      walk(s, h.bodyStart, h.boundary, type.slice('multipart/'.length), active, depth + 1, w)
    } else if (end > h.bodyStart && isDroppable(h, hasPlain)) {
      w.cuts.push([h.bodyStart, end])
    }
  }
}

export function trimForScan(mime: Buffer): Buffer | null {
  const s = mime.toString('latin1')
  try {
    const root = readHeaders(s, 0, s.length)
    if (root === null || root.type === null || !root.type.startsWith('multipart/')) return null
    if (root.boundary === null) return null
    const w: Walk = { cuts: [], parts: 0 }
    walk(s, root.bodyStart, root.boundary, root.type.slice('multipart/'.length), [], 0, w)
    if (w.cuts.length === 0) return null
    w.cuts.sort((a, b) => a[0] - b[0])
    let out = ''
    let at = 0
    for (const [start, end] of w.cuts) {
      if (start < at) return null
      out += s.slice(at, start)
      at = end
    }
    out += s.slice(at)
    return Buffer.from(out, 'latin1')
  } catch (e) {
    if (e instanceof Abort) return null
    throw e
  }
}
