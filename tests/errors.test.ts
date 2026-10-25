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
    const m = fdaMessage('/x/Mail MCP Helper.app')
    expect(m).toContain('/x/Mail MCP Helper.app')
    expect(m).toContain('remove it with −')
    expect(m).toContain('npx -y @redpop/apple-mail-mcp setup')
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
    expect(f('/x/Mail MCP Helper.app')).toContain('paste `/x/Mail MCP Helper.app`')
  })
})
