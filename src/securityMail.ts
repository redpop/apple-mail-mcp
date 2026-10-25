import { fold } from './fold.js'
import { SECURITY_KEYWORDS, SUBJECT_CODE_WORDS } from './securityMail.data.js'

const WORD_START = '(?<![\\p{L}\\p{N}])'
const WORD_END = '(?![\\p{L}\\p{N}])'
const esc = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

const wordsRe = (words: readonly string[]): RegExp =>
  new RegExp(`${WORD_START}(?:${[...new Set(words.map(fold))].sort((a, b) => b.length - a.length).map(esc).join('|')})${WORD_END}`, 'gu')

const KEYWORD_RE = wordsRe(SECURITY_KEYWORDS)
const CODE_WORD_RE = wordsRe(SUBJECT_CODE_WORDS)
const DIGITS_SRC = `${WORD_START}\\d{4,8}${WORD_END}`
const NEAR = 80

function spans(re: RegExp, s: string): Array<[number, number]> {
  return [...s.matchAll(re)].map((m) => [m.index, m.index + m[0].length])
}

/** Erkennt Sicherheitsmails (Spec 8.3) an Betreff und optional Text. */
export function classify(i: { subject: string; fromAddress: string | null; text?: string }): { security: boolean; reason: string | null } {
  const subject = fold(i.subject)
  if (spans(KEYWORD_RE, subject).length > 0) return { security: true, reason: 'subject_keyword' }
  if (spans(new RegExp(DIGITS_SRC, 'gu'), subject).length > 0 && spans(CODE_WORD_RE, subject).length > 0) {
    return { security: true, reason: 'subject_code' }
  }
  if (i.text !== undefined) {
    const text = fold(i.text)
    const keys = spans(KEYWORD_RE, text)
    if (keys.length > 0) {
      const digits = spans(new RegExp(DIGITS_SRC, 'gu'), text)
      const near = digits.some(([ds, de]) => keys.some(([ks, ke]) => (ds >= ke ? ds - ke : ks >= de ? ks - de : 0) <= NEAR))
      return { security: true, reason: near ? 'text_code_near_keyword' : 'text_keyword' }
    }
  }
  return { security: false, reason: null }
}

/** Ersetzt alleinstehende Ziffernfolgen von 4-8 Stellen durch vier Punkte. */
export function redactSubject(subject: string): string {
  return subject.replace(new RegExp(DIGITS_SRC, 'gu'), '••••')
}
