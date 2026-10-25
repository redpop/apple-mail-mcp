import { HelperError } from './errors.js'

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/
const DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(Z|[+-]\d{2}:\d{2})?$/

function invalid(s: string, why: string): HelperError {
  return new HelperError('INVALID_INPUT', `Invalid date "${s}": ${why}. Use YYYY-MM-DD or an ISO 8601 date-time with offset such as 2026-10-01T10:00:00+02:00.`)
}

// Prueft, dass Jahr/Monat/Tag einen echten Kalendertag ergeben (kein Ueberlauf wie 30. Februar).
function validDay(y: number, m: number, d: number): boolean {
  const t = new Date(Date.UTC(y, m - 1, d))
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d
}

/** Eingabe fuer since/before. Datum = lokale Mitternacht, Zeitpunkt nur mit Offset. Liefert Unix-Sekunden. */
export function parseDateInput(s: string): number {
  const d = DATE_ONLY.exec(s)
  if (d) {
    const [y, m, day] = [Number(d[1]), Number(d[2]), Number(d[3])]
    if (!validDay(y, m, day)) throw invalid(s, 'no such calendar day')
    return Math.floor(new Date(y, m - 1, day).getTime() / 1000)
  }
  const t = DATE_TIME.exec(s)
  if (!t) throw invalid(s, 'unrecognised format')
  if (t[7] === undefined) throw invalid(s, 'a time needs an explicit offset (Z or +HH:MM), no timezone is assumed')
  const hh = Number(t[4]), mm = Number(t[5]), ss = Number(t[6] ?? 0)
  if (!validDay(Number(t[1]), Number(t[2]), Number(t[3])) || hh > 23 || mm > 59 || ss > 59) throw invalid(s, 'no such time')
  const ms = Date.parse(s)
  if (Number.isNaN(ms)) throw invalid(s, 'unrecognised format')
  return Math.floor(ms / 1000)
}

const p2 = (n: number): string => String(n).padStart(2, '0')

/** ISO 8601 mit lokalem Offset (Prozess-TZ), ohne Millisekunden. */
export function formatLocal(unix: number): string {
  const d = new Date(Math.floor(unix) * 1000)
  const off = -d.getTimezoneOffset()
  const sign = off < 0 ? '-' : '+'
  const a = Math.abs(off)
  return (
    `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}T${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}` +
    `${sign}${p2(Math.floor(a / 60))}:${p2(a % 60)}`
  )
}
