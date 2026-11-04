import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { ActionsError } from '../src/errors.js'
import { LOCK_MS, MoveLocks } from '../src/locks.js'

let dir: string
let file: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'move-locks-'))
  file = join(dir, 'move-locks.json')
})
afterEach(() => {
  chmodSync(dir, 0o700)
  rmSync(dir, { recursive: true, force: true })
})

test('lockHoldsFor5Minutes', () => {
  let t = 1_000_000
  const l = new MoveLocks(file, () => t)
  l.lock(42)
  t += LOCK_MS - 1
  expect(l.isLocked(42)).toBe(true)
  expect(l.isLocked(43)).toBe(false)
  expect(LOCK_MS).toBe(300_000)
  expect(statSync(file).mode & 0o777).toBe(0o600)
})

test('expiresAfter5Minutes', () => {
  let t = 1_000_000
  const l = new MoveLocks(file, () => t)
  l.lock(42)
  t += LOCK_MS
  expect(l.isLocked(42)).toBe(false)
  // Abgelaufener Eintrag faellt beim naechsten Schreiben heraus.
  l.lock(7)
  expect(Object.keys(JSON.parse(readFileSync(file, 'utf8')))).toEqual(['7'])
})

test('secondInstanceSeesTheLock', () => {
  const t = 5
  new MoveLocks(file, () => t).lock(9)
  expect(new MoveLocks(file, () => t).isLocked(9)).toBe(true)
})

test('missingFileMeansNoLocks', () => {
  expect(new MoveLocks(join(dir, 'nope', 'x.json')).isLocked(1)).toBe(false)
})

test('corruptFileThrowsLockUnavailable', () => {
  writeFileSync(file, '{not json')
  const l = new MoveLocks(file)
  expect(() => l.isLocked(1)).toThrowError(ActionsError)
  try {
    l.lock(1)
  } catch (e) {
    expect((e as ActionsError).code).toBe('LOCK_UNAVAILABLE')
  }
})

test('unwritableFileThrowsLockUnavailable', () => {
  mkdirSync(join(dir, 'ro'))
  chmodSync(join(dir, 'ro'), 0o500)
  const l = new MoveLocks(join(dir, 'ro', 'sub', 'x.json'))
  expect(() => l.lock(1)).toThrowError(expect.objectContaining({ code: 'LOCK_UNAVAILABLE' }))
  chmodSync(join(dir, 'ro'), 0o700)
})
