import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { CANDIDATE_CAP, findMatch, scanBodies } from '../src/bodyScan.js'
import { loadConfig, type Config } from '../src/config.js'
import { createContext } from '../src/context.js'
import { HelperError } from '../src/errors.js'
import type { HelperRunner } from '../src/helper.js'
import { computePolicy } from '../src/policy.js'
import { createServer } from '../src/server.js'

const mailboxes = {
  mailboxes: [{ id: 1, url: 'imap://ACC1/INBOX', total: 10, unread: 2 }],
  accounts: [{ uuid: 'ACC1', description: 'Privat', username: 'a@example.com' }],
  accountNames: 'available',
}

function cfg(env: Record<string, string> = {}): Config {
  const r = loadConfig(env)
  if (!r.ok) throw new Error(r.error)
  return r.config
}

function row(gid: number, over: Record<string, unknown> = {}) {
  return {
    gid,
    messageIdHeader: `<m${gid}@example.com>`,
    subject: `Subject ${gid}`,
    sender: { address: 'anna@example.com', name: 'Anna' },
    recipients: [],
    recipientCount: 0,
    dateReceived: 2000000 - gid,
    dateSent: null,
    mailboxIds: [1],
    read: true,
    flagged: false,
    attachmentNames: [],
    conversationId: null,
    file: 'full',
    ...over,
  }
}

function raw(body: string): string {
  const mime = `From: Anna <anna@example.com>\r\nSubject: x\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${body}\r\n`
  return Buffer.from(`${Buffer.byteLength(mime)}\n${mime}`).toString('base64')
}

interface World {
  rows: ReturnType<typeof row>[]
  bodies: Record<number, string>
  onCall?: (command: string) => void
  budgetOnce?: boolean
}

/** Fake-Helper: search blaettert ueber world.rows (absteigend nach gid-Reihenfolge), get-messages liefert Rohtexte. */
function fakeRunner(w: World) {
  const calls: { command: string; payload: Record<string, any> }[] = []
  let budgetUsed = false
  const runner: HelperRunner = {
    async run(command, payload: Record<string, any>) {
      calls.push({ command, payload })
      w.onCall?.(command)
      if (command === 'list-mailboxes') return mailboxes
      if (command === 'search') {
        const start = payload.after ? w.rows.findIndex((r) => r.gid === payload.after.gid) + 1 : 0
        const page = w.rows.slice(start, start + payload.limit)
        return { messages: page, hasMore: start + payload.limit < w.rows.length }
      }
      if (command === 'get-messages') {
        const gids: number[] = payload.gids
        let messages = gids.map((g) => {
          const r = w.rows.find((x) => x.gid === g)!
          const b = w.bodies[g]
          return { ...r, raw: r.file === 'none' || b === undefined ? null : raw(b), rawSize: 10, rawTruncated: false }
        })
        let budgetExhausted = false
        if (w.budgetOnce && !budgetUsed && gids.length > 2) {
          budgetUsed = true
          budgetExhausted = true
          messages = messages.map((m, i) => (i >= 2 ? { ...m, raw: null } : m))
        }
        return { messages, missing: [], budgetExhausted }
      }
      throw new Error(`unexpected ${command}`)
    },
  }
  return { runner, calls }
}

const policyOf = (config: Config) => computePolicy(config, mailboxes as never)

async function scan(w: World, over: Record<string, unknown> = {}, env: Record<string, string> = {}) {
  const { runner, calls } = fakeRunner(w)
  const config = cfg(env)
  const res = await scanBodies({ runner, policy: policyOf(config), config, filters: {}, term: 'needle', after: null, limit: 20, ...over } as never)
  return { res, calls }
}

const rowsOf = (n: number, over: (i: number) => Record<string, unknown> = () => ({})) => Array.from({ length: n }, (_, i) => row(i + 1, over(i + 1)))

describe('scanBodies', () => {
  it('stops at limit and resumes after the last scanned candidate', async () => {
    const rows = rowsOf(10)
    const bodies: Record<number, string> = {}
    for (const r of rows) bodies[r.gid] = r.gid % 2 === 0 ? 'has a needle here' : 'nothing'
    const { res, calls } = await scan({ rows, bodies }, { limit: 2 })
    expect(res.matches.map((m) => m.row.gid)).toEqual([2, 4])
    expect(res.scan).toEqual({ scanned: 4, unavailable: 0, stoppedBy: 'limit', complete: false })
    expect(res.resumeAfter).toEqual({ d: rows[3]!.dateReceived, g: 4 })
    const search = calls.find((c) => c.command === 'search')!.payload
    expect(search).toMatchObject({ limit: 200, countTotal: false, maxRecipients: 5, allowedMailboxIds: [1] })
    const get = calls.find((c) => c.command === 'get-messages')!.payload
    expect(get).toMatchObject({ maxBytesPerMessage: 256 * 1024, maxBytesTotal: 16 * 1024 * 1024 })
    // Fortsetzung ab dem Keyset
    const next = await scan({ rows, bodies }, { limit: 2, after: res.resumeAfter })
    expect(next.res.matches.map((m) => m.row.gid)).toEqual([6, 8])
    expect(next.calls.find((c) => c.command === 'search')!.payload.after).toEqual({ date: rows[3]!.dateReceived, gid: 4 })
  })

  it('reports complete with stoppedBy null when all candidates were scanned', async () => {
    const rows = rowsOf(3)
    const { res } = await scan({ rows, bodies: { 1: 'needle', 2: 'x', 3: 'y' } }, { limit: 1 })
    // Treffer beim ersten Kandidaten, aber es gibt weitere: limit.
    expect(res.scan.stoppedBy).toBe('limit')
    const all = await scan({ rows, bodies: { 1: 'x', 2: 'y', 3: 'needle' } }, { limit: 1 })
    expect(all.res.scan).toEqual({ scanned: 3, unavailable: 0, stoppedBy: null, complete: true })
    expect(all.res.resumeAfter).toBeNull()
  })

  it('stops at 2000 candidates with stoppedBy cap', async () => {
    const rows = rowsOf(CANDIDATE_CAP + 300)
    const bodies: Record<number, string> = {}
    for (const r of rows) bodies[r.gid] = 'nothing'
    const { res, calls } = await scan({ rows, bodies })
    expect(res.scan).toEqual({ scanned: 2000, unavailable: 0, stoppedBy: 'cap', complete: false })
    expect(res.resumeAfter).toEqual({ d: rows[1999]!.dateReceived, g: 2000 })
    expect(calls.filter((c) => c.command === 'search')).toHaveLength(10)
    expect(calls.filter((c) => c.command === 'get-messages').every((c) => c.payload.gids.length <= 50)).toBe(true)
  })

  it('stops after 3 s with stoppedBy time (fake clock)', async () => {
    const rows = rowsOf(120)
    const bodies: Record<number, string> = {}
    for (const r of rows) bodies[r.gid] = 'nothing'
    let t = 0
    const { res } = await scan({ rows, bodies, onCall: (c) => { if (c === 'get-messages') t += 2000 } }, { now: () => t })
    // Zwei Bloecke zu 50 sind geholt, danach ist das Budget weg: erst 50, nach dem zweiten Abruf 4000 ms.
    expect(res.scan.stoppedBy).toBe('time')
    expect(res.scan.complete).toBe(false)
    expect(res.scan.scanned).toBe(51)
    expect(res.resumeAfter?.g).toBe(51)
  })

  it('security mails never match even if the term is in the body', async () => {
    const rows = rowsOf(2, (g) => (g === 1 ? { subject: 'Your verification code' } : {}))
    const bodies = { 1: 'Your verification code is 482913. Never share it.', 2: 'unrelated 482913 number' }
    const { res } = await scan({ rows, bodies }, { term: '482913' })
    expect(res.matches.map((m) => m.row.gid)).toEqual([2])
    expect(res.scan.scanned).toBe(2)
  })

  it('a security mail detected only by its body cannot be found by its code (E2)', async () => {
    // Neutraler Betreff, nur der Text verraet die Sicherheitsmail.
    const rows = rowsOf(1, () => ({ subject: 'Hello' }))
    const { res } = await scan({ rows, bodies: { 1: 'Your verification code is 482913' } }, { term: '482913' })
    expect(res.matches).toEqual([])
    // Nur scanned zaehlt; die Mail ist weder "nicht verfuegbar" noch beendet sie den Scan.
    expect(res.scan).toEqual({ scanned: 1, unavailable: 0, stoppedBy: null, complete: true })
    expect(res.resumeAfter).toBeNull()
  })

  it('a decomposed search term matches precomposed text', async () => {
    const rows = rowsOf(1)
    const decomposed = 'ko\u0308ln'
    expect(decomposed).not.toBe('köln')
    const { res } = await scan({ rows, bodies: { 1: 'Treffen in Köln am Montag' } }, { term: decomposed })
    expect(res.matches.map((m) => m.row.gid)).toEqual([1])
    expect(res.matches[0]!.matchContext).toContain('Köln')
  })

  it('security mails match when APPLE_MAIL_SHOW_SECURITY_MAILS is true', async () => {
    const rows = rowsOf(1, () => ({ subject: 'Your verification code' }))
    const { res } = await scan({ rows, bodies: { 1: 'Your verification code is 482913.' } }, { term: '482913' }, { APPLE_MAIL_SHOW_SECURITY_MAILS: 'true' })
    expect(res.matches).toHaveLength(1)
    expect(res.matches[0]!.matchContext).toContain('482913')
  })

  it('matching folds umlauts and collapses whitespace', async () => {
    const rows = rowsOf(3)
    const bodies = { 1: 'Das GRÖSSTE  Fest\r\n  des Jahres', 2: 'Straße nach Köln', 3: 'groesste' }
    const a = await scan({ rows, bodies }, { term: 'größte   fest' })
    expect(a.res.matches.map((m) => m.row.gid)).toEqual([1])
    expect(a.res.matches[0]!.matchContext).toBe('Das GRÖSSTE Fest des Jahres')
    const b = await scan({ rows, bodies }, { term: 'STRASSE' })
    expect(b.res.matches.map((m) => m.row.gid)).toEqual([2])
    // diakritiksensitiv: ö ≠ o
    const c = await scan({ rows, bodies }, { term: 'koln' })
    expect(c.res.matches).toHaveLength(0)
  })

  it('messages without file count as unavailable', async () => {
    const rows = [row(1, { file: 'none' }), row(2), row(3)]
    const { res, calls } = await scan({ rows, bodies: { 2: 'needle', 3: 'x' } })
    expect(res.scan).toEqual({ scanned: 3, unavailable: 1, stoppedBy: null, complete: true })
    expect(res.matches.map((m) => m.row.gid)).toEqual([2])
    expect(calls.find((c) => c.command === 'get-messages')!.payload.gids).toEqual([2, 3])
  })

  it('requests the rest of a batch after budgetExhausted', async () => {
    const rows = rowsOf(5)
    const bodies = { 1: 'x', 2: 'x', 3: 'x', 4: 'needle', 5: 'x' }
    const { res, calls } = await scan({ rows, bodies, budgetOnce: true })
    expect(res.matches.map((m) => m.row.gid)).toEqual([4])
    expect(res.scan.unavailable).toBe(0)
    const gets = calls.filter((c) => c.command === 'get-messages')
    expect(gets).toHaveLength(2)
    expect(gets[1]!.payload.gids).toEqual([3, 4, 5])
  })

  it('helper crash mid-scan surfaces HELPER_CRASHED and the next call works', async () => {
    const rows = rowsOf(3)
    let crash = true
    const w: World = { rows, bodies: { 1: 'needle', 2: 'x', 3: 'x' }, onCall: (c) => { if (c === 'get-messages' && crash) { crash = false; throw new HelperError('HELPER_CRASHED', 'boom') } } }
    await expect(scan(w)).rejects.toMatchObject({ code: 'HELPER_CRASHED' })
    const ok = await scan(w)
    expect(ok.res.matches).toHaveLength(1)
  })
})

describe('findMatch', () => {
  it('keeps positions correct when fold changes length (ß)', () => {
    const text = 'Eine Straße in der Stadt ist die Fußstraße der Maße'
    expect(findMatch(text, 'fussstrasse')).toBe(text)
    const ctx = findMatch('x'.repeat(300) + ' Fußgänger ' + 'y'.repeat(300), 'fussgänger')!
    expect(ctx.length).toBeLessThanOrEqual(160)
    expect(ctx).toContain('Fußgänger')
    expect(findMatch('y'.repeat(300) + ' needle', 'needle')!.endsWith('needle')).toBe(true)
  })
})

describe('search_messages bodyContains', () => {
  function setup(w: World, env: Record<string, string> = {}) {
    const { runner, calls } = fakeRunner(w)
    const ctx = createContext({ runner, configResult: loadConfig(env), bundlePath: '/x.app', open: () => {}, stateDir: mkdtempSync(join(tmpdir(), 'bs-')) })
    const server = createServer(ctx)
    const t = (server as unknown as { _registeredTools: Record<string, any> })._registeredTools.search_messages
    const call = async (args: Record<string, unknown>) => t.handler(t.inputSchema.parse(args), {})
    return { call, calls }
  }

  it('search_messages with bodySearch=false rejects bodyContains with INVALID_INPUT', async () => {
    const { call, calls } = setup({ rows: [], bodies: {} }, { APPLE_MAIL_BODY_SEARCH: 'false' })
    const res = await call({ bodyContains: 'invoice' })
    expect(res.isError).toBe(true)
    expect(res.content[0].text).toMatch(/disabled|turned off/i)
    expect(calls.filter((c) => c.command === 'search')).toHaveLength(0)
  })

  it('search_messages note mentions scanned count and how to continue', async () => {
    const rows = rowsOf(10)
    const bodies: Record<number, string> = {}
    for (const r of rows) bodies[r.gid] = 'a needle'
    const { call } = setup({ rows, bodies })
    const res = await call({ bodyContains: 'needle', limit: 3 })
    expect(res.isError).toBeUndefined()
    const s = res.structuredContent
    expect(s.scan).toEqual({ scanned: 3, unavailable: 0, stoppedBy: 'limit', complete: false })
    expect(s.totalMatched).toBeUndefined()
    expect(s.messages[0].matchContext).toBe('a needle')
    expect(s.note).toContain('Scanned the 3 newest candidate messages')
    expect(s.note).toContain('3 matches')
    expect(s.note).toContain('nextCursor to continue')
    // Cursor setzt den Scan fort und gehoert nur zu dieser Suche
    const next = await call({ bodyContains: 'needle', limit: 3, cursor: s.nextCursor })
    expect(next.structuredContent.messages.map((m: any) => m.id)).toEqual(['4', '5', '6'])
    const other = await call({ bodyContains: 'other', limit: 3, cursor: s.nextCursor })
    expect(other.isError).toBe(true)
  })
})
