import { chmodSync, closeSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
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

// lstat, nicht stat: ein Symlink ohne Ziel liegt im Weg, auch wenn stat ihn als fehlend meldet.
function staleness(path: string): 'gone' | 'fresh' | 'stale' {
  try {
    // Echte Uhr: der mtime der Datei kommt vom Dateisystem, nicht aus der injizierten Zeit.
    return Date.now() - lstatSync(path).mtimeMs > SIDECAR_STALE_MS ? 'stale' : 'fresh'
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return 'gone'
    throw new ActionsError('LOCK_UNAVAILABLE')
  }
}

function removeFile(path: string): void {
  try {
    unlinkSync(path)
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw new ActionsError('LOCK_UNAVAILABLE')
  }
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
        // Auch das Entfernen zaehlt gegen die Grenze, sonst kann die Schleife nie enden.
        if (this.removeIfStale(side)) {
          if (i > this.retry.tries) throw new ActionsError('LOCK_UNAVAILABLE')
          continue
        }
        if (i >= this.retry.tries) throw new ActionsError('LOCK_UNAVAILABLE')
        sleep(this.retry.waitMs)
      }
    }
    try {
      return fn()
    } finally {
      this.release(side, fd)
    }
  }

  // Nur die eigene Sidecar-Datei entfernen: wurde sie gebrochen, kann dort schon die eines anderen liegen.
  // Der offene Deskriptor haelt die Inode belegt, sie kann nicht neu vergeben sein.
  private release(side: string, fd: number): void {
    try {
      if (lstatSync(side).ino === fstatSync(fd).ino) unlinkSync(side)
    } catch {
      // Fehlt die Sidecar-Datei schon, ist nichts zu tun.
    }
    try {
      closeSync(fd)
    } catch {
      // Schliessen darf das Ergebnis nicht kippen.
    }
  }

  /**
   * Entfernt eine verwaiste Sidecar-Datei; true heisst, der naechste Versuch lohnt sofort. Pruefen und
   * Entfernen laufen unter einer zweiten O_EXCL-Datei und mit neuer Altersprobe, sonst koennte ein
   * Prozess die frische Datei eines anderen loeschen, und beide hielten die Sperre.
   */
  private removeIfStale(side: string): boolean {
    const state = staleness(side)
    if (state !== 'stale') return state === 'gone'
    const guard = `${side}.break`
    let fd: number
    try {
      fd = openSync(guard, 'wx', 0o600)
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw new ActionsError('LOCK_UNAVAILABLE')
      // Eine alte Bruchdatei stammt von einem Absturz im Bruchfenster.
      const guardState = staleness(guard)
      if (guardState === 'fresh') return false
      if (guardState === 'stale') removeFile(guard)
      return true
    }
    try {
      const now = staleness(side)
      if (now === 'fresh') return false
      if (now === 'stale') removeFile(side)
      return true
    } finally {
      try {
        closeSync(fd)
      } catch {
        // Schliessen darf das Ergebnis nicht kippen.
      }
      try {
        unlinkSync(guard)
      } catch {
        // Fehlt die Bruchdatei schon, ist nichts zu tun.
      }
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
