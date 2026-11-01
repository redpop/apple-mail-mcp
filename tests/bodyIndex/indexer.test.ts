import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { foldFast } from '../../src/bodyScan.js'
import { loadConfig, type Config } from '../../src/config.js'
import { HelperError } from '../../src/errors.js'
import { createIndexer, type IndexerDeps } from '../../src/bodyIndex/indexer.js'
import { createLease } from '../../src/bodyIndex/lease.js'
import { indexDir, loadSqlite, openStore } from '../../src/bodyIndex/store.js'
import { FakeMail } from './fakeMail.js'

const sqlite = (await loadSqlite())!
const config = (env: Record<string, string> = {}): Config => {
  const r = loadConfig({ APPLE_MAIL_BODY_INDEX: 'true', ...env })
  if (!r.ok) throw new Error(r.error)
  return r.config
}

function make(mail: FakeMail, over: Partial<IndexerDeps> = {}) {
  const dir = over.dir ?? indexDir(mkdtempSync(join(tmpdir(), 'mailmcp-indexer-')))
  const logs: string[] = []
  const indexer = createIndexer({
    runner: mail.runner, config: config(), policy: mail.policy, sqlite, dir, exclude: () => {},
    timers: false, yieldFn: async () => {}, log: (l) => logs.push(l), ...over,
  })
  return { indexer, dir, logs }
}

/** Liest den Index ueber eine zweite Verbindung (WAL erlaubt Lesen neben dem Schreiber). */
function peek(dir: string) {
  const s = openStore(sqlite, dir, { exclude: () => {} })
  const out = {
    docs: s.docGids().sort((a, b) => a - b),
    skipped: Object.fromEntries(s.skipped()),
    meta: ((m) => (k: string) => m.get(k) ?? null)(new Map(['highWater', 'buildComplete', 'total', 'indexFingerprint', 'envelopeFingerprint', 'classifierVersion'].map((k) => [k, s.meta(k)]))),
    match: (term: string) => {
      const t = openStore(sqlite, dir, { exclude: () => {} })
      try {
        return t.matchGids(foldFast(term)).sort((a, b) => a - b)
      } finally {
        t.close()
      }
    },
    texts: s.docs(0, 1000).map((d) => d.text),
  }
  s.close()
  return out
}

const SECURITY_BODY = 'Your verification code is 482913. It expires in 10 minutes.'

describe('indexer', () => {
  test('does nothing before a helper call has succeeded', async () => {
    const mail = new FakeMail()
    mail.add(1, 'hello')
    const { indexer, dir } = make(mail)
    await indexer.idle()
    expect(mail.calls).toEqual([])
    expect(existsSync(dir)).toBe(false)
    expect(indexer.status().state).toBe('idle')
    indexer.notify()
    await indexer.idle()
    expect(indexer.status()).toMatchObject({ state: 'ready', buildComplete: true, indexed: 1, holdsLease: true })
    indexer.stop()
  })

  test('initial build: texts, skipped reasons, security mails never in docs or fts', async () => {
    const mail = new FakeMail()
    mail.add(1, 'Ihre Stromrechnung für   März')
    mail.add(2, SECURITY_BODY, { subject: 'Sign in' })
    mail.add(3, null)
    // Ohne Textteil liefert der Parser nichts: parse_failed, erneut versucht erst mit neuem Parser.
    mail.add(4, '   ')
    mail.add(5, 'other mailbox', { mailbox: 9 })
    const { indexer, dir } = make(mail)
    await indexer.runCycle()
    const p = peek(dir)
    expect(p.docs).toEqual([1])
    expect(p.skipped).toEqual({ 2: 'security', 3: 'unavailable', 4: 'parse_failed' })
    expect(p.texts).toEqual(['Ihre Stromrechnung für März'])
    expect(p.match('rechnung')).toEqual([1])
    expect(p.match('verification')).toEqual([])
    expect(p.match('482913')).toEqual([])
    expect(p.meta('buildComplete')).toBe('1')
    expect(p.meta('highWater')).toBe('5')
    expect(p.meta('total')).toBe('4')
    expect(indexer.status()).toMatchObject({ indexed: 1, skipped: 3, total: 4 })
    indexer.stop()
  })

  test('security mails stay out even with APPLE_MAIL_SHOW_SECURITY_MAILS', async () => {
    const mail = new FakeMail()
    mail.add(1, SECURITY_BODY)
    const { indexer, dir } = make(mail, { config: config({ APPLE_MAIL_SHOW_SECURITY_MAILS: 'true' }) })
    await indexer.runCycle()
    expect(peek(dir)).toMatchObject({ docs: [], skipped: { 1: 'security' } })
    indexer.stop()
  })

  test('copies of one gid are indexed once', async () => {
    const mail = new FakeMail()
    mail.add(7, 'alpha')
    mail.add(7, 'alpha')
    mail.add(8, 'beta')
    mail.add(7, 'alpha')
    const { indexer, dir } = make(mail)
    await indexer.runCycle()
    expect(peek(dir).docs).toEqual([7, 8])
    indexer.stop()
  })

  test('resumes after an abort from highWater without refetching', async () => {
    const mail = new FakeMail()
    for (let g = 1; g <= 120; g++) mail.add(g, `text ${g}`)
    let n = 0
    mail.fail = (c) => {
      if (c === 'get-messages' && ++n === 2) throw new HelperError('HELPER_CRASHED', 'x')
    }
    const { indexer, dir, logs } = make(mail)
    await indexer.runCycle()
    expect(indexer.status().state).toBe('error')
    expect(logs).toEqual(['body index: paused after HELPER_CRASHED, retrying in 5 s'])
    expect(peek(dir).meta('highWater')).toBe('50')
    mail.fail = null
    mail.calls = []
    await indexer.runCycle()
    const fetched = mail.callsOf('get-messages').flatMap((c) => c.payload.gids as number[])
    expect(Math.min(...fetched)).toBe(51)
    expect(peek(dir).docs.length).toBe(120)
    expect(indexer.status().state).toBe('ready')
    indexer.stop()
  })

  test('catch-up indexes new mail after the build', async () => {
    const mail = new FakeMail()
    mail.add(1, 'old')
    const { indexer, dir } = make(mail)
    await indexer.runCycle()
    mail.add(2, 'new mail')
    await indexer.catchUp(1000)
    expect(peek(dir).match('new mail')).toEqual([2])
    expect(peek(dir).meta('highWater')).toBe('2')
    indexer.stop()
  })

  test('reconcile removes deleted mail and fetches late bodies', async () => {
    const mail = new FakeMail()
    const r1 = mail.add(1, 'gone soon')
    const r2 = mail.add(2, null)
    const { indexer, dir } = make(mail)
    await indexer.runCycle()
    expect(peek(dir).skipped).toEqual({ 2: 'unavailable' })
    r1.deleted = true
    r2.body = 'downloaded later'
    await indexer.runCycle()
    const p = peek(dir)
    expect(p.docs).toEqual([2])
    expect(p.match('gone')).toEqual([])
    expect(p.match('later')).toEqual([2])
    indexer.stop()
  })

  test('narrowing and widening the configuration', async () => {
    const mail = new FakeMail()
    mail.allowed = [1, 2]
    mail.add(1, 'inbox one', { mailbox: 1 })
    mail.add(2, 'archive two', { mailbox: 2 })
    const first = make(mail)
    await first.indexer.runCycle()
    expect(peek(first.dir).docs).toEqual([1, 2])
    const fp = peek(first.dir).meta('indexFingerprint')
    first.indexer.stop()

    // Eingeengt: andere Konfiguration, Mailbox 2 nicht mehr erlaubt.
    mail.allowed = [1]
    const narrow = make(mail, { dir: first.dir, config: config({ APPLE_MAIL_EXCLUDE_MAILBOXES: 'Archive' }) })
    await narrow.indexer.runCycle()
    expect(peek(first.dir).docs).toEqual([1])
    expect(peek(first.dir).match('archive')).toEqual([])
    expect(peek(first.dir).meta('indexFingerprint')).not.toBe(fp)
    narrow.indexer.stop()

    // Erweitert: Mail unterhalb von highWater kommt nach.
    mail.allowed = [1, 2]
    const wide = make(mail, { dir: first.dir })
    await wide.indexer.runCycle()
    expect(peek(first.dir).docs).toEqual([1, 2])
    expect(peek(first.dir).meta('indexFingerprint')).toBe(fp)
    wide.indexer.stop()
  })

  test('a rebuilt Envelope Index (maxRowid below highWater) discards the file', async () => {
    const mail = new FakeMail()
    for (let g = 1; g <= 5; g++) mail.add(g, `first ${g}`)
    const { indexer, dir, logs } = make(mail)
    await indexer.runCycle()
    mail.rows = []
    mail.add(100, 'second world')
    await indexer.runCycle()
    expect(logs).toContain('body index: rebuilding (mail index changed)')
    await indexer.runCycle()
    const p = peek(dir)
    expect(p.docs).toEqual([100])
    expect(p.meta('highWater')).toBe('1')
    indexer.stop()
  })

  test('a changed Envelope Index fingerprint discards the file', async () => {
    const mail = new FakeMail()
    mail.add(1, 'alpha')
    mail.add(2, 'beta')
    const { indexer, dir } = make(mail)
    await indexer.runCycle()
    mail.fingerprint = 'sha256:other'
    mail.rows = mail.rows.slice(0, 1)
    mail.calls = []
    await indexer.runCycle()
    expect(peek(dir).docs).toEqual([1])
    expect(peek(dir).meta('envelopeFingerprint')).toBe('sha256:other|V10')
    expect(mail.callsOf('get-messages').length).toBe(1)
    indexer.stop()
  })

  test('a new classifier moves stored texts to skipped and refetches former security mails', async () => {
    const mail = new FakeMail()
    mail.add(1, 'first text', { subject: 'Alpha' })
    mail.add(2, 'second text', { subject: 'Beta' })
    const v1 = make(mail, { versions: { classifier: 'c1', parser: 'p' }, classify: (i) => ({ security: i.subject.includes('Alpha'), reason: null }) })
    await v1.indexer.runCycle()
    expect(peek(v1.dir)).toMatchObject({ docs: [2], skipped: { 1: 'security' } })
    v1.indexer.stop()
    mail.calls = []
    const v2 = make(mail, { dir: v1.dir, versions: { classifier: 'c2', parser: 'p' }, classify: (i) => ({ security: i.subject.includes('Beta'), reason: null }) })
    await v2.indexer.runCycle()
    const p = peek(v1.dir)
    expect(p).toMatchObject({ docs: [1], skipped: { 2: 'security' } })
    expect(p.match('second')).toEqual([])
    expect(p.meta('classifierVersion')).toBe('c2')
    // Betreff kam per search mit gids, der Body von 2 wurde nicht erneut gelesen.
    expect(mail.callsOf('search')[0]!.payload.gids).toEqual([2])
    expect(mail.callsOf('get-messages').flatMap((c) => c.payload.gids as number[])).toEqual([1])
    v2.indexer.stop()
  })

  test('a new parser version retries empty and unparsable mail only', async () => {
    const mail = new FakeMail()
    mail.add(1, 'fine')
    const empty = mail.add(2, ' ')
    mail.add(3, null)
    const v1 = make(mail, { versions: { classifier: 'c', parser: 'p1' } })
    await v1.indexer.runCycle()
    v1.indexer.stop()
    empty.body = 'now readable'
    mail.calls = []
    const v2 = make(mail, { dir: v1.dir, versions: { classifier: 'c', parser: 'p2' } })
    await v2.indexer.runCycle()
    expect(mail.callsOf('get-messages').flatMap((c) => c.payload.gids as number[])).toEqual([2])
    expect(peek(v1.dir)).toMatchObject({ docs: [1, 2], skipped: { 3: 'unavailable' } })
    v2.indexer.stop()
  })

  test('without Full Disk Access it pauses and resumes on the next successful call', async () => {
    const mail = new FakeMail()
    mail.access = 'denied'
    mail.add(1, 'hello')
    let t = 1_000_000
    const { indexer, dir } = make(mail, { now: () => t })
    indexer.notify()
    await indexer.idle()
    expect(indexer.status().state).toBe('paused')
    expect(mail.callsOf('index-feed')).toEqual([])
    expect(existsSync(dir)).toBe(false)
    mail.access = 'granted'
    indexer.notify()
    await indexer.idle()
    expect(indexer.status().state).toBe('paused')
    t += 60_000
    indexer.notify()
    await indexer.idle()
    expect(indexer.status().state).toBe('ready')
    indexer.stop()
  })

  test('FULL_DISK_ACCESS_REQUIRED during the build pauses without logging', async () => {
    const mail = new FakeMail()
    mail.add(1, 'hello')
    mail.fail = (c) => {
      if (c === 'get-messages') throw new HelperError('FULL_DISK_ACCESS_REQUIRED', 'x')
    }
    const { indexer, logs } = make(mail)
    await indexer.runCycle()
    expect(indexer.status().state).toBe('paused')
    expect(logs).toEqual([])
    indexer.stop()
  })

  test('a foreign valid lease: no writes, no file', async () => {
    const mail = new FakeMail()
    mail.add(1, 'hello')
    const dir = indexDir(mkdtempSync(join(tmpdir(), 'mailmcp-indexer-')))
    const other = createLease((await import('node:fs')).mkdirSync(dir, { recursive: true }) ?? dir)
    expect(other.acquire()).toBe(true)
    const { indexer } = make(mail, { dir })
    await indexer.runCycle()
    expect(indexer.status()).toMatchObject({ state: 'foreign', holdsLease: false })
    expect(existsSync(join(dir, 'index.sqlite'))).toBe(false)
    expect(mail.callsOf('index-feed')).toEqual([])
    other.release()
    await indexer.runCycle()
    expect(indexer.status()).toMatchObject({ state: 'ready', holdsLease: true })
    indexer.stop()
  })

  test('two instances: only one writes; the loser stops when its lease is taken', async () => {
    const mail = new FakeMail()
    for (let g = 1; g <= 60; g++) mail.add(g, `text ${g}`)
    const a = make(mail)
    const b = make(mail, { dir: a.dir })
    let n = 0
    // Waehrend A baut, uebernimmt B den Lease (als waere A haengen geblieben).
    const stolen = createLease(a.dir, { now: () => Date.now() + 120_000 })
    mail.fail = (c) => {
      if (c === 'get-messages' && ++n === 1) expect(stolen.acquire()).toBe(true)
    }
    await a.indexer.runCycle()
    expect(a.indexer.status()).toMatchObject({ state: 'foreign', holdsLease: false })
    expect(existsSync(join(a.dir, 'index.sqlite')) ? peek(a.dir).docs : []).toEqual([])
    mail.fail = null
    stolen.release()
    await b.indexer.runCycle()
    expect(b.indexer.status()).toMatchObject({ state: 'ready', holdsLease: true })
    await a.indexer.runCycle()
    expect(a.indexer.status().state).toBe('foreign')
    a.indexer.stop()
    b.indexer.stop()
  })

  test('stop releases the lease', async () => {
    const mail = new FakeMail()
    mail.add(1, 'x')
    const { indexer, dir } = make(mail)
    await indexer.runCycle()
    indexer.stop()
    expect(createLease(dir).acquire()).toBe(true)
  })

  test('catchUp reports whether it reached the end of the feed', async () => {
    const mail = new FakeMail()
    mail.add(1, 'eins')
    const { indexer } = make(mail)
    // Ohne Lease (vor dem ersten Durchgang) gibt es nichts nachzuziehen.
    expect(await indexer.catchUp(1000)).toBe(false)
    await indexer.runCycle()
    mail.add(2, 'zwei')
    expect(await indexer.catchUp(1000)).toBe(true)
    let t = 0
    const slow = make(mail, { now: () => (t += 600) })
    await slow.indexer.runCycle()
    mail.add(3, 'drei')
    expect(await slow.indexer.catchUp(500)).toBe(false)
    indexer.stop()
    slow.indexer.stop()
  })

  test('reader: only for a complete index built for this configuration', async () => {
    const mail = new FakeMail()
    mail.add(1, 'Ihre Stromrechnung')
    mail.add(2, SECURITY_BODY, { subject: 'Sign in' })
    const { indexer, dir } = make(mail)
    expect(indexer.reader()).toBeNull()
    await indexer.runCycle()
    const r = indexer.reader()!
    expect(r.matchGids(foldFast('rechnung'))).toEqual([1])
    expect(r.skippedGids('security')).toEqual([2])
    r.close()
    // Eine zweite Instanz mit gleicher Konfiguration liest mit, ohne Lease.
    const same = make(mail, { dir })
    expect(same.indexer.reader()).not.toBeNull()
    same.indexer.reader()!.close()
    // Mit anderer Konfiguration nicht: ihre Treffer waeren andere.
    const other = make(mail, { dir, config: config({ APPLE_MAIL_INCLUDE_JUNK: 'true' }) })
    expect(other.indexer.reader()).toBeNull()
    indexer.stop()
    expect(same.indexer.reader()).not.toBeNull()
    same.indexer.stop()
    expect(same.indexer.reader()).toBeNull()
  })
})
