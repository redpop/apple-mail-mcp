import { Writable } from 'node:stream'
import { HelperError } from '@redpop/apple-mail-mcp/dist/errors.js'
import { describe, expect, test } from 'vitest'
import { loadConfig } from '@redpop/apple-mail-mcp/dist/config.js'
import { runCli } from '../src/cli/main.js'
import { runActionsDoctor, type ActionsDoctorDeps } from '../src/cli/doctor.js'
import { runActionsSetup } from '../src/cli/setup.js'
import { loadActionsConfig } from '../src/config.js'
import { DEV_BUNDLE_ID } from '../src/bundle.js'
import { FakeMail, HOME, WORK } from './fakes/fakeActions.js'

function sink() {
  let text = ''
  const out = new Writable({ write(chunk, _enc, cb) { text += String(chunk); cb() } })
  return { out, text: () => text }
}

function fakeActions(handlers: Record<string, () => unknown>) {
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

describe('actions setup', () => {
  test('setupRunsFullDiskAccessStepFirst', async () => {
    const s = sink()
    const order: string[] = []
    const actions = { run: async (c: string) => (order.push(c), { status: 'granted' }) }
    const code = await runActionsSetup({ readSetup: async () => (order.push('read-setup'), 0), actions, out: s.out, accounts: 0 })
    expect(code).toBe(0)
    expect(order).toEqual(['read-setup', 'request-permission'])
    expect(s.text()).toContain('Mail MCP Actions can control Mail')
    expect(s.text()).toContain('Set APPLE_MAIL_ACCOUNTS')
  })

  test('setupWithAccountsDoesNotAskForAccounts', async () => {
    const s = sink()
    const actions = fakeActions({ 'request-permission': () => ({ status: 'granted' }) })
    const code = await runActionsSetup({ readSetup: async () => 0, actions, out: s.out, accounts: 1 })
    expect(code).toBe(0)
    expect(s.text()).not.toContain('Set APPLE_MAIL_ACCOUNTS')
    expect(s.text()).toContain('APPLE_MAIL_ACCOUNTS names 1 entry')
  })

  test('setupRequestsAutomationOnlyAfterFda', async () => {
    const s = sink()
    const actions = fakeActions({ 'request-permission': () => ({ status: 'granted' }) })
    const code = await runActionsSetup({ readSetup: async () => 1, actions, out: s.out, accounts: 1 })
    expect(code).toBe(1)
    expect(actions.calls).toEqual([])
    expect(s.text()).toContain('Automation step was skipped')
  })

  test('setupExplainsMailMustRun', async () => {
    for (const variant of ['status', 'error'] as const) {
      const s = sink()
      const actions = {
        run: async () => {
          if (variant === 'error') throw new HelperError('MAIL_NOT_RUNNING', 'x')
          return { status: 'mail_not_running' }
        },
      }
      expect(await runActionsSetup({ readSetup: async () => 0, actions, out: s.out, accounts: 1 })).toBe(1)
      expect(s.text()).toContain('Open Mail, then run setup again.')
    }
  })

  test('setup tells the user where to switch on a denied permission', async () => {
    const s = sink()
    const actions = fakeActions({ 'request-permission': () => ({ status: 'denied' }) })
    expect(await runActionsSetup({ readSetup: async () => 0, actions, out: s.out, accounts: 1 })).toBe(1)
    expect(s.text()).toContain('Privacy & Security > Automation')
  })
})

const probeOk = (schema: Record<string, unknown> = {}) => ({
  osVersion: '27.0.1',
  mailDir: 'V10',
  access: 'granted',
  schema: { compatible: true, missing: [], fingerprint: 'sha256:abc123', ...schema },
  counts: { mailboxes: 4, messages: 100, uniqueMessages: 80 },
  accountNames: { status: 'available', unmatchedAccounts: 0 },
})

const exec = (id = DEV_BUNDLE_ID) => (file: string) => {
  if (file === '/usr/bin/plutil') return { stdout: id + '\n', stderr: '', status: 0 }
  return { stdout: '', stderr: '', status: 0 }
}

function doctorDeps(mail: FakeMail, s: ReturnType<typeof sink>, probe: unknown = probeOk(), env: NodeJS.ProcessEnv = { APPLE_MAIL_ACCOUNTS: `${WORK},${HOME}` }, over: Partial<ActionsDoctorDeps> = {}): ActionsDoctorDeps {
  const base = loadConfig(env)
  return {
    readDoctor: async () => 0,
    helper: {
      run: async (c, p) => (c === 'probe' ? probe : mail.helper.run(c, p)),
    },
    actions: mail.actions,
    configResult: loadActionsConfig(env),
    baseConfig: base.ok ? base.config : null,
    bundlePath: '/opt/x/bin/Mail MCP Actions (Dev).app',
    override: true,
    exec: exec(),
    exists: () => true,
    out: s.out,
    verbose: false,
    ...over,
  }
}

describe('actions doctor', () => {
  test('doctorReportsPermissionMailHeaderAndAccounts', async () => {
    const s = sink()
    const mail = new FakeMail()
    const code = await runActionsDoctor(doctorDeps(mail, s))
    expect(code).toBe(0)
    expect(s.text()).toContain('[ok] actions-bundle:')
    expect(s.text()).toContain('[ok] automation: Mail MCP Actions may control Mail.')
    expect(s.text()).toContain('[ok] accounts-config:')
    expect(s.text()).toContain('column exists')
    expect(s.text()).toContain('Account 1: supported.')
    expect(s.text()).toContain('Account 2: supported.')
    expect(mail.actionCalls.map((c) => c.command)).toEqual(['permission'])
  })

  test('doctorWarnsWhenHeaderColumnMissing', async () => {
    for (const schema of [{ missing: ['message_global_data.message_id_header'] }, { ddl: ['CREATE TABLE message_global_data (ROWID INTEGER)'] }]) {
      const s = sink()
      await runActionsDoctor(doctorDeps(new FakeMail(), s, probeOk(schema)))
      expect(s.text()).toContain('[warn] message-id-header:')
      expect(s.text()).toContain('the tool cannot move mail on this Mac')
    }
  })

  test('doctorIgnoresTablesWhoseNameOnlyStartsWithMessageGlobalData', async () => {
    const s = sink()
    await runActionsDoctor(doctorDeps(new FakeMail(), s, probeOk({ ddl: ['CREATE TABLE message_global_data_old (ROWID INTEGER)'] })))
    expect(s.text()).not.toContain('the tool cannot move mail on this Mac')
  })

  test('doctorListsUnsupportedAccountsByReason', async () => {
    const s = sink()
    const mail = new FakeMail()
    mail.raw.accounts[0]!.username = 'user@gmail.com'
    mail.raw.mailboxes = mail.raw.mailboxes.map((m) => (m.url.includes(HOME) ? { ...m, url: m.url.replace('imap://', 'ews://') } : m))
    expect(await runActionsDoctor(doctorDeps(mail, s))).toBe(0)
    const text = s.text()
    expect(text).toContain('unsupported, Gmail accounts are not supported')
    expect(text).toContain('unsupported, not an IMAP account')
  })

  test('doctorPrintsNoSubjects', async () => {
    const s = sink()
    const mail = new FakeMail()
    mail.raw.accounts[0]!.description = 'Secret Work Name'
    await runActionsDoctor(doctorDeps(mail, s))
    expect(s.text()).not.toContain('Secret Work Name')
    expect(s.text()).not.toContain(WORK)
    expect(s.text()).not.toContain('Invoice')
    expect(s.text()).not.toContain('example.net')
    const v = sink()
    await runActionsDoctor(doctorDeps(mail, v, probeOk(), undefined, { verbose: true }))
    expect(v.text()).toContain('Secret Work Name')
  })

  test('doctor warns without APPLE_MAIL_ACCOUNTS and still reports', async () => {
    const s = sink()
    const code = await runActionsDoctor(doctorDeps(new FakeMail(), s, probeOk(), {}))
    expect(code).toBe(0)
    expect(s.text()).toContain('[warn] accounts-config: APPLE_MAIL_ACCOUNTS is not set')
    expect(s.text()).toContain('[ok] automation:')
  })

  test('doctor fails on denied permission and on a failing read doctor', async () => {
    const s = sink()
    const mail = new FakeMail()
    mail.permission = { status: 'denied' }
    expect(await runActionsDoctor(doctorDeps(mail, s))).toBe(1)
    expect(s.text()).toContain('[fail] automation:')
    const t = sink()
    expect(await runActionsDoctor(doctorDeps(new FakeMail(), t, probeOk(), undefined, { readDoctor: async () => 1 }))).toBe(1)
  })

  test('doctor reports a missing bundle and skips the permission call', async () => {
    const s = sink()
    const mail = new FakeMail()
    expect(await runActionsDoctor(doctorDeps(mail, s, probeOk(), undefined, { exists: () => false }))).toBe(1)
    expect(s.text()).toContain('[fail] actions-bundle:')
    expect(mail.actionCalls).toEqual([])
  })
})

describe('runCli', () => {
  test('runs the read CLI with a shared helper and stops both runners', async () => {
    const s = sink()
    const stopped: string[] = []
    const mk = (name: string) => ({ bundlePath: '/x', run: async () => ({ status: 'granted' }), stop: () => void stopped.push(name) })
    const seen: string[] = []
    const code = await runCli('setup', [], {
      env: { APPLE_MAIL_ACCOUNTS: WORK },
      out: s.out,
      makeHelper: () => mk('helper'),
      makeActions: () => mk('actions'),
      onSignal: () => {},
      readCli: async (cmd, _args, deps) => {
        seen.push(cmd)
        expect(deps.setupAddHint).toBe(false)
        deps.makeRunner!({} as never).stop()
        return 0
      },
    })
    expect(code).toBe(0)
    expect(seen).toEqual(['setup'])
    expect(stopped.sort()).toEqual(['actions', 'helper'])
  })
})
