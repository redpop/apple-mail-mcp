import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { formatLocal } from './dates.js'

export interface AccessInfo {
  helperSha256: string | null
  helperVersion: string | null
}

export interface State extends AccessInfo {
  lastAccessOk: string
}

export function defaultStateDir(): string {
  return join(homedir(), 'Library', 'Application Support', 'apple-mail-mcp')
}

const MIN_INTERVAL_MS = 60_000
// Letzter Schreibzeitpunkt je Verzeichnis, damit pro Minute hoechstens einmal geschrieben wird.
const lastWrite = new Map<string, number>()

export function readState(dir: string = defaultStateDir()): State | null {
  try {
    const o = JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8')) as Record<string, unknown>
    if (typeof o.lastAccessOk !== 'string') return null
    return {
      lastAccessOk: o.lastAccessOk,
      helperSha256: typeof o.helperSha256 === 'string' ? o.helperSha256 : null,
      helperVersion: typeof o.helperVersion === 'string' ? o.helperVersion : null,
    }
  } catch {
    return null
  }
}

/** Haelt fest, dass der Zugriff geklappt hat (Spec 12.3). Wirft nie; enthaelt keine Mail-Daten. */
export function recordAccessOk(info: AccessInfo, dir: string = defaultStateDir(), now: () => number = Date.now): void {
  const t = now()
  const prev = lastWrite.get(dir)
  if (prev !== undefined && t - prev < MIN_INTERVAL_MS) return
  lastWrite.set(dir, t)
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    const file = join(dir, 'state.json')
    const tmp = `${file}.${process.pid}.tmp`
    const body: State = { lastAccessOk: formatLocal(Math.floor(t / 1000)), helperSha256: info.helperSha256, helperVersion: info.helperVersion }
    writeFileSync(tmp, JSON.stringify(body), { mode: 0o600 })
    chmodSync(tmp, 0o600)
    renameSync(tmp, file)
  } catch {
    // Zustandsdatei ist nur eine Hilfe; ein Schreibfehler darf keinen Tool-Aufruf stoeren.
  }
}
