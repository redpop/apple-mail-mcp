import { existsSync, mkdtempSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { foldFast } from '../../src/bodyScan.js'
import { indexDir, loadSqlite, openReader, openStore, removeIndexFiles, SCHEMA_VERSION } from '../../src/bodyIndex/store.js'

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

  test('reader: texts by gid, skipped gids by reason, counts', () => {
    const s = openStore(sqlite, tmp(), { exclude: () => {} })
    s.tx(() => {
      s.addDoc(10, 'Ihre Stromrechnung')
      s.addDoc(11, 'Grüße')
      s.addSkipped(12, 'security')
      s.addSkipped(13, 'unavailable')
    })
    expect(s.texts([10, 11, 99])).toEqual(new Map([[10, 'Ihre Stromrechnung'], [11, 'Grüße']]))
    expect(s.skippedGids('security')).toEqual([12])
    s.close()
  })
})

describe('openReader', () => {
  test('reads without creating anything; null without an index file', () => {
    const dir = tmp()
    expect(openReader(sqlite, dir)).toBeNull()
    expect(existsSync(dir)).toBe(false)
  })

  test('sees what the writer commits, and leaves every file at 0600', () => {
    const dir = tmp()
    const s = openStore(sqlite, dir, { exclude: () => {} })
    s.tx(() => s.addDoc(10, 'Ihre Stromrechnung'))
    const r = openReader(sqlite, dir)!
    expect(r.matchGids(foldFast('rechnung'))).toEqual([10])
    s.tx(() => s.addDoc(11, 'noch eine Rechnung'))
    expect(r.matchGids(foldFast('rechnung')).sort()).toEqual([10, 11])
    expect(r.texts([11]).get(11)).toBe('noch eine Rechnung')
    expect(r.counts()).toEqual({ docs: 2, skipped: 0 })
    expect((r as unknown as { setMeta?: unknown }).setMeta).toBeUndefined()
    s.close()
    r.close()
    // Nach dem Schliessen des Schreibers legt ein Leser -wal und -shm neu an.
    const again = openReader(sqlite, dir)!
    expect(again.meta('schemaVersion')).toBe(String(SCHEMA_VERSION))
    for (const f of ['index.sqlite', 'index.sqlite-wal', 'index.sqlite-shm']) if (existsSync(join(dir, f))) expect(mode(join(dir, f)), f).toBe(0o600)
    again.close()
  })

  test('null for a file with another schema version or that is no database', () => {
    const dir = tmp()
    const s = openStore(sqlite, dir, { exclude: () => {} })
    s.tx(() => s.setMeta('schemaVersion', '999'))
    s.close()
    expect(openReader(sqlite, dir)).toBeNull()
    removeIndexFiles(dir)
    writeFileSync(join(dir, 'index.sqlite'), 'not a database')
    expect(openReader(sqlite, dir)).toBeNull()
  })
})
