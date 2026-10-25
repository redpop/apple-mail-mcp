import { execFile } from 'node:child_process'

export const FDA_SETTINGS_URL = 'x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles'

export type OpenFn = (file: string, args: string[]) => void

// execFile mit Argumentliste, nie eine Shell; Fehler von open sind egal.
export const defaultOpen: OpenFn = (file, args) => {
  execFile(file, args, () => {})
}

let done = false

export function resetFdaPromptForTests(): void {
  done = false
}

/**
 * Oeffnet einmal pro Prozess die FDA-Seite und zeigt das Bundle im Finder (Spec 12.1). Wirft nie.
 * Liefert true, wenn dieser Aufruf geoeffnet hat, damit die Meldung nur dann davon spricht.
 */
export function openFdaOnce(bundlePath: string, open: OpenFn = defaultOpen): boolean {
  if (done) return false
  done = true
  for (const args of [[FDA_SETTINGS_URL], ['-R', bundlePath]]) {
    try {
      open('/usr/bin/open', args)
    } catch {
      // Hilfsfunktion: die Fehlermeldung an das Modell enthaelt die Schritte ohnehin.
    }
  }
  return true
}
