import { randomUUID } from 'node:crypto'
import { chmodSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const LEASE_FILE = 'writer.lock'
export const LEASE_TTL_MS = 60_000
export const LEASE_RENEW_MS = 10_000

interface LeaseBody {
  pid: number
  heartbeat: number
  token: string
}

export interface LeaseOptions {
  now?: () => number
  pid?: number
  alive?: (pid: number) => boolean
}

export interface Lease {
  /** Legt den Lease an oder uebernimmt einen verfallenen; true, wenn diese Instanz ihn danach haelt. */
  acquire(): boolean
  /** Prueft an der Datei, ob diese Instanz ihn noch haelt (vor jeder Schreibtransaktion). */
  held(): boolean
  /** Erneuert den Heartbeat; false, wenn der Lease inzwischen einer anderen Instanz gehoert. */
  renew(): boolean
  release(): void
}

export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    // EPERM: Prozess lebt, gehoert aber einem anderen Nutzer.
    return (e as NodeJS.ErrnoException).code === 'EPERM'
  }
}

function read(file: string): LeaseBody | null {
  try {
    const o = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
    if (typeof o.pid !== 'number' || typeof o.heartbeat !== 'number' || typeof o.token !== 'string') return null
    return { pid: o.pid, heartbeat: o.heartbeat, token: o.token }
  } catch {
    return null
  }
}

function valid(body: LeaseBody | null, now: number, alive: (pid: number) => boolean): body is LeaseBody {
  return body !== null && now - body.heartbeat < LEASE_TTL_MS && alive(body.pid)
}

/** Haelt gerade eine Instanz einen gueltigen Lease (Heartbeat juenger als 60 s, Prozess lebt)? Spec 5.8, 5.9. */
export function foreignLeaseValid(dir: string, opts: Omit<LeaseOptions, 'pid'> = {}): boolean {
  return valid(read(join(dir, LEASE_FILE)), (opts.now ?? Date.now)(), opts.alive ?? processAlive)
}

/** Lease als Datei, damit auch eine Instanz ohne node:sqlite ihn pruefen kann (Spec 5.9). */
export function createLease(dir: string, opts: LeaseOptions = {}): Lease {
  const now = opts.now ?? Date.now
  const pid = opts.pid ?? process.pid
  const alive = opts.alive ?? processAlive
  const token = randomUUID()
  const file = join(dir, LEASE_FILE)
  const body = (): string => JSON.stringify({ pid, heartbeat: now(), token } satisfies LeaseBody)

  // Atomar ersetzen: ein Leser sieht nie eine halbe Datei.
  const replace = (): void => {
    const tmp = `${file}.${pid}.${token}.tmp`
    writeFileSync(tmp, body(), { mode: 0o600 })
    chmodSync(tmp, 0o600)
    renameSync(tmp, file)
  }
  const held = (): boolean => read(file)?.token === token

  return {
    acquire() {
      try {
        writeFileSync(file, body(), { flag: 'wx', mode: 0o600 })
        return true
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e
      }
      const cur = read(file)
      if (cur?.token === token) return true
      if (valid(cur, now(), alive)) return false
      replace()
      return held()
    },
    held,
    renew() {
      if (!held()) return false
      replace()
      return true
    },
    release() {
      if (held()) rmSync(file, { force: true })
    },
  }
}
