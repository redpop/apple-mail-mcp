import { describe, expect, it } from 'vitest'
import type { Config } from '../src/config.js'
import { HelperError } from '../src/errors.js'
import { createHelperRunner } from '../src/helper.js'

const cfg = (helperPath: string | null) => ({ helperPath }) as Config
const fakeInner = () => {
  const calls: string[] = []
  return { calls, run: async (c: string) => { calls.push(c); return 'ok' }, stop: () => {} }
}

describe('createHelperRunner', () => {
  it('runs the gate once and passes the override flag', async () => {
    const inner = fakeInner()
    const checks: [string, boolean][] = []
    const r = createHelperRunner(cfg('/dev/X.app'), { check: (b, o) => { checks.push([b, o.override]) }, makeRunner: () => inner })
    expect(r.bundlePath).toBe('/dev/X.app')
    await r.run('a', {})
    await r.run('b', {})
    expect(checks).toEqual([['/dev/X.app', true]])
    expect(inner.calls).toEqual(['a', 'b'])
  })

  it('override false without helperPath, packaged bundle', async () => {
    const checks: [string, boolean][] = []
    const r = createHelperRunner(cfg(null), { check: (b, o) => { checks.push([b, o.override]) }, makeRunner: () => fakeInner() })
    await r.run('a', {})
    expect(checks[0]![1]).toBe(false)
    expect(checks[0]![0]).toMatch(/bin\/Mail MCP Helper\.app$/)
  })

  it('returns a gate failure on every call and never starts the helper', async () => {
    const inner = fakeInner()
    let n = 0
    const r = createHelperRunner(cfg(null), { check: () => { n++; throw new HelperError('HELPER_SIGNATURE_INVALID', 'bad') }, makeRunner: () => inner })
    await expect(r.run('a', {})).rejects.toMatchObject({ code: 'HELPER_SIGNATURE_INVALID' })
    await expect(r.run('a', {})).rejects.toMatchObject({ code: 'HELPER_SIGNATURE_INVALID' })
    expect(n).toBe(1)
    expect(inner.calls).toEqual([])
  })
})
