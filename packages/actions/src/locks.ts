import { chmodSync, closeSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { defaultStateDir } from '@redpop/apple-mail-mcp/dist/state.js'
import { ActionsError } from './errors.js'

export const LOCK_MS = 300_000
// Sidecar-Datei gegen gleichzeitiges Lesen-Aendern-Schreiben: aelter als 30 s gilt sie als verwaist.
export const SIDECAR_STALE_MS = 30_000

export interface LockRetry {
  tries: number
  waitMs: number
}
const DEFAULT_RETRY: LockRetry = { tries: 50, waitMs: 20 }

function sleep(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

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
    private readonly retry: LockRetry = DEFAULT_RETRY,
  ) {}

  isLocked(gid: number): boolean {
    const until = this.read().get(String(gid))
    return until !== undefined && until > this.now()
  }

  lock(gid: number): void {
    this.exclusive(() => this.set(gid))
  }

  /** Pruefen und sperren in einem Schritt unter der Sidecar-Sperre: false heisst, die gid war schon gesperrt. */
  tryLock(gid: number): boolean {
    return this.exclusive(() => {
      if (this.isLocked(gid)) return false
      this.set(gid)
      return true
    })
  }

  // Lesen-Aendern-Schreiben unter einer O_EXCL-Sidecar-Datei, kurz und begrenzt wiederholt.
  private exclusive<T>(fn: () => T): T {
    const side = `${this.file}.lock`
    try {
      mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 })
    } catch {
      throw new ActionsError('LOCK_UNAVAILABLE')
    }
    let fd: number | undefined
    for (let i = 0; fd === undefined; i++) {
      try {
        fd = openSync(side, 'wx', 0o600)
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw new ActionsError('LOCK_UNAVAILABLE')
        if (this.removeIfStale(side)) continue
        if (i >= this.retry.tries) throw new ActionsError('LOCK_UNAVAILABLE')
        sleep(this.retry.waitMs)
      }
    }
    try {
      return fn()
    } finally {
      try {
        closeSync(fd)
      } catch {
        // Schliessen darf das Ergebnis nicht kippen.
      }
      try {
        unlinkSync(side)
      } catch {
        // Fehlt die Sidecar-Datei schon, ist nichts zu tun.
      }
    }
  }

  private removeIfStale(side: string): boolean {
    try {
      // Echte Uhr: der mtime der Datei kommt vom Dateisystem, nicht aus der injizierten Zeit.
      if (Date.now() - statSync(side).mtimeMs <= SIDECAR_STALE_MS) return false
      unlinkSync(side)
      return true
    } catch {
      // Verschwunden zwischen open und stat: gleich nochmal versuchen.
      return true
    }
  }

  private set(gid: number): void {
    const t = this.now()
    const entries = this.read()
    entries.set(String(gid), t + LOCK_MS)
    const live: Record<string, number> = {}
    for (const [k, until] of entries) if (until > t) live[k] = until
    const tmp = `${this.file}.${process.pid}.tmp`
    try {
      writeFileSync(tmp, JSON.stringify(live), { mode: 0o600 })
      chmodSync(tmp, 0o600)
      renameSync(tmp, this.file)
    } catch {
      rmSync(tmp, { force: true })
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
