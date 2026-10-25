import { fold } from './fold.js'
import { SECURITY_KEYWORDS, SUBJECT_CODE_WORDS } from './securityMail.data.js'

const WORD_START = '(?<![\\p{L}\\p{N}])'
const WORD_END = '(?![\\p{L}\\p{N}])'
const esc = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

// Bindestriche gelten wie Leerzeichen (laengentreu, damit Fundstellen-Indizes passen).
const unhyphen = (s: string): string => s.replace(/[-\u2010-\u2015]/g, ' ')

// Ein Schluesselwort als Muster: Leerraum beliebig lang, '*' = bis zu zwei Woerter dazwischen.
function keywordSource(kw: string): string {
  let out = ''
  for (const tok of unhyphen(fold(kw)).split(/\s+/)) {
    if (tok === '*') out += '(?:\\s+[\\p{L}\\p{N}]+){0,2}'
    else out += (out === '' ? '' : '\\s+') + esc(tok)
  }
  return out
}

const wordsRe = (words: readonly string[]): RegExp =>
  new RegExp(`${WORD_START}(?:${[...new Set(words)].sort((a, b) => b.length - a.length).map(keywordSource).join('|')})${WORD_END}`, 'gu')

const KEYWORD_RE = wordsRe(SECURITY_KEYWORDS)
const CODE_WORD_RE = wordsRe(SUBJECT_CODE_WORDS)
// Ziffernfolge 4-8 Stellen, auch gruppiert (482 913, 48-29-13): Gruppen zu 2-4 Ziffern, Summe 4-8.
const DIGITS_RE = /(?<![\p{L}\p{N}])\d+(?:[ -]\d+)*(?![\p{L}\p{N}])/gu
const NEAR = 80

function isCode(run: string): boolean {
  const groups = run.split(/[ -]/)
  const total = groups.reduce((n, g) => n + g.length, 0)
  if (total < 4 || total > 8) return false
  return groups.length === 1 || groups.every((g) => g.length >= 2 && g.length <= 4)
}

function spans(re: RegExp, s: string): Array<[number, number]> {
  return [...s.matchAll(re)].map((m) => [m.index, m.index + m[0].length])
}

function codeSpans(s: string): Array<[number, number]> {
  return [...s.matchAll(DIGITS_RE)].filter((m) => isCode(m[0])).map((m) => [m.index, m.index + m[0].length])
}

/** Erkennt Sicherheitsmails (Spec 8.3) an Betreff und optional Text. */
export function classify(i: { subject: string; fromAddress: string | null; text?: string }): { security: boolean; reason: string | null } {
  const subject = fold(i.subject)
  const subjectWords = unhyphen(subject)
  if (spans(KEYWORD_RE, subjectWords).length > 0) return { security: true, reason: 'subject_keyword' }
  if (codeSpans(subject).length > 0 && spans(CODE_WORD_RE, subjectWords).length > 0) {
    return { security: true, reason: 'subject_code' }
  }
  if (i.text !== undefined) {
    const text = fold(i.text)
    const keys = spans(KEYWORD_RE, unhyphen(text))
    if (keys.length > 0) {
      const digits = codeSpans(text)
      const near = digits.some(([ds, de]) => keys.some(([ks, ke]) => (ds >= ke ? ds - ke : ks >= de ? ks - de : 0) <= NEAR))
      return { security: true, reason: near ? 'text_code_near_keyword' : 'text_keyword' }
    }
  }
  return { security: false, reason: null }
}

/** Ersetzt alleinstehende Ziffernfolgen von 4-8 Stellen durch vier Punkte. */
export function redactSubject(subject: string): string {
  return subject.replace(DIGITS_RE, (run) => (isCode(run) ? '••••' : run))
}
