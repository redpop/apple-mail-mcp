/** Zitateinleitungen in einer Zeile (Spec 8.2). */
const INTRO_PATTERNS: RegExp[] = [
  /^\s*On\b.+\bwrote:\s*$/i,
  /^\s*Am\b.+\bschrieb\b.*:\s*$/i,
  /^\s*Le\b.+\ba écrit\s?:\s*$/i,
  /^\s*El\b.+\bescribió:\s*$/i,
  /^\s*-{2,}\s*Original Message\s*-{2,}\s*$/i,
  /^\s*-{2,}\s*Ursprüngliche Nachricht\s*-{2,}\s*$/i,
  /^\s*-{2,}\s*(Forwarded message|Weitergeleitete Nachricht)\s*-{2,}\s*$/i,
  // Weiterleitung aus Apple Mail.
  /^\s*Begin forwarded message:\s*$/i,
  /^\s*Anfang der weitergeleiteten Nachricht:\s*$/i,
]

/**
 * Hinweise, dass eine auf zwei Zeilen umbrochene Einleitung wirklich eine ist: eine Adresse
 * oder Datum mit Uhrzeit. Ohne sie bliebe "On Monday we met.\nShe wrote:" nicht stehen.
 */
const INTRO_EVIDENCE = [/@/, /\b(?:19|20)\d\d\b.*\b\d{1,2}[:.]\d\d\b|\b\d{1,2}[:.]\d\d\b.*\b(?:19|20)\d\d\b/]

const FROM_LINE = /^\s*(From|Von):/i
const SENT_LINE = /^\s*(Sent|Gesendet):/i
// Kopfzeilen eines Weiterleitungs- oder Antwortblocks (Outlook, Apple Mail).
const HEADER_LINE = /^\s*(Sent|Gesendet|Date|Datum|To|An|Cc|Kopie|Subject|Betreff):/i

function isIntro(line: string): boolean {
  return INTRO_PATTERNS.some((p) => p.test(line))
}

/** Einleitung, die der Client vor "wrote:" oder in der Adresse umbrochen hat. */
function isWrappedIntro(line: string, next: string | undefined): boolean {
  if (next === undefined || next.trim() === '' || isIntro(line)) return false
  const joined = `${line.trimEnd()} ${next.trim()}`
  return isIntro(joined) && INTRO_EVIDENCE.some((p) => p.test(joined))
}

/**
 * Kopfblock: From:/Von: direkt gefolgt von Sent:/Gesendet: (Outlook) oder von zwei weiteren
 * Kopfzeilen wie Subject:, Date:, To: (Apple Mail, auch deutsch).
 */
function isHeaderBlock(lines: string[], i: number): boolean {
  if (!FROM_LINE.test(lines[i] as string)) return false
  const next = lines[i + 1]
  if (next === undefined) return false
  if (SENT_LINE.test(next)) return true
  const after = lines[i + 2]
  return HEADER_LINE.test(next) && after !== undefined && HEADER_LINE.test(after)
}

/**
 * Entfernt zitierte Zeilen (`>`) und schneidet ab der ersten Zitateinleitung ab.
 * Pure Funktion, siehe Spec 8.2.
 */
export function stripQuotes(text: string): { text: string; removed: boolean } {
  const lines = text.split('\n')
  const kept: string[] = []
  let removed = false

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string
    if (isIntro(line) || isWrappedIntro(line, lines[i + 1]) || isHeaderBlock(lines, i)) {
      removed = true
      break
    }
    if (line.startsWith('>')) {
      removed = true
      continue
    }
    kept.push(line)
  }

  if (!removed) return { text, removed: false }
  return { text: kept.join('\n').replace(/\s+$/, ''), removed: true }
}
