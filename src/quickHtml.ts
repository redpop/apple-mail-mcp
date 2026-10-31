/**
 * Grobe, schnelle HTML-zu-Text-Fassung, nur zum Vorfiltern im Body-Scan. Sie entfernt Tags,
 * Kommentare sowie den Inhalt von <script>, <style> und <title> im Kopf (vor <body>), haengt
 * Linkziele hinter den Linktext wie html-to-text und dekodiert Entities nach den Regeln von
 * HTML, soweit die Tabelle unten reicht. Leerraum ist hier bedeutungslos: der Scan vergleicht
 * diese Fassung ohne jeden Leerraum. Ein Treffer wird danach immer am Text von html-to-text
 * bestaetigt; diese Fassung entscheidet also nie allein ueber Treffer oder Sicherheitsmails.
 *
 * `sure` ist false, wenn ein benanntes Entity mit Semikolon vorkommt, das die Tabelle nicht
 * kennt. Es bleibt dann unveraendert im Text, und html-to-text erzeugt dort ein Zeichen, das hier
 * fehlt. Fuer Suchbegriffe, die termSurvivesUnknownEntities erfuellt, taugt die Fassung trotzdem
 * als Vorfilter; fuer alle anderen prueft der Scan die Nachricht am vollen Text.
 *
 * Laeuft linear: jede Suche beginnt hinter der vorigen Fundstelle, es gibt keine Regex mit
 * Rueckverfolgung ueber den ganzen Text (die Eingabe ist nicht vertrauenswuerdig).
 */

// Latin-1-Entities ab U+00A0 in Codepoint-Reihenfolge. Sie sind zugleich (mit amp, lt, gt, quot
// und den Grossformen unten) die Legacy-Namen, die HTML auch ohne Semikolon dekodiert.
const LATIN1 =
  'nbsp iexcl cent pound curren yen brvbar sect uml copy ordf laquo not shy reg macr deg plusmn sup2 sup3 acute micro para middot cedil sup1 ordm raquo frac14 frac12 frac34 iquest ' +
  'Agrave Aacute Acirc Atilde Auml Aring AElig Ccedil Egrave Eacute Ecirc Euml Igrave Iacute Icirc Iuml ETH Ntilde Ograve Oacute Ocirc Otilde Ouml times Oslash Ugrave Uacute Ucirc Uuml Yacute THORN szlig ' +
  'agrave aacute acirc atilde auml aring aelig ccedil egrave eacute ecirc euml igrave iacute icirc iuml eth ntilde ograve oacute ocirc otilde ouml divide oslash ugrave uacute ucirc uuml yacute thorn yuml'

const LEGACY_EXTRA: Array<[string, number]> = [
  ['amp', 0x26], ['lt', 0x3c], ['gt', 0x3e], ['quot', 0x22],
  ['AMP', 0x26], ['LT', 0x3c], ['GT', 0x3e], ['QUOT', 0x22], ['COPY', 0xa9], ['REG', 0xae],
]

// Nur mit Semikolon gueltig.
const OTHER: Array<[string, number | string]> = [
  ['apos', 0x27], ['euro', 0x20ac], ['ndash', 0x2013], ['mdash', 0x2014], ['lsquo', 0x2018], ['rsquo', 0x2019],
  ['sbquo', 0x201a], ['ldquo', 0x201c], ['rdquo', 0x201d], ['bdquo', 0x201e], ['hellip', 0x2026],
  ['bull', 0x2022], ['trade', 0x2122], ['dagger', 0x2020], ['Dagger', 0x2021], ['permil', 0x2030],
  ['lsaquo', 0x2039], ['rsaquo', 0x203a], ['oelig', 0x153], ['OElig', 0x152], ['scaron', 0x161],
  ['Scaron', 0x160], ['Yuml', 0x178], ['fnof', 0x192], ['circ', 0x2c6], ['tilde', 0x2dc],
  ['ensp', 0x2002], ['emsp', 0x2003], ['thinsp', 0x2009], ['zwnj', 0x200c], ['zwj', 0x200d],
  ['lrm', 0x200e], ['rlm', 0x200f], ['larr', 0x2190], ['rarr', 0x2192], ['uarr', 0x2191], ['darr', 0x2193],
  // Alle uebrigen Entities, die druckbares ASCII, einen Latin-1-Buchstaben oder nur Leerraum
  // ergeben (siehe termSurvivesUnknownEntities; tests/mime.test.ts prueft die volle Tabelle).
  ['excl', 0x21], ['num', 0x23], ['dollar', 0x24], ['percnt', 0x25], ['lpar', 0x28], ['rpar', 0x29],
  ['ast', 0x2a], ['midast', 0x2a], ['plus', 0x2b], ['comma', 0x2c], ['period', 0x2e], ['sol', 0x2f],
  ['colon', 0x3a], ['semi', 0x3b], ['equals', 0x3d], ['quest', 0x3f], ['commat', 0x40],
  ['lsqb', 0x5b], ['lbrack', 0x5b], ['bsol', 0x5c], ['rsqb', 0x5d], ['rbrack', 0x5d], ['Hat', 0x5e],
  ['lowbar', 0x5f], ['UnderBar', 0x5f], ['grave', 0x60], ['DiacriticalGrave', 0x60],
  ['lcub', 0x7b], ['lbrace', 0x7b], ['verbar', 0x7c], ['vert', 0x7c], ['VerticalLine', 0x7c],
  ['rcub', 0x7d], ['rbrace', 0x7d], ['bne', '=\u20e5'], ['nvlt', '<\u20d2'], ['nvgt', '>\u20d2'],
  ['fjlig', 'fj'], ['Idot', 0x130], ['angst', 0xc5],
  ['Tab', 0x09], ['NewLine', 0x0a], ['NonBreakingSpace', 0xa0], ['numsp', 0x2007], ['puncsp', 0x2008],
  ['emsp13', 0x2004], ['emsp14', 0x2005], ['ThinSpace', 0x2009], ['hairsp', 0x200a], ['VeryThinSpace', 0x200a],
  ['MediumSpace', 0x205f], ['ThickSpace', '\u205f\u200a'], ['ZeroWidthSpace', 0x200b],
  ['NegativeVeryThinSpace', 0x200b], ['NegativeThinSpace', 0x200b], ['NegativeMediumSpace', 0x200b],
  ['NegativeThickSpace', 0x200b],
]

const NAMED = new Map<string, string>()
const LEGACY = new Set<string>()
LATIN1.split(' ').forEach((name, i) => {
  NAMED.set(name, String.fromCharCode(0xa0 + i))
  LEGACY.add(name)
})
for (const [name, cp] of LEGACY_EXTRA) {
  NAMED.set(name, String.fromCharCode(cp))
  LEGACY.add(name)
}
for (const [name, v] of OTHER) NAMED.set(name, typeof v === 'string' ? v : String.fromCharCode(v))
const LEGACY_MAX = Math.max(...[...LEGACY].map((n) => n.length))

// Zeichen, die nach Faltung kein unbekanntes Entity erzeugt: druckbares ASCII und die kleinen
// Latin-1-Buchstaben. Kein Entity ausserhalb der Tabelle ergibt nur Leerraum.
const SURVIVES = /^[\x21-\x7e\u00e0-\u00f6\u00f8-\u00ff]*$/

/**
 * Ob die Fassung trotz unbekannter Entities (`sure` false) jeden Treffer fuer diesen Begriff
 * enthaelt. `looseTerm` ist gefaltet und ohne Leerraum. Ein unbekanntes Entity ergibt dann ein
 * Zeichen, das nicht im Begriff vorkommen kann und auch nicht wegfaellt: ein Treffer liegt ganz
 * davor oder dahinter, und dort gleichen sich beide Fassungen.
 */
export function termSurvivesUnknownEntities(looseTerm: string): boolean {
  return SURVIVES.test(looseTerm)
}

// Numerische Verweise auf 0x80-0x9F meinen nach HTML-Spezifikation Windows-1252 (0 = undefiniert).
const C1 = [
  0x20ac, 0x81, 0x201a, 0x192, 0x201e, 0x2026, 0x2020, 0x2021, 0x2c6, 0x2030, 0x160, 0x2039, 0x152, 0x8d, 0x17d, 0x8f,
  0x90, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014, 0x2dc, 0x2122, 0x161, 0x203a, 0x153, 0x9d, 0x17e, 0x178,
]

function codePoint(n: number): string {
  if (n >= 0x80 && n <= 0x9f) return String.fromCharCode(C1[n - 0x80]!)
  if (!(n > 0) || n > 0x10ffff || (n >= 0xd800 && n <= 0xdfff)) return String.fromCharCode(0xfffd)
  return String.fromCodePoint(n)
}

/**
 * Dekodiert Entities wie HTML: mit Semikolon jeder bekannte Name, ohne Semikolon das laengste
 * Legacy-Praefix (im Attribut nicht, wenn danach ein Buchstabe, eine Ziffer oder "=" folgt).
 * `sure` ist false bei einem unbekannten Namen mit Semikolon.
 */
export function decodeEntities(s: string, inAttribute = false): { text: string; sure: boolean } {
  if (!s.includes('&')) return { text: s, sure: true }
  let sure = true
  const text = s.replace(
    /&(?:#(\d+)|#[xX]([0-9a-fA-F]+)|([A-Za-z][A-Za-z0-9]*))(;?)/g,
    (m: string, dec: string | undefined, hex: string | undefined, name: string | undefined, semi: string, offset: number) => {
      if (dec !== undefined) return codePoint(Number(dec))
      if (hex !== undefined) return codePoint(parseInt(hex, 16))
      const n = name!
      if (semi === ';') {
        const v = NAMED.get(n)
        if (v !== undefined) return v
        sure = false
        return m
      }
      for (let k = Math.min(n.length, LEGACY_MAX); k >= 2; k--) {
        const prefix = n.slice(0, k)
        if (!LEGACY.has(prefix)) continue
        if (inAttribute && (k < n.length || s.charCodeAt(offset + m.length) === 0x3d)) return m
        return NAMED.get(prefix)! + n.slice(k)
      }
      return m
    },
  )
  return { text, sure }
}

const NAME = /^\/?([A-Za-z][A-Za-z0-9:-]*)/
// Leerraum im Sinne von html-to-text (Option whitespaceCharacters).
const H2T_SPACE = /[ \t\r\n\f\u200b]+/g
const HREF = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/i

/** Sucht das schliessende Tag ab `from`; Ende des Textes, wenn es fehlt. */
function closingTag(html: string, name: string, from: number): number {
  const re = new RegExp(`</${name}[\\s/>]`, 'gi')
  re.lastIndex = from
  const m = re.exec(html)
  return m === null ? html.length : m.index
}

/**
 * Ende eines Tags (Position des ">") ab `from`. Ein ">" in einem Attributwert in Anfuehrungs-
 * zeichen (alt="Weiter >") beendet das Tag nicht. -1, wenn das Tag nicht endet.
 */
function tagEnd(html: string, from: number): number {
  let afterEquals = false
  for (let j = from; j < html.length; j++) {
    const c = html.charCodeAt(j)
    if (c === 0x3e) return j
    if (c === 0x3d) {
      afterEquals = true
      continue
    }
    if ((c === 0x22 || c === 0x27) && afterEquals) {
      const close = html.indexOf(html[j]!, j + 1)
      if (close < 0) return -1
      j = close
      afterEquals = false
      continue
    }
    if (c !== 0x20 && c !== 0x09 && c !== 0x0a && c !== 0x0d && c !== 0x0c) afterEquals = false
  }
  return -1
}

const isLetter = (c: number): boolean => (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a)

export function quickHtmlText(html: string): { text: string; sure: boolean } {
  const parts: string[] = []
  let sure = true
  const decode = (s: string, inAttribute = false): string => {
    const d = decodeEntities(s, inAttribute)
    if (!d.sure) sure = false
    return d.text
  }
  // <title> faellt nur im Kopf weg (html-to-text nimmt nur <body>); ein <title> in einem <svg>
  // im Body ist Text.
  const hasBody = /<body[\s/>]/i.test(html)
  let inBody = false
  let link: { href: string; at: number } | null = null
  let i = 0
  const n = html.length
  while (i < n) {
    const lt = html.indexOf('<', i)
    if (lt < 0) {
      parts.push(decode(html.slice(i)))
      break
    }
    const next = html.charCodeAt(lt + 1)
    const isTag = isLetter(next) || (next === 0x2f && isLetter(html.charCodeAt(lt + 2))) || next === 0x21 || next === 0x3f
    if (!isTag) {
      // Ein "<" ohne Tag ist Text.
      parts.push(decode(html.slice(i, lt + 1)))
      i = lt + 1
      continue
    }
    if (lt > i) parts.push(decode(html.slice(i, lt)))
    if (html.startsWith('<!--', lt)) {
      const end = html.indexOf('-->', lt + 4)
      i = end < 0 ? n : end + 3
      parts.push(' ')
      continue
    }
    const gt = tagEnd(html, lt + 1)
    if (gt < 0) break
    const tag = html.slice(lt + 1, gt)
    i = gt + 1
    parts.push(' ')
    const name = NAME.exec(tag)?.[1]?.toLowerCase()
    if (name === undefined) continue
    const closing = tag.startsWith('/')
    if (!closing && name === 'body') inBody = true
    const skip = name === 'script' || name === 'style' || (name === 'title' && hasBody && !inBody)
    if (!closing && skip && !tag.endsWith('/')) {
      i = closingTag(html, name, i)
      continue
    }
    if (name !== 'a') continue
    if (!closing) {
      // Wie html-to-text: "mailto:" faellt weg, ein leeres Ziel oder ein Anker ist kein Link.
      const h = HREF.exec(tag)
      const href = h === null ? '' : decode(h[1] ?? h[2] ?? h[3] ?? '', true).replace(/^mailto:/, '')
      link = href === '' || href.startsWith('#') ? null : { href, at: parts.length }
    } else if (link !== null) {
      // Wie html-to-text: Ziel in Klammern hinter dem Text, ohne Text das Ziel allein, und nichts,
      // wenn es dem Text gleicht. Verglichen wird der Text ohne Leerraum, denn html-to-text setzt
      // ihn aus den Woertern zusammen (auch ueber innere Tags wie <b> hinweg).
      const text = parts.slice(link.at).join('').replace(H2T_SPACE, '')
      if (text === '') parts.push(` ${link.href} `)
      else if (text !== link.href) parts.push(` [${link.href}] `)
      link = null
    }
  }
  return { text: parts.join('').normalize('NFC'), sure }
}
