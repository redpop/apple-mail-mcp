/** Zitateinleitungen in einer Zeile (Spec 8.2). */
const INTRO_PATTERNS: RegExp[] = [
  /^\s*On\b.+\bwrote:\s*$/i,
  /^\s*Am\b.+\bschrieb\b.*:\s*$/i,
  /^\s*Le\b.+\ba écrit\s?:\s*$/i,
  /^\s*El\b.+\bescribió:\s*$/i,
  /^\s*-{2,}\s*Original Message\s*-{2,}\s*$/i,
  /^\s*-{2,}\s*Ursprüngliche Nachricht\s*-{2,}\s*$/i,
]

const FROM_LINE = /^\s*(From|Von):/i
const SENT_LINE = /^\s*(Sent|Gesendet):/i

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
    const next = lines[i + 1]
    const isIntro = INTRO_PATTERNS.some((p) => p.test(line))
    // Kopfblock: From:/Von: direkt gefolgt von Sent:/Gesendet:
    const isHeaderBlock = FROM_LINE.test(line) && next !== undefined && SENT_LINE.test(next)
    if (isIntro || isHeaderBlock) {
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
