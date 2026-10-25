import { mkdtempSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { readState, recordAccessOk } from '../src/state.js'

const info = { helperSha256: null, helperVersion: '0.1.0' }

describe('state', () => {
  it('schreibt Datei mit Rechten 0600 und liest sie zurueck', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mailmcp-state-'))
    recordAccessOk(info, dir, () => 1_800_000_000_000)
    const mode = statSync(join(dir, 'state.json')).mode & 0o777
    expect(mode).toBe(0o600)
    const s = readState(dir)
    expect(s).toMatchObject({ helperSha256: null, helperVersion: '0.1.0' })
    expect(s?.lastAccessOk).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/)
  })

  it('schreibt hoechstens einmal pro Minute', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mailmcp-state-'))
    let t = 1_800_000_000_000
    recordAccessOk({ ...info, helperVersion: 'a' }, dir, () => t)
    t += 59_000
    recordAccessOk({ ...info, helperVersion: 'b' }, dir, () => t)
    expect(readState(dir)?.helperVersion).toBe('a')
    t += 2_000
    recordAccessOk({ ...info, helperVersion: 'c' }, dir, () => t)
    expect(readState(dir)?.helperVersion).toBe('c')
  })

  it('wirft nie, auch wenn das Verzeichnis nicht schreibbar ist', () => {
    expect(() => recordAccessOk(info, '/dev/null/nope', () => 1)).not.toThrow()
    expect(readState('/dev/null/nope')).toBeNull()
  })

  it('liest fehlende oder kaputte Datei als null', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mailmcp-state-'))
    expect(readState(dir)).toBeNull()
    recordAccessOk(info, dir, () => 5)
    expect(readFileSync(join(dir, 'state.json'), 'utf8')).toContain('lastAccessOk')
  })
})
