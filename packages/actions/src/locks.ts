import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { defaultStateDir } from '@redpop/apple-mail-mcp/dist/state.js'
import { ActionsError } from './errors.js'

export const LOCK_MS = 300_000

/** Standardpfad der Sperrdatei; gehoert in das Zustandsverzeichnis des Lesepakets. */
export function defaultLockFile(): string {
  return join(defaultStateDir(), 'move-locks.json')
}

/**
 * Sperre je Nachricht (gid) gegen doppeltes Verschieben, auch zwischen Prozessen: die Datei wird bei
 * jedem isLocked und lock neu gelesen. Eine unlesbare oder nicht schreibbare Datei ist ein Fehler,
 * nie "keine Sperre" (sonst liesse sich der Schutz durch eine kaputte Datei umgehen).
 */
export class MoveLocks {
  constructor(
    private readonly file: string,
    private readonly now: () => number = Date.now,
  ) {}

  isLocked(gid: number): boolean {
    const until = this.read().get(String(gid))
    return until !== undefined && until > this.now()
  }

  lock(gid: number): void {
    const t = this.now()
    const entries = this.read()
    entries.set(String(gid), t + LOCK_MS)
    const live: Record<string, number> = {}
    for (const [k, until] of entries) if (until > t) live[k] = until
    try {
      mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 })
      const tmp = `${this.file}.${process.pid}.tmp`
      writeFileSync(tmp, JSON.stringify(live), { mode: 0o600 })
      chmodSync(tmp, 0o600)
      renameSync(tmp, this.file)
    } catch {
      throw new ActionsError('LOCK_UNAVAILABLE')
    }
  }

  // Ablaufzeitpunkte je gid. Fehlende Datei heisst: keine Sperren.
  private read(): Map<string, number> {
    let text: string
    try {
      text = readFileSync(this.file, 'utf8')
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return new Map()
      throw new ActionsError('LOCK_UNAVAILABLE')
    }
    try {
      const o: unknown = JSON.parse(text)
      if (typeof o !== 'object' || o === null || Array.isArray(o)) throw new Error('shape')
      const out = new Map<string, number>()
      for (const [k, v] of Object.entries(o)) {
        if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error('shape')
        out.set(k, v)
      }
      return out
    } catch {
      throw new ActionsError('LOCK_UNAVAILABLE')
    }
  }
}
