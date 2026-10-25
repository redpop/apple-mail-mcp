/**
 * Grobe, schnelle HTML-zu-Text-Fassung, nur zum Vorfiltern im Body-Scan. Sie entfernt Tags,
 * Kommentare sowie den Inhalt von <script>, <style> und (wenn es einen <body> gibt) <title>,
 * haengt Linkziele hinter den Linktext wie html-to-text und dekodiert die gaengigen Entities.
 * Leerraum ist hier bedeutungslos: der Scan vergleicht diese Fassung ohne jeden Leerraum.
 * Ein Treffer wird danach immer am Text von html-to-text bestaetigt; diese Fassung entscheidet
 * also nie allein ueber Treffer oder Sicherheitsmails.
 *
 * Laeuft linear: jede Suche beginnt hinter der vorigen Fundstelle, es gibt keine Regex mit
 * Rueckverfolgung ueber den ganzen Text (die Eingabe ist nicht vertrauenswuerdig).
 */

// Latin-1-Entities ab U+00A0 in Codepoint-Reihenfolge.
const LATIN1 =
  'nbsp iexcl cent pound curren yen brvbar sect uml copy ordf laquo not shy reg macr deg plusmn sup2 sup3 acute micro para middot cedil sup1 ordm raquo frac14 frac12 frac34 iquest ' +
  'Agrave Aacute Acirc Atilde Auml Aring AElig Ccedil Egrave Eacute Ecirc Euml Igrave Iacute Icirc Iuml ETH Ntilde Ograve Oacute Ocirc Otilde Ouml times Oslash Ugrave Uacute Ucirc Uuml Yacute THORN szlig ' +
  'agrave aacute acirc atilde auml aring aelig ccedil egrave eacute ecirc euml igrave iacute icirc iuml eth ntilde ograve oacute ocirc otilde ouml divide oslash ugrave uacute ucirc uuml yacute thorn yuml'

const NAMED = new Map<string, string>([
  ['amp', '&'], ['lt', '<'], ['gt', '>'], ['quot', '"'], ['apos', "'"],
  ['euro', '€'], ['ndash', '–'], ['mdash', '—'], ['lsquo', '‘'], ['rsquo', '’'],
  ['sbquo', '‚'], ['ldquo', '“'], ['rdquo', '”'], ['bdquo', '„'], ['hellip', '…'],
  ['bull', '•'], ['trade', '™'], ['dagger', '†'], ['Dagger', '‡'], ['permil', '‰'],
  ['lsaquo', '‹'], ['rsaquo', '›'], ['oelig', 'œ'], ['OElig', 'Œ'], ['scaron', 'š'],
  ['Scaron', 'Š'], ['Yuml', 'Ÿ'], ['fnof', 'ƒ'], ['circ', 'ˆ'], ['tilde', '˜'],
  ['ensp', ' '], ['emsp', ' '], ['thinsp', ' '], ['zwnj', '‌'], ['zwj', '‍'],
  ['lrm', '‎'], ['rlm', '‏'], ['larr', '←'], ['rarr', '→'], ['uarr', '↑'], ['darr', '↓'],
])
LATIN1.split(' ').forEach((name, i) => NAMED.set(name, String.fromCharCode(0xa0 + i)))

// Numerische Verweise auf 0x80-0x9F meinen nach HTML-Spezifikation Windows-1252.
const C1 = '€\u0081‚ƒ„…†‡ˆ‰Š‹Œ\u008dŽ\u008f\u0090‘’“”•–—˜™š›œ\u009džŸ'

function codePoint(n: number): string {
  if (n >= 0x80 && n <= 0x9f) return C1[n - 0x80]!
  if (n === 0 || n > 0x10ffff || (n >= 0xd800 && n <= 0xdfff)) return '�'
  return String.fromCodePoint(n)
}

export function decodeEntities(s: string): string {
  if (!s.includes('&')) return s
  return s.replace(/&(?:#(\d{1,7})|#[xX]([0-9a-fA-F]{1,6})|([A-Za-z][A-Za-z0-9]{1,31}));?/g, (m, dec?: string, hex?: string, name?: string) => {
    if (dec !== undefined) return codePoint(Number(dec))
    if (hex !== undefined) return codePoint(parseInt(hex, 16))
    return NAMED.get(name!) ?? m
  })
}

const NAME = /^\/?([A-Za-z][A-Za-z0-9:-]*)/
const HREF = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/i

/** Sucht das schliessende Tag ab `from`; Ende des Textes, wenn es fehlt. */
function closingTag(html: string, name: string, from: number): number {
  const re = new RegExp(`</${name}[\\s/>]`, 'gi')
  re.lastIndex = from
  const m = re.exec(html)
  return m === null ? html.length : m.index
}

const isLetter = (c: number): boolean => (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a)

export function quickHtmlText(html: string): string {
  const parts: string[] = []
  const skip = new Set(['script', 'style'])
  if (/<body[\s/>]/i.test(html)) skip.add('title')
  let link: { href: string; at: number } | null = null
  let i = 0
  const n = html.length
  while (i < n) {
    const lt = html.indexOf('<', i)
    if (lt < 0) {
      parts.push(decodeEntities(html.slice(i)))
      break
    }
    const next = html.charCodeAt(lt + 1)
    const isTag = isLetter(next) || (next === 0x2f && isLetter(html.charCodeAt(lt + 2))) || next === 0x21 || next === 0x3f
    if (!isTag) {
      // Ein "<" ohne Tag ist Text.
      parts.push(decodeEntities(html.slice(i, lt + 1)))
      i = lt + 1
      continue
    }
    if (lt > i) parts.push(decodeEntities(html.slice(i, lt)))
    if (html.startsWith('<!--', lt)) {
      const end = html.indexOf('-->', lt + 4)
      i = end < 0 ? n : end + 3
      parts.push(' ')
      continue
    }
    const gt = html.indexOf('>', lt + 1)
    if (gt < 0) break
    const tag = html.slice(lt + 1, gt)
    i = gt + 1
    parts.push(' ')
    const name = NAME.exec(tag)?.[1]?.toLowerCase()
    if (name === undefined) continue
    const closing = tag.startsWith('/')
    if (!closing && skip.has(name) && !tag.endsWith('/')) {
      i = closingTag(html, name, i)
      continue
    }
    if (name !== 'a') continue
    if (!closing) {
      const h = HREF.exec(tag)
      const href = h === null ? '' : decodeEntities(h[1] ?? h[2] ?? h[3] ?? '').trim()
      link = href === '' || href.startsWith('#') ? null : { href, at: parts.length }
    } else if (link !== null) {
      // Wie html-to-text: Ziel in Klammern hinter dem Text, ausser es gleicht dem Text.
      const text = parts.slice(link.at).join('').trim()
      if (text !== link.href && `mailto:${text}` !== link.href) parts.push(` [${link.href}] `)
      link = null
    }
  }
  return parts.join('').normalize('NFC')
}
