import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Writable } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { runDoctor, type DoctorExec } from '../src/cli/doctor.js'
import { runSetup } from '../src/cli/setup.js'
import { loadConfig } from '../src/config.js'
import { FDA_SETTINGS_URL } from '../src/fdaPrompt.js'

const BUNDLE = '/opt/x/bin/Mail MCP Helper.app'

function sink() {
  let text = ''
  const out = new Writable({ write(chunk, _enc, cb) { text += String(chunk); cb() } })
  return { out, text: () => text }
}

const probe = (access: string, extra: Record<string, unknown> = {}) => ({
  osVersion: '27.0.1',
  mailDir: access === 'granted' ? 'V10' : null,
  access,
  ...(access === 'granted'
    ? {
        schema: { compatible: true, missing: [], fingerprint: 'sha256:abc123' },
        counts: { mailboxes: 4, messages: 100, uniqueMessages: 80 },
      }
    : {}),
  accountNames: { status: 'available', unmatchedAccounts: 0 },
  ...extra,
})

function fakeRunner(handlers: Record<string, () => unknown>) {
  const calls: string[] = []
  return {
    calls,
    run: async (cmd: string) => {
      calls.push(cmd)
      const h = handlers[cmd]
      if (!h) throw new Error('unexpected ' + cmd)
      return h()
    },
  }
}

describe('setup', () => {
  const base = (runner: ReturnType<typeof fakeRunner>, s: ReturnType<typeof sink>, over = {}) => ({
    runner,
    bundlePath: BUNDLE,
    open: () => {},
    out: s.out,
    isTTY: true,
    sleep: async () => {},
    now: () => 0,
    stateDir: mkdtempSync(join(tmpdir(), 'amm-')),
    ...over,
  })

  it('setup with granted access prints success and the claude mcp add line', async () => {
    const s = sink()
    const code = await runSetup(base(fakeRunner({ probe: () => probe('granted') }), s))
    expect(code).toBe(0)
    expect(s.text()).toContain('claude mcp add apple-mail -- npx -y @redpop/apple-mail-mcp')
    expect(s.text()).toContain('80')
  })

  it('setup denied opens settings and finder, polls every 2 s until granted', async () => {
    const s = sink()
    let n = 0
    const runner = fakeRunner({ probe: () => (++n < 4 ? probe('denied') : probe('granted')) })
    const opens: Array<[string, string[]]> = []
    const sleeps: number[] = []
    const code = await runSetup(
      base(runner, s, { open: (f: string, a: string[]) => opens.push([f, a]), sleep: async (ms: number) => void sleeps.push(ms) }),
    )
    expect(code).toBe(0)
    expect(opens).toEqual([
      ['/usr/bin/open', [FDA_SETTINGS_URL]],
      ['/usr/bin/open', ['-R', BUNDLE]],
    ])
    expect(sleeps).toEqual([2000, 2000, 2000])
    expect(s.text()).toContain('\r')
    expect(s.text()).toContain('claude mcp add')
  })

  it('setup denied gives up after 10 minutes', async () => {
    const s = sink()
    let t = 0
    const code = await runSetup(
      base(fakeRunner({ probe: () => probe('denied') }), s, { now: () => t, sleep: async (ms: number) => { t += ms } }),
    )
    expect(code).toBe(1)
  })

  it('setup without TTY does not wait', async () => {
    const s = sink()
    let slept = 0
    const code = await runSetup(
      base(fakeRunner({ probe: () => probe('denied') }), s, { isTTY: false, sleep: async () => void slept++ }),
    )
    expect(code).toBe(1)
    expect(slept).toBe(0)
    expect(s.text()).not.toContain('\r')
  })

  it('setup with no_mail_data explains and exits 1', async () => {
    const s = sink()
    const code = await runSetup(base(fakeRunner({ probe: () => probe('no_mail_data') }), s))
    expect(code).toBe(1)
    expect(s.text()).toMatch(/Mail.*(set up|account)/)
  })

  it('setup with untrusted_signature exits 1', async () => {
    const s = sink()
    expect(await runSetup(base(fakeRunner({ probe: () => probe('untrusted_signature') }), s))).toBe(1)
  })
})

// Seed-Strings, die in der Standardausgabe nie auftauchen duerfen.
const SEED = ['alice@example.com', 'Secret Project Budget', 'Private Folder', 'Work Account', '11111111-2222-3333-4444-555555555555']

const UUID = SEED[4]!
const mailboxes = (extra: Array<{ id: number; url: string }> = []) => ({
  mailboxes: [
    { id: 1, url: `imap://${UUID}/INBOX`, total: 10, unread: 1 },
    { id: 2, url: `imap://${UUID}/Private%20Folder`, total: 5, unread: 0 },
    { id: 3, url: `imap://${UUID}/Junk`, total: 5, unread: 0 },
    { id: 4, url: `imap://${UUID}/Trash`, total: 5, unread: 0 },
    ...extra.map((e) => ({ ...e, total: 1, unread: 0 })),
  ],
  accounts: [{ uuid: UUID, description: 'Work Account', username: 'alice@example.com' }],
  accountNames: 'available',
})
const searchRes = () => ({
  messages: [
    { file: 'full', subject: 'Secret Project Budget' },
    { file: 'full', subject: 'Secret Project Budget' },
    { file: 'partial', subject: 'Secret Project Budget' },
    { file: 'none', subject: 'Secret Project Budget' },
  ].map((m, i) => ({
    gid: i, messageIdHeader: null, subject: m.subject, sender: { address: 'alice@example.com', name: null }, recipients: [],
    recipientCount: 0, dateReceived: 1, dateSent: null, mailboxIds: [1], read: true, flagged: false, attachmentNames: [],
    conversationId: null, file: m.file,
  })),
  hasMore: false,
})

const codesign = [
  'Executable=/x/mail-helper',
  'Identifier=io.github.redpop.apple-mail-mcp.mail-helper',
  'Format=app bundle with Mach-O thin (arm64)',
  'CodeDirectory v=20500 size=1 flags=0x10000(runtime) hashes=1 location=embedded',
  'Authority=Developer ID Application: Someone (4KTGF63CD2)',
  'Authority=Developer ID Certification Authority',
  'TeamIdentifier=4KTGF63CD2',
].join('\n')

function makeExec(over: { bundleId?: string; stapled?: boolean } = {}): DoctorExec {
  return (file, args) => {
    if (file === '/usr/bin/plutil') return { stdout: (over.bundleId ?? 'io.github.redpop.apple-mail-mcp.mail-helper') + '\n', stderr: '', status: 0 }
    if (file === '/usr/bin/codesign') return { stdout: '', stderr: codesign, status: 0 }
    if (file === '/usr/bin/xcrun') return { stdout: '', stderr: '', status: over.stapled === false ? 1 : 0 }
    throw new Error('unexpected exec ' + file + args.join(' '))
  }
}

function doctorDeps(s: ReturnType<typeof sink>, runner: ReturnType<typeof fakeRunner>, over: Record<string, unknown> = {}) {
  return {
    runner,
    bundlePath: BUNDLE,
    configResult: loadConfig({}),
    exec: makeExec(),
    out: s.out,
    verbose: false,
    json: false,
    stateDir: mkdtempSync(join(tmpdir(), 'amm-doc-')),
    ...over,
  } as Parameters<typeof runDoctor>[0]
}

const goodRunner = (over: Record<string, () => unknown> = {}) =>
  fakeRunner({
    hello: () => ({ protocolVersion: 1, helperVersion: '0.1.0' }),
    probe: () => probe('granted'),
    'list-mailboxes': () => mailboxes(),
    search: () => searchRes(),
    ...over,
  })

describe('doctor', () => {
  it('doctor output without --verbose contains no seed names, addresses or subjects', async () => {
    const s = sink()
    const code = await runDoctor(doctorDeps(s, goodRunner()))
    expect(code).toBe(0)
    for (const seed of SEED) expect(s.text()).not.toContain(seed)
    expect(s.text()).toContain('sha256:abc123')
    expect(s.text()).toContain('full 2')
  })

  it('doctor --verbose warns first and adds mailbox names and account UUIDs', async () => {
    const s = sink()
    await runDoctor(doctorDeps(s, goodRunner(), { verbose: true }))
    expect(s.text().split('\n')[0]).toMatch(/^Warning/)
    expect(s.text()).toContain('Private Folder')
    expect(s.text()).toContain(UUID)
  })

  it('doctor flags stale FDA entry when state shows earlier success', async () => {
    const s = sink()
    const stateDir = mkdtempSync(join(tmpdir(), 'amm-st-'))
    writeFileSync(join(stateDir, 'state.json'), JSON.stringify({ lastAccessOk: '2026-10-20T10:00:00+02:00', helperSha256: null, helperVersion: null }))
    const code = await runDoctor(doctorDeps(s, goodRunner({ probe: () => probe('denied') }), { stateDir }))
    expect(code).toBe(1)
    expect(s.text()).toContain('Access worked on 2026-10-20')
    expect(s.text()).toContain('remove the entry and add it again')
  })

  it('doctor --json is valid JSON with ok/warn/fail per check', async () => {
    const s = sink()
    await runDoctor(doctorDeps(s, goodRunner(), { json: true }))
    const o = JSON.parse(s.text()) as { checks: Array<{ id: string; status: string; message: string }> }
    expect(o.checks.length).toBeGreaterThan(8)
    for (const c of o.checks) {
      expect(['ok', 'warn', 'fail']).toContain(c.status)
      expect(typeof c.id).toBe('string')
      expect(c.message.length).toBeGreaterThan(0)
    }
    for (const seed of SEED) expect(s.text()).not.toContain(seed)
  })

  it('doctor warns when no junk or trash mailbox was recognised', async () => {
    const s = sink()
    const m = mailboxes()
    m.mailboxes = m.mailboxes.filter((x) => x.id < 3)
    await runDoctor(doctorDeps(s, goodRunner({ 'list-mailboxes': () => m }), { json: true }))
    const o = JSON.parse(s.text()) as { checks: Array<{ id: string; status: string }> }
    expect(o.checks.find((c) => c.id === 'mailbox-roles')?.status).toBe('warn')
  })

  it('doctor exit code is 1 on any fail', async () => {
    const s = sink()
    const code = await runDoctor(doctorDeps(s, goodRunner({ probe: () => probe('no_mail_data') })))
    expect(code).toBe(1)
    const s2 = sink()
    // Release-Bundle ohne Stapling ist ein fail.
    expect(await runDoctor(doctorDeps(s2, goodRunner(), { exec: makeExec({ stapled: false }) }))).toBe(1)
    const s3 = sink()
    // Dev-Bundle ohne Stapling nur warn.
    expect(
      await runDoctor(doctorDeps(s3, goodRunner(), { exec: makeExec({ bundleId: 'io.github.redpop.apple-mail-mcp.mail-helper.dev', stapled: false }) })),
    ).toBe(0)
  })

  it('doctor --schema prints only CREATE statements', async () => {
    const s = sink()
    const runner = goodRunner({
      probe: () => probe('granted', { schema: { compatible: false, missing: ['messages.size'], fingerprint: 'sha256:abc123', ddl: 'CREATE TABLE x(a);\nsecret row\nCREATE INDEX i ON x(a);' } }),
    })
    const code = await runDoctor(doctorDeps(s, runner, { schema: true }))
    expect(code).toBe(0)
    const lines = s.text().split('\n').filter((l) => l !== '')
    for (const l of lines) expect(l.startsWith('CREATE ') || l.startsWith('sha256:') || l === 'messages.size').toBe(true)
    expect(s.text()).toContain('sha256:abc123')
    expect(s.text()).toContain('messages.size')
    expect(s.text()).not.toContain('secret row')
    expect(s.text()).not.toContain('alice')
  })
})
