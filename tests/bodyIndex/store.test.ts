import { existsSync, mkdtempSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { foldFast } from '../../src/bodyScan.js'
import { indexDir, loadSqlite, openStore, removeIndexFiles, SCHEMA_VERSION } from '../../src/bodyIndex/store.js'

const sqlite = (await loadSqlite())!
const tmp = () => indexDir(mkdtempSync(join(tmpdir(), 'mailmcp-idx-')))
const mode = (p: string) => statSync(p).mode & 0o777

describe('store', () => {
  test('directory 0700, files including -wal and -shm 0600, Time Machine exclusion once', () => {
    const dir = tmp()
    const excluded: string[] = []
    const s = openStore(sqlite, dir, { exclude: (d) => excluded.push(d) })
    s.tx(() => s.addDoc(1, 'Hallo Welt'))
    expect(mode(dir)).toBe(0o700)
    for (const f of ['index.sqlite', 'index.sqlite-wal', 'index.sqlite-shm']) expect(mode(join(dir, f)), f).toBe(0o600)
    s.close()
    openStore(sqlite, dir, { exclude: (d) => excluded.push(d) }).close()
    expect(excluded).toEqual([dir])
  })

  test('substring match over folded text, case and sharp s folded like the live scan', () => {
    const s = openStore(sqlite, tmp(), { exclude: () => {} })
    s.tx(() => {
      s.addDoc(10, 'Ihre Stromrechnung für März')
      s.addDoc(11, 'Grüße aus der Straße')
      s.addDoc(12, 'nichts')
    })
    expect(s.matchGids(foldFast('rechnung'))).toEqual([10])
    expect(s.matchGids(foldFast('STRASSE'))).toEqual([11])
    expect(s.matchGids(foldFast('grüsse'))).toEqual([11])
    expect(s.matchGids('a"b')).toEqual([])
    s.close()
  })

  test('remove deletes docs, fts and skipped rows', () => {
    const s = openStore(sqlite, tmp(), { exclude: () => {} })
    s.tx(() => {
      s.addDoc(1, 'alpha beta')
      s.addSkipped(2, 'security')
    })
    expect(s.known(1) && s.known(2)).toBe(true)
    s.tx(() => {
      s.remove(1)
      s.remove(2)
    })
    expect(s.known(1) || s.known(2)).toBe(false)
    expect(s.matchGids('alpha')).toEqual([])
    expect(s.counts()).toEqual({ docs: 0, skipped: 0 })
    s.close()
  })

  test('schema version mismatch recreates the file', () => {
    const dir = tmp()
    const s = openStore(sqlite, dir, { exclude: () => {} })
    s.tx(() => s.addDoc(1, 'alpha'))
    s.setMeta('schemaVersion', String(SCHEMA_VERSION + 1))
    s.close()
    const t = openStore(sqlite, dir, { exclude: () => {} })
    expect(t.counts().docs).toBe(0)
    expect(t.meta('schemaVersion')).toBe(String(SCHEMA_VERSION))
    t.close()
  })

  test('a file that is not a database is replaced', () => {
    const dir = tmp()
    openStore(sqlite, dir, { exclude: () => {} }).close()
    removeIndexFiles(dir)
    writeFileSync(join(dir, 'index.sqlite'), 'x'.repeat(4096))
    const s = openStore(sqlite, dir, { exclude: () => {} })
    expect(s.counts().docs).toBe(0)
    s.close()
  })

  test('removeIndexFiles keeps the directory and other files', () => {
    const dir = tmp()
    openStore(sqlite, dir, { exclude: () => {} }).close()
    writeFileSync(join(dir, 'writer.lock'), '{}')
    removeIndexFiles(dir)
    expect(existsSync(join(dir, 'index.sqlite'))).toBe(false)
    expect(existsSync(join(dir, 'writer.lock'))).toBe(true)
  })
})
