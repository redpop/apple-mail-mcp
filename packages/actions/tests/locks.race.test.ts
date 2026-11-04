import { mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { MoveLocks, SIDECAR_STALE_MS } from '../src/locks.js'

// Der Wettlauf braucht einen Eingriff genau zwischen erster Altersprobe und Entfernen.
const hook = vi.hoisted(() => ({ afterFirstProbe: undefined as (() => void) | undefined }))

vi.mock('node:fs', async (original) => {
  const fs = await original<typeof import('node:fs')>()
  const probe = <T>(real: (path: string) => T) => (path: string): T => {
    const result = real(path)
    if (path.endsWith('.lock') && hook.afterFirstProbe) {
      const run = hook.afterFirstProbe
      hook.afterFirstProbe = undefined
      run()
    }
    return result
  }
  return { ...fs, statSync: probe(fs.statSync), lstatSync: probe(fs.lstatSync) }
})

let dir: string
let file: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'move-locks-race-'))
  file = join(dir, 'move-locks.json')
})
afterEach(() => {
  hook.afterFirstProbe = undefined
  rmSync(dir, { recursive: true, force: true })
})

test('sidecarReplacedAfterFirstProbeIsKept', () => {
  // Prozess A sieht die alte Datei; B bricht sie und legt seine frische an, bevor A entfernt.
  const side = `${file}.lock`
  writeFileSync(side, '')
  const old = new Date(Date.now() - SIDECAR_STALE_MS - 5_000)
  utimesSync(side, old, old)
  hook.afterFirstProbe = () => {
    rmSync(side)
    writeFileSync(side, 'other holder')
  }
  const l = new MoveLocks(file, Date.now, { tries: 2, waitMs: 1 })
  expect(() => l.tryLock(1)).toThrowError(expect.objectContaining({ code: 'LOCK_UNAVAILABLE' }))
  expect(readFileSync(side, 'utf8')).toBe('other holder')
})
