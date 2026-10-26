import { describe, expect, it } from 'vitest'
import { describeError, fdaMessage, HelperError } from '../src/errors.js'

const CODES = ['FULL_DISK_ACCESS_REQUIRED', 'MAIL_DATA_NOT_FOUND', 'SCHEMA_UNSUPPORTED', 'DATABASE_BUSY', 'DATABASE_ERROR', 'MESSAGE_NOT_FOUND', 'MAILBOX_NOT_FOUND', 'INVALID_CURSOR', 'INVALID_INPUT', 'CONFIG_INVALID', 'HELPER_MISSING', 'HELPER_CRASHED', 'HELPER_TIMEOUT', 'HELPER_VERSION_MISMATCH', 'HELPER_SIGNATURE_INVALID', 'HELPER_UNTRUSTED_SIGNATURE']

describe('errors', () => {
  it('every spec error code has its own message', () => {
    for (const c of CODES) expect(describeError(c)).not.toBe(describeError('NOPE'))
    expect(new Set(CODES.map((c) => describeError(c))).size).toBe(CODES.length)
  })

  it('unknown codes fall back to a generic sentence, details are appended', () => {
    expect(describeError('NOPE')).toMatch(/unexpected/i)
    expect(describeError('DATABASE_BUSY', 'x')).toContain('(Details: x)')
  })

  it('fda message names the bundle path and the stale-entry fix', () => {
    const m = fdaMessage('/x/Mail MCP Helper.app', true)
    expect(m).toContain('/x/Mail MCP Helper.app')
    expect(m).toContain('remove it with −')
    expect(m).toContain('npx -y @redpop/apple-mail-mcp setup')
  })

  it('fda message only claims a Finder window was opened when it was', () => {
    const now = fdaMessage('/x/Mail MCP Helper.app', true)
    const earlier = fdaMessage('/x/Mail MCP Helper.app', false)
    expect(now).toContain('A Finder window showing it has been opened.')
    expect(earlier).not.toContain('has been opened')
    expect(earlier).toContain('/x/Mail MCP Helper.app')
    expect(earlier).toContain('remove it with −')
    expect(describeError('FULL_DISK_ACCESS_REQUIRED')).not.toContain('has been opened')
  })

  it('fda message uses the given bundle name everywhere', () => {
    const m = fdaMessage('/x/Mail MCP Helper (Dev).app', true, 'Mail MCP Helper (Dev)')
    expect(m).toContain('app "Mail MCP Helper (Dev)", not')
    expect(m).toContain('drag "Mail MCP Helper (Dev)" from that Finder window')
    expect(m).toContain('If "Mail MCP Helper (Dev)" is already listed')
    expect(m.replaceAll('Mail MCP Helper (Dev)', '')).not.toContain('Mail MCP Helper')
  })

  it('HelperError carries its code', () => {
    const e = new HelperError('X', 'm')
    expect(e.code).toBe('X')
    expect(e.message).toBe('m')
  })
})

describe('generic FDA text', () => {
  it('has no concrete path but the same stale-entry fix', async () => {
    const { describeError: d, fdaMessage: f } = await import('../src/errors.js')
    const g = d('FULL_DISK_ACCESS_REQUIRED')
    expect(g).not.toContain('Cmd-Shift-G')
    expect(g).not.toContain('`/')
    expect(g).toContain('click + and add the "Mail MCP Helper" app')
    expect(g).toContain('remove it with −')
    expect(f('/x/Mail MCP Helper.app', false)).toContain('paste `/x/Mail MCP Helper.app`')
  })
})
