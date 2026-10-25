/**
 * Faltet Text fuer Vergleiche: Kleinschreibung, NFC, ß zu ss.
 * Muss sich exakt wie die Swift-Funktion `fold` verhalten.
 */
export function fold(s: string): string {
  return s.toLowerCase().normalize('NFC').replaceAll('ß', 'ss')
}
