import { spawn } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { ActionsError } from '../src/errors.js'
import { LOCK_MS, MoveLocks, SIDECAR_STALE_MS } from '../src/locks.js'

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

test('tryLockSecondInstanceGetsFalse', () => {
  const t = 5
  expect(new MoveLocks(file, () => t).tryLock(9)).toBe(true)
  expect(new MoveLocks(file, () => t).tryLock(9)).toBe(false)
  expect(new MoveLocks(file, () => t).tryLock(10)).toBe(true)
  expect(existsSync(`${file}.lock`)).toBe(false)
})

test('concurrentLocksAcrossProcessesLoseNoEntry', () => {
  // Zwei Kindprozesse sperren je 40 verschiedene gids gleichzeitig; kein Eintrag darf verloren gehen.
  // Die Quellen werden mit Node (stripTypeScriptTypes, Modus transform) in das Temp-Verzeichnis uebersetzt; der Zustandspfad wird durch einen Stub ersetzt.
  const out = (name: string): string => join(dir, name)
  const compile = (src: string): string => stripTypeScriptTypes(readFileSync(new URL(`../src/${src}`, import.meta.url), 'utf8'), { mode: 'transform' } as unknown as { mode: 'strip' })
  writeFileSync(out('errors.mjs'), compile('errors.ts'))
  writeFileSync(
    out('locks.mjs'),
    compile('locks.ts')
      .replace(/import \{ defaultStateDir \} from [^\n]*\n/, 'const defaultStateDir = () => ""\n')
      .replace("'./errors.js'", "'./errors.mjs'"),
  )
  const lockFile = join(dir, 'conc', 'move-locks.json')
  const script = `
    const { MoveLocks } = await import(${JSON.stringify(out('locks.mjs'))})
    const base = Number(process.argv[1])
    const l = new MoveLocks(${JSON.stringify(lockFile)}, Date.now, { tries: 2000, waitMs: 5 })
    for (let i = 0; i < 40; i++) if (!l.tryLock(base + i)) process.exit(3)
  `
  return Promise.all(
    [1000, 2000].map(
      (base) =>
        new Promise<void>((resolve, reject) => {
          const c = spawn(process.execPath, ['--input-type=module', '-e', script, String(base)], { stdio: 'inherit' })
          c.on('exit', (code: number | null) => (code === 0 ? resolve() : reject(new Error(`child exit ${code}`))))
        }),
    ),
  ).then(() => {
    const keys = Object.keys(JSON.parse(readFileSync(lockFile, 'utf8')))
    expect(keys).toHaveLength(80)
    expect(readdirSync(join(dir, 'conc'))).toEqual(['move-locks.json'])
  })
}, 60_000)

test('heldSidecarLeadsToLockUnavailableAfterBoundedRetry', () => {
  writeFileSync(`${file}.lock`, '')
  const l = new MoveLocks(file, Date.now, { tries: 3, waitMs: 1 })
  expect(() => l.tryLock(1)).toThrowError(expect.objectContaining({ code: 'LOCK_UNAVAILABLE' }))
  expect(() => l.lock(1)).toThrowError(expect.objectContaining({ code: 'LOCK_UNAVAILABLE' }))
  // Die fremde Sidecar-Datei bleibt stehen.
  expect(existsSync(`${file}.lock`)).toBe(true)
  expect(existsSync(file)).toBe(false)
})

test('staleSidecarIsCleared', () => {
  writeFileSync(`${file}.lock`, '')
  const old = new Date(Date.now() - SIDECAR_STALE_MS - 5_000)
  utimesSync(`${file}.lock`, old, old)
  const l = new MoveLocks(file, Date.now, { tries: 0, waitMs: 1 })
  expect(l.tryLock(1)).toBe(true)
  expect(existsSync(`${file}.lock`)).toBe(false)
})

test('failedRenameRemovesTmpFile', () => {
  // Ziel ist ein Verzeichnis: rename schlaegt fehl, die .tmp-Datei darf nicht liegen bleiben.
  mkdirSync(file)
  const l = new MoveLocks(file)
  expect(() => l.lock(1)).toThrowError(expect.objectContaining({ code: 'LOCK_UNAVAILABLE' }))
  expect(readdirSync(dir).sort()).toEqual(['move-locks.json'])
})
