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
