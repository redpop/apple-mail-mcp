import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { McpServer } from '@modelcontextprotocol/server'
import { describe, expect, test } from 'vitest'
import { foldTerm } from '../../src/bodyScan.js'
import { createIndexer, type Indexer, type IndexerStatus } from '../../src/bodyIndex/indexer.js'
import { indexProgressNote, searchIndex } from '../../src/bodyIndex/search.js'
import { indexDir, loadSqlite } from '../../src/bodyIndex/store.js'
import { loadConfig, type Config } from '../../src/config.js'
import { createContext } from '../../src/context.js'
import { createServer } from '../../src/server.js'
import { FakeMail } from './fakeMail.js'

const sqlite = (await loadSqlite())!
const SECURITY_BODY = 'Your verification code is 482913. It expires in 10 minutes.'

function configOf(env: Record<string, string>): Config {
  const r = loadConfig(env)
  if (!r.ok) throw new Error(r.error)
  return r.config
}

/** Server mit Index (oder ohne: index false) ueber derselben FakeMail. */
async function setup(mail: FakeMail, env: Record<string, string> = {}, opts: { index?: boolean; build?: boolean } = {}) {
  const fullEnv = { APPLE_MAIL_BODY_INDEX: 'true', ...env }
  const configResult = loadConfig(fullEnv)
  let indexer: Indexer | null = null
  const ctx = createContext({
    runner: mail.runner,
    configResult,
    bundlePath: '/pkg/Mail MCP Helper.app',
    helperName: 'Mail MCP Helper',
    open: () => {},
    stateDir: mkdtempSync(join(tmpdir(), 'mailmcp-search-state-')),
    bodyIndex: () => indexer,
  })
  if (opts.index !== false) {
    indexer = createIndexer({
      runner: mail.runner, config: configOf(fullEnv), policy: () => ctx.policy(), sqlite,
      dir: indexDir(mkdtempSync(join(tmpdir(), 'mailmcp-search-'))), exclude: () => {},
      timers: false, yieldFn: async () => {}, log: () => {},
    })
    if (opts.build !== false) await indexer.runCycle()
  }
  return { server: createServer(ctx), indexer, ctx }
}

interface Reg { handler: (args: unknown, ctx?: unknown) => Promise<any>; inputSchema: any; outputSchema: any }
async function call(server: McpServer, args: Record<string, unknown>) {
  const t = (server as unknown as { _registeredTools: Record<string, Reg> })._registeredTools.search_messages!
  const res = await t.handler(t.inputSchema.parse(args), {})
  if (res.isError) throw new Error(res.content[0].text)
  t.outputSchema.parse(res.structuredContent)
  return res.structuredContent
}

/** Alle Seiten einer Suche: Treffer (gid, matchContext) in Reihenfolge. */
async function allPages(server: McpServer, args: Record<string, unknown>) {
  const out: { gid: string; matchContext: string }[] = []
  let cursor: string | undefined
  for (let i = 0; i < 50; i++) {
    const s = await call(server, { ...args, ...(cursor ? { cursor } : {}) })
    for (const m of s.messages) out.push({ gid: m.id, matchContext: m.matchContext })
    if (s.nextCursor === null) return out
    cursor = s.nextCursor
  }
  throw new Error('no end')
}

function world(): FakeMail {
  const mail = new FakeMail()
  mail.add(1, 'Ihre Stromrechnung für   März ist da.')
  mail.add(2, 'Grüße aus der Straße, bis bald.')
  mail.add(3, 'Er sagte "hallo" und ging.\n\nNeue Zeile mit   viel\tLeerraum.')
  mail.add(4, 'STRASSENFEST am Samstag; die Rechnung kommt später.')
  mail.add(5, SECURITY_BODY, { subject: 'Sign in' })
  mail.add(6, null)
  mail.add(7, 'Noch eine rechnung, klein geschrieben.', { mailbox: 3 })
  mail.add(8, 'Grüsse ohne scharfes s.')
  return mail
}

const TERMS = ['rechnung', 'Strom rechnung', 'STRASSE', 'straße', 'grüße', 'Grüsse', '"hallo"', 'sagte "hallo" und', 'viel leerraum', 'März', 'verification code', 'nirgends']

describe('search_messages over the body index', () => {
  for (const show of ['false', 'true']) {
    test(`same matches, order and matchContext as the live scan (SHOW_SECURITY_MAILS=${show})`, async () => {
      const env = { APPLE_MAIL_SHOW_SECURITY_MAILS: show }
      const indexed = await setup(world(), env)
      const live = await setup(world(), env, { index: false })
      for (const term of TERMS) {
        for (const limit of [1, 2, 20]) {
          const a = await allPages(indexed.server, { bodyContains: term, limit })
          const b = await allPages(live.server, { bodyContains: term, limit })
          expect(a, `${term} limit ${limit}`).toEqual(b)
        }
      }
      // Gegenprobe: der Test vergleicht nicht nur leere Listen.
      expect((await allPages(indexed.server, { bodyContains: 'rechnung' })).map((m) => m.gid)).toEqual(['7', '4', '1'])
      expect((await allPages(indexed.server, { bodyContains: 'verification code' })).length).toBe(show === 'true' ? 1 : 0)
      indexed.indexer!.stop()
    })
  }

  test('answers with bodyIndex instead of scan, without totalMatched', async () => {
    const { server, indexer } = await setup(world())
    const s = await call(server, { bodyContains: 'rechnung' })
    expect(s.scan).toBeUndefined()
    expect(s.totalMatched).toBeUndefined()
    expect(s.bodyIndex).toEqual({ indexed: 6, lastUpdated: expect.stringMatching(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d[+-]\d\d:\d\d$/) })
    expect(s.note).toBe('Searched the body index of 6 messages and found 3 matches.')
    const page = await call(server, { bodyContains: 'rechnung', limit: 2 })
    expect(page.note).toBe('Searched the body index of 6 messages and found 2 matches. Call again with nextCursor for more.')
    indexer!.stop()
  })

  test('the note does not depend on the term beyond the matches shown', async () => {
    const { server, indexer } = await setup(world())
    const a = await call(server, { bodyContains: 'nirgends' })
    const b = await call(server, { bodyContains: 'verification code' })
    expect(a).toEqual(b)
    indexer!.stop()
  })

  test('mail that arrived after the build is caught up before the search', async () => {
    const mail = world()
    const { server, indexer } = await setup(mail)
    mail.add(9, 'Brandneue Rechnung')
    expect((await call(server, { bodyContains: 'brandneue' })).messages.map((m: { id: string }) => m.id)).toEqual(['9'])
    indexer!.stop()
  })

  test('terms shorter than three characters scan live', async () => {
    const { server, indexer } = await setup(world())
    const s = await call(server, { bodyContains: 'mä' })
    expect(s.bodyIndex).toBeUndefined()
    expect(s.scan).toBeDefined()
    expect(s.messages.map((m: { id: string }) => m.id)).toEqual(['1'])
    expect(s.note).toMatch(/Terms shorter than 3 characters are not looked up in the body index/)
    indexer!.stop()
  })

  test('before the index is complete the search scans live and says how far the build is', async () => {
    const { server, indexer } = await setup(world(), {}, { build: false })
    const s = await call(server, { bodyContains: 'rechnung' })
    expect(s.bodyIndex).toBeUndefined()
    expect(s.scan).toBeDefined()
    expect(s.note).toMatch(/The body index is still being built; until it is complete, bodyContains scans live\.$/)
    indexer!.stop()
  })

  test('a cursor from a live page continues over the index and back', async () => {
    const mail = world()
    const live = await setup(mail, {}, { index: false })
    const indexed = await setup(mail)
    const first = await call(live.server, { bodyContains: 'rechnung', limit: 1 })
    const second = await call(indexed.server, { bodyContains: 'rechnung', limit: 1, cursor: first.nextCursor })
    expect(second.bodyIndex).toBeDefined()
    const third = await call(live.server, { bodyContains: 'rechnung', limit: 5, cursor: second.nextCursor })
    expect([first, second, third].flatMap((s) => s.messages.map((m: { id: string }) => m.id))).toEqual(['7', '4', '1'])
    indexed.indexer!.stop()
  })
})

describe('searchIndex', () => {
  test('more hits than the helper accepts: falls back', async () => {
    const mail = world()
    const { indexer, ctx } = await setup(mail)
    const index = indexer!.reader()!
    const res = await searchIndex({
      runner: mail.runner, policy: await ctx.policy(), config: ctx.config(), filters: {}, term: foldTerm('rechnung'),
      after: null, limit: 20, index, maxHits: 2,
    })
    expect(res).toEqual({ kind: 'too_many' })
    index.close()
    indexer!.stop()
  })

  test('a hit the confirmation rejects is skipped and the page is filled from further rows', async () => {
    const mail = world()
    const { indexer, ctx } = await setup(mail)
    const index = indexer!.reader()!
    // FTS-Fehltreffer simulieren: gid 4 kommt aus der Abfrage, ihr Text enthaelt den Begriff nicht.
    const fake = { ...index, matchGids: () => [1, 4, 7], texts: (g: number[]) => new Map([...index.texts(g)].map(([k, v]) => [k, k === 4 ? 'anders' : v])) }
    const res = await searchIndex({
      runner: mail.runner, policy: await ctx.policy(), config: ctx.config(), filters: {}, term: foldTerm('rechnung'),
      after: null, limit: 1, index: fake,
    })
    expect(res.kind === 'ok' && res.matches.map((m) => m.row.gid)).toEqual([7])
    const next = await searchIndex({
      runner: mail.runner, policy: await ctx.policy(), config: ctx.config(), filters: {}, term: foldTerm('rechnung'),
      after: res.kind === 'ok' ? res.resumeAfter : null, limit: 1, index: fake,
    })
    expect(next.kind === 'ok' && next.matches.map((m) => m.row.gid)).toEqual([1])
    expect(next.kind === 'ok' && next.resumeAfter).toBeNull()
    index.close()
    indexer!.stop()
  })
})

describe('indexProgressNote', () => {
  const st = (over: Partial<IndexerStatus>): IndexerStatus => ({
    state: 'building', holdsLease: true, buildComplete: false, indexed: 0, skipped: 0, total: null, lastUpdated: null, ...over,
  })
  test('building with and without a known total, and unavailable', () => {
    expect(indexProgressNote(st({}))).toBe('The body index is still being built; until it is complete, bodyContains scans live.')
    expect(indexProgressNote(st({ indexed: 400, skipped: 50, total: 1000 }))).toBe(
      'The body index is still being built (45% done); until it is complete, bodyContains scans live.',
    )
    expect(indexProgressNote(st({ indexed: 1000, total: 1000 }))).toMatch(/\(99% done\)/)
    expect(indexProgressNote(st({ state: 'idle' }))).toMatch(/still being built/)
    expect(indexProgressNote(st({ state: 'foreign', holdsLease: false }))).toBe('The body index is not available right now, so bodyContains scanned live.')
  })
})
