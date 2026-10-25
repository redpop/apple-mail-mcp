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

afterEach(() => {
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
    process.env.FAKE_PROTOCOL_VERSION = '2'
    const r = make()
    await expect(r.run('echo-pid', {})).rejects.toMatchObject({ code: 'HELPER_VERSION_MISMATCH' })
    await expect(r.run('echo-pid', {})).rejects.toMatchObject({ code: 'HELPER_VERSION_MISMATCH' })
  })

  it('oversized line discards the helper', async () => {
    const r = make()
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
})
