import { readFileSync } from 'node:fs'
import { checkBundle, TEAM_ID, type ExecFn } from '@redpop/apple-mail-mcp/dist/signing.js'
import { PROTOCOL_VERSION, type StdioHelperRunner } from '@redpop/apple-mail-mcp/dist/stdioRunner.js'
import { describe, expect, test } from 'vitest'
import {
  ACTIONS_TIMEOUTS,
  actionsExecutable,
  ADHOC_BUNDLE_ID,
  checkActionsBundle,
  createActionsRunner,
  DEV_BUNDLE_ID,
  packagedActionsBundle,
  RELEASE_BUNDLE_ID,
  RELEASE_REQUIREMENT,
  resolveActionsBundle,
} from '../src/bundle.js'
import { loadActionsConfig, type ActionsConfig } from '../src/config.js'
import { ActionsError, describeActionsError } from '../src/errors.js'

const read = (rel: string): string => readFileSync(new URL(rel, import.meta.url), 'utf8')

const actionsBuild = read('../swift/build.sh')
const helperBuild = read('../../../swift/build.sh')

function fakeExec(o: { id: string; codesignFails?: boolean }): ExecFn & { calls: [string, string[]][] } {
  const calls: [string, string[]][] = []
  const f = ((file: string, args: string[]) => {
    calls.push([file, args])
    if (file === '/usr/bin/plutil') return o.id + '\n'
    if (file === '/usr/bin/codesign') {
      if (o.codesignFails) throw new Error('codesign failed')
      return ''
    }
    throw new Error('unexpected ' + file)
  }) as ExecFn & { calls: [string, string[]][] }
  f.calls = calls
  return f
}
const exists = () => true

function config(env: NodeJS.ProcessEnv = {}): ActionsConfig {
  const r = loadActionsConfig({ APPLE_MAIL_ACCOUNTS: 'Work', ...env })
  if (!r.ok) throw new Error(r.error)
  return r.config
}

const code = (fn: () => unknown): string | undefined => {
  try {
    fn()
    return undefined
  } catch (e) {
    expect(e).toBeInstanceOf(ActionsError)
    return (e as ActionsError).code
  }
}

describe('ids stay in step and apart', () => {
  test('bundle ids and team id match packages/actions/swift/build.sh', () => {
    expect(actionsBuild).toContain(`TEAM_ID="${TEAM_ID}"`)
    expect(actionsBuild).toContain(`RELEASE_BUNDLE_ID="${RELEASE_BUNDLE_ID}"`)
    expect(actionsBuild).toContain(`DEV_BUNDLE_ID="${DEV_BUNDLE_ID}"`)
    expect(actionsBuild).toContain(`ADHOC_BUNDLE_ID="${ADHOC_BUNDLE_ID}"`)
  })

  test('the read package knows nothing of mail-actions', () => {
    expect(helperBuild).not.toContain('mail-actions')
    expect(read('../../../src/signing.ts')).not.toContain('mail-actions')
  })

  test('the helper is signed without entitlements', () => {
    const lines = helperBuild.split('\n').filter((l) => l.includes('/usr/bin/codesign'))
    expect(lines.length).toBeGreaterThan(0)
    for (const line of lines) expect(line).not.toContain('--entitlements')
  })

  test('the actions bundle is signed with entitlements', () => {
    const lines = actionsBuild.split('\n').filter((l) => l.includes('/usr/bin/codesign'))
    expect(lines.length).toBeGreaterThan(0)
    for (const line of lines) expect(line).toContain('--entitlements')
  })

  test('protocolVersion in the actions bundle equals PROTOCOL_VERSION', () => {
    const swift = read('../swift/Sources/MailActionsCore/Protocol.swift')
    expect(swift).toContain(`public let protocolVersion = ${PROTOCOL_VERSION}\n`)
  })

  test('the release requirement names the actions id and the team', () => {
    expect(RELEASE_REQUIREMENT).toContain(`identifier "${RELEASE_BUNDLE_ID}"`)
    expect(RELEASE_REQUIREMENT).toContain(`certificate leaf[subject.OU] = "${TEAM_ID}"`)
    expect(RELEASE_REQUIREMENT).toContain('certificate 1[field.1.2.840.113635.100.6.2.6] exists')
  })

  test('the helper gate refuses every actions id', () => {
    for (const id of [RELEASE_BUNDLE_ID, DEV_BUNDLE_ID, ADHOC_BUNDLE_ID]) {
      expect(() => checkBundle('/b.app', { override: true, exec: fakeExec({ id }), exists })).toThrow()
    }
  })
})

describe('checkActionsBundle', () => {
  test('missing bundle', () => {
    expect(code(() => checkActionsBundle('/b.app', { override: false, exec: fakeExec({ id: RELEASE_BUNDLE_ID }), exists: () => false }))).toBe('ACTIONS_BUNDLE_MISSING')
  })

  test('release id passes with a valid signature and checks the requirement', () => {
    const exec = fakeExec({ id: RELEASE_BUNDLE_ID })
    checkActionsBundle('/b.app', { override: false, exec, exists })
    const sign = exec.calls.find(([f]) => f === '/usr/bin/codesign')
    expect(sign?.[1]).toEqual(['--verify', '--strict', '--deep', `-R=${RELEASE_REQUIREMENT}`, '/b.app'])
  })

  test('release id with a bad signature is refused', () => {
    expect(code(() => checkActionsBundle('/b.app', { override: false, exec: fakeExec({ id: RELEASE_BUNDLE_ID, codesignFails: true }), exists }))).toBe('ACTIONS_SIGNATURE_INVALID')
  })

  test('release id through an override is refused', () => {
    expect(code(() => checkActionsBundle('/b.app', { override: true, exec: fakeExec({ id: RELEASE_BUNDLE_ID }), exists }))).toBe('ACTIONS_SIGNATURE_INVALID')
  })

  test.each([DEV_BUNDLE_ID, ADHOC_BUNDLE_ID])('%s passes through an override only', (id) => {
    expect(code(() => checkActionsBundle('/b.app', { override: true, exec: fakeExec({ id }), exists }))).toBeUndefined()
    expect(code(() => checkActionsBundle('/b.app', { override: false, exec: fakeExec({ id }), exists }))).toBe('ACTIONS_SIGNATURE_INVALID')
  })

  test.each(['io.github.redpop.apple-mail-mcp.mail-helper', 'io.github.redpop.apple-mail-mcp.mail-helper.dev', 'com.example.other'])('foreign id %s is refused', (id) => {
    expect(code(() => checkActionsBundle('/b.app', { override: true, exec: fakeExec({ id }), exists }))).toBe('ACTIONS_SIGNATURE_INVALID')
  })

  test('an unreadable bundle id is refused', () => {
    const exec = (() => {
      throw new Error('no plist')
    }) as ExecFn
    expect(code(() => checkActionsBundle('/b.app', { override: true, exec, exists }))).toBe('ACTIONS_SIGNATURE_INVALID')
  })

  test.each(['ACTIONS_BUNDLE_MISSING', 'ACTIONS_SIGNATURE_INVALID'])('%s has its own sentence', (c) => {
    expect(describeActionsError(c)).not.toContain('unexpected error code')
  })
})

describe('resolving and running', () => {
  test('the packaged path sits in the bin directory of the actions package', () => {
    expect(packagedActionsBundle().endsWith('/packages/actions/bin/Mail MCP Actions.app')).toBe(true)
  })

  test('APPLE_MAIL_ACTIONS_PATH overrides the packaged path', () => {
    expect(resolveActionsBundle(config())).toBe(packagedActionsBundle())
    expect(resolveActionsBundle(config({ APPLE_MAIL_ACTIONS_PATH: '/dev/x.app' }))).toBe('/dev/x.app')
  })

  test('the executable is mail-actions inside the bundle', () => {
    expect(actionsExecutable('/b.app')).toBe('/b.app/Contents/MacOS/mail-actions')
  })

  test('timeouts exceed the 2-minute Apple Event timeout', () => {
    expect(ACTIONS_TIMEOUTS).toEqual({ firstRequestMs: 130_000, requestMs: 130_000 })
  })

  const inner = (): StdioHelperRunner & { seen: string[] } => {
    const seen: string[] = []
    return { seen, run: async (c) => (seen.push(c), { ok: true }), stop: () => {}, helperVersion: () => '0.0.0' }
  }

  test('the gate runs once and only an override is flagged', async () => {
    const r = inner()
    const seen: unknown[] = []
    const runner = createActionsRunner(config({ APPLE_MAIL_ACTIONS_PATH: '/dev/x.app' }), {
      check: (bundle, opts) => seen.push([bundle, opts]),
      makeRunner: (exe) => {
        expect(exe).toBe('/dev/x.app/Contents/MacOS/mail-actions')
        return r
      },
    })
    await runner.run('permission', {})
    await runner.run('permission', {})
    expect(seen).toEqual([['/dev/x.app', { override: true }]])
    expect(r.seen).toEqual(['permission', 'permission'])
    expect(runner.bundlePath).toBe('/dev/x.app')
  })

  test('a failed gate never starts the bundle and stays failed', async () => {
    const r = inner()
    let checks = 0
    const runner = createActionsRunner(config(), {
      check: () => {
        checks++
        throw new ActionsError('ACTIONS_SIGNATURE_INVALID')
      },
      makeRunner: () => r,
    })
    await expect(runner.run('permission', {})).rejects.toMatchObject({ code: 'ACTIONS_SIGNATURE_INVALID' })
    await expect(runner.run('permission', {})).rejects.toMatchObject({ code: 'ACTIONS_SIGNATURE_INVALID' })
    expect(checks).toBe(1)
    expect(r.seen).toEqual([])
  })
})
