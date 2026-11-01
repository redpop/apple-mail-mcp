import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { createStdioRunner } from '../src/stdioRunner.js'

const FAKE = fileURLToPath(new URL('./fakes/fake-helper.mjs', import.meta.url))
const fast = { firstRequestMs: 3_000, requestMs: 1_000 }
const runners: { stop: () => void }[] = []
const dirs: string[] = []
const saved = { v: process.env.FAKE_PROTOCOL_VERSION, l: process.env.FAKE_LOG }
const flags = ['FAKE_HELLO_HANG']

afterEach(() => {
  for (const f of flags) delete process.env[f]
  while (runners.length) runners.pop()?.stop()
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true })
  if (saved.v === undefined) delete process.env.FAKE_PROTOCOL_VERSION; else process.env.FAKE_PROTOCOL_VERSION = saved.v
  if (saved.l === undefined) delete process.env.FAKE_LOG; else process.env.FAKE_LOG = saved.l
})

function make(path = FAKE) {
  const r = createStdioRunner(path, fast)
  runners.push(r)
  return r
}
function logFile(): string {
  const d = mkdtempSync(join(tmpdir(), 'mail-stdio-'))
  dirs.push(d)
  const f = join(d, 'log')
  process.env.FAKE_LOG = f
  return f
}

describe('createStdioRunner', () => {
  it('sends hello first after each start', async () => {
    const log = logFile()
    const r = make()
    await r.run('echo-pid', {})
    await r.run('echo-pid', {})
    expect(readFileSync(log, 'utf8').trim().split('\n')).toEqual(['hello', 'echo-pid', 'echo-pid'])
  })

  it('serves calls from one process and matches concurrent answers', async () => {
    const r = make()
    const a = (await r.run('echo-pid', {})) as { pid: number }
    const b = (await r.run('echo-pid', {})) as { pid: number }
    expect(b.pid).toBe(a.pid)
    const all = await Promise.all([1, 2, 3].map((n) => r.run('echo-payload', { n })))
    expect(all).toEqual([{ n: 1 }, { n: 2 }, { n: 3 }])
  })

  it('passes structured errors through', async () => {
    await expect(make().run('fail', {})).rejects.toMatchObject({ code: 'MESSAGE_NOT_FOUND' })
  })

  it('version mismatch rejects requests', async () => {
    process.env.FAKE_PROTOCOL_VERSION = '1'
    const r = make()
    await expect(r.run('echo-pid', {})).rejects.toMatchObject({ code: 'HELPER_VERSION_MISMATCH' })
    await expect(r.run('echo-pid', {})).rejects.toMatchObject({ code: 'HELPER_VERSION_MISMATCH' })
  })

  it('oversized line discards the helper', async () => {
    const r = createStdioRunner(FAKE, { firstRequestMs: 10_000, requestMs: 10_000 })
    runners.push(r)
    await expect(r.run('huge', {})).rejects.toMatchObject({ code: 'HELPER_CRASHED', message: expect.stringContaining('response too large') })
    // naechster Aufruf startet frisch
    await expect(r.run('echo-pid', {})).resolves.toHaveProperty('pid')
  }, 20_000)

  it('crash rejects pending and next call restarts', async () => {
    const r = make()
    const before = (await r.run('echo-pid', {})) as { pid: number }
    await expect(r.run('crash', {})).rejects.toMatchObject({ code: 'HELPER_CRASHED' })
    const after = (await r.run('echo-pid', {})) as { pid: number }
    expect(after.pid).not.toBe(before.pid)
  })

  it('reports an unreadable line as HELPER_CRASHED', async () => {
    await expect(make().run('garbage', {})).rejects.toMatchObject({ code: 'HELPER_CRASHED' })
  })

  it('a response without a numeric id discards the helper instead of answering the oldest request', async () => {
    const r = make()
    const before = (await r.run('echo-pid', {})) as { pid: number }
    // Die aelteste offene Anfrage (hang) darf die id-lose Antwort nicht bekommen; beide scheitern laut.
    const results = await Promise.allSettled([r.run('hang', {}), r.run('null-id', {})])
    for (const result of results) {
      expect(result).toMatchObject({ status: 'rejected', reason: { code: 'HELPER_CRASHED' } })
    }
    await expect(r.run('string-id', {})).rejects.toMatchObject({ code: 'HELPER_CRASHED' })
    const after = (await r.run('echo-pid', {})) as { pid: number }
    expect(after.pid).not.toBe(before.pid)
  })

  it('reports a missing binary as HELPER_MISSING', async () => {
    await expect(make('/nonexistent/mail-helper').run('echo-pid', {})).rejects.toMatchObject({ code: 'HELPER_MISSING' })
  })

  it('restarts after two consecutive timeouts on a warm helper', async () => {
    const r = make()
    const before = (await r.run('echo-pid', {})) as { pid: number }
    await expect(r.run('hang', {})).rejects.toMatchObject({ code: 'HELPER_TIMEOUT' })
    await expect(r.run('hang', {})).rejects.toMatchObject({ code: 'HELPER_TIMEOUT' })
    const after = (await r.run('echo-pid', {})) as { pid: number }
    expect(after.pid).not.toBe(before.pid)
  }, 15_000)

  it('stop kills the child', async () => {
    const r = make()
    const { pid } = (await r.run('echo-pid', {})) as { pid: number }
    r.stop()
    await new Promise((res) => setTimeout(res, 200))
    expect(() => process.kill(pid, 0)).toThrow()
  })

  it('hello timeout rejects waiting calls and the next call spawns fresh', async () => {
    process.env.FAKE_HELLO_HANG = '1'
    const r = createStdioRunner(FAKE, { firstRequestMs: 400, requestMs: 400 })
    runners.push(r)
    const results = await Promise.allSettled([r.run('echo-pid', {}), r.run('echo-pid', {})])
    for (const x of results) expect(x).toMatchObject({ status: 'rejected', reason: { code: 'HELPER_TIMEOUT' } })
    delete process.env.FAKE_HELLO_HANG
    await expect(r.run('echo-pid', {})).resolves.toHaveProperty('pid')
  }, 10_000)

  it('the first real request after hello gets the long deadline, later ones the short one', async () => {
    const r = createStdioRunner(FAKE, { firstRequestMs: 800, requestMs: 100 })
    runners.push(r)
    let t0 = Date.now()
    // hello oeffnet die Datenbank nie; erst die erste echte Anfrage ist kalt (Spec 7.2).
    await expect(r.run('hang', {})).rejects.toMatchObject({ code: 'HELPER_TIMEOUT', message: expect.stringContaining('800ms') })
    expect(Date.now() - t0).toBeGreaterThanOrEqual(750)
    // Bis eine echte Anfrage beantwortet ist, bleibt der Helper kalt.
    await expect(r.run('echo-pid', {})).resolves.toHaveProperty('pid')
    t0 = Date.now()
    await expect(r.run('hang', {})).rejects.toMatchObject({ code: 'HELPER_TIMEOUT', message: expect.stringContaining('100ms') })
    expect(Date.now() - t0).toBeLessThan(600)
  }, 10_000)

  it('two timeouts after hello restart the helper even before any real request was answered', async () => {
    const log = logFile()
    const r = createStdioRunner(FAKE, { firstRequestMs: 200, requestMs: 100 })
    runners.push(r)
    // hello ok, danach haengen zwei echte Anfragen: der Helper wird verworfen, der naechste Aufruf startet frisch.
    await expect(r.run('hang', {})).rejects.toMatchObject({ code: 'HELPER_TIMEOUT' })
    await expect(r.run('hang', {})).rejects.toMatchObject({ code: 'HELPER_TIMEOUT' })
    await expect(r.run('echo-pid', {})).resolves.toHaveProperty('pid')
    expect(readFileSync(log, 'utf8').trim().split('\n')).toEqual(['hello', 'hang', 'hang', 'hello', 'echo-pid'])
  }, 10_000)

  it('a successful answer resets the timeout counter', async () => {
    const log = logFile()
    const r = createStdioRunner(FAKE, { firstRequestMs: 200, requestMs: 100 })
    runners.push(r)
    await expect(r.run('hang', {})).rejects.toMatchObject({ code: 'HELPER_TIMEOUT' })
    await r.run('echo-pid', {})
    await expect(r.run('hang', {})).rejects.toMatchObject({ code: 'HELPER_TIMEOUT' })
    await r.run('echo-pid', {})
    // Nie zwei Timeouts in Folge: kein zweites hello.
    expect(readFileSync(log, 'utf8').trim().split('\n')).toEqual(['hello', 'hang', 'echo-pid', 'hang', 'echo-pid'])
  }, 10_000)

  it('parses a 22 MB response line in well under the deadline', async () => {
    const r = createStdioRunner(FAKE, { firstRequestMs: 10_000, requestMs: 10_000 })
    runners.push(r)
    await r.run('echo-pid', {})
    const t0 = Date.now()
    const out = (await r.run('big', {})) as { s: string }
    const ms = Date.now() - t0
    expect(out.s.length).toBe(22 * 1024 * 1024)
    expect(out.s[0]).toBe('x')
    expect(ms).toBeLessThan(3_000)
  }, 20_000)

  it('debug writes one line per request with command, duration and outcome, never payload or result', async () => {
    const lines: string[] = []
    const r = createStdioRunner(FAKE, fast, { debug: true, log: (l) => void lines.push(l) })
    runners.push(r)
    await r.run('echo-payload', { secret: 'payload-geheim' })
    await expect(r.run('fail', {})).rejects.toMatchObject({ code: 'MESSAGE_NOT_FOUND' })
    expect(lines).toHaveLength(3)
    expect(lines[0]).toMatch(/^apple-mail-mcp: hello \d+ ms ok$/)
    expect(lines[1]).toMatch(/^apple-mail-mcp: echo-payload \d+ ms ok$/)
    expect(lines[2]).toMatch(/^apple-mail-mcp: fail \d+ ms MESSAGE_NOT_FOUND$/)
    expect(lines.join('\n')).not.toContain('geheim')
  })

  it('without debug nothing is logged', async () => {
    const lines: string[] = []
    const r = createStdioRunner(FAKE, fast, { debug: false, log: (l) => void lines.push(l) })
    runners.push(r)
    await r.run('echo-pid', {})
    expect(lines).toEqual([])
  })

  it('exposes the helper version after the handshake', async () => {
    const r = make()
    expect(r.helperVersion()).toBeNull()
    await r.run('echo-pid', {})
    expect(r.helperVersion()).toBe('0.1.0')
  })
})
