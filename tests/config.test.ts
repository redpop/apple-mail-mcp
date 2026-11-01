import { expect, test } from 'vitest'
import { loadConfig } from '../src/config.js'

function cfg(env: Record<string, string>) {
  const r = loadConfig(env)
  if (!r.ok) throw new Error(`${r.key}: ${r.error}`)
  return r.config
}

test('defaults are fail-closed and documented', () => {
  expect(loadConfig({})).toEqual({
    ok: true,
    config: {
      accounts: [], includeJunk: false, includeTrash: false, excludeMailboxes: [],
      showSecurityMails: false, bodySearch: true, bodyIndex: false, maxResults: 50, maxBodyChars: 20000,
      helperPath: null, debug: false,
    },
  })
})
test.each(['true', '1', 'TRUE'])('boolean %s is true', (v) =>
  expect(cfg({ APPLE_MAIL_INCLUDE_JUNK: v }).includeJunk).toBe(true))
test.each(['false', '0', 'False'])('boolean %s is false', (v) =>
  expect(cfg({ APPLE_MAIL_BODY_SEARCH: v }).bodySearch).toBe(false))
test('mcpb empty string means unset', () => {
  expect(cfg({ APPLE_MAIL_MAX_RESULTS: '' }).maxResults).toBe(50)
  expect(cfg({ APPLE_MAIL_INCLUDE_TRASH: '' }).includeTrash).toBe(false)
  expect(cfg({ APPLE_MAIL_HELPER_PATH: '' }).helperPath).toBeNull()
})
test('invalid boolean is CONFIG_INVALID with key', () =>
  expect(loadConfig({ APPLE_MAIL_INCLUDE_TRASH: 'yes' })).toMatchObject({ ok: false, key: 'APPLE_MAIL_INCLUDE_TRASH' }))
test('out of range number is invalid', () => {
  expect(loadConfig({ APPLE_MAIL_MAX_RESULTS: '101' }).ok).toBe(false)
  expect(loadConfig({ APPLE_MAIL_MAX_RESULTS: '0' }).ok).toBe(false)
  expect(loadConfig({ APPLE_MAIL_MAX_BODY_CHARS: '999' }).ok).toBe(false)
  expect(loadConfig({ APPLE_MAIL_MAX_BODY_CHARS: '100001' }).ok).toBe(false)
})
test('non-integer number is invalid', () => {
  expect(loadConfig({ APPLE_MAIL_MAX_RESULTS: '1.5' })).toMatchObject({ ok: false, key: 'APPLE_MAIL_MAX_RESULTS' })
  expect(loadConfig({ APPLE_MAIL_MAX_RESULTS: 'abc' }).ok).toBe(false)
})
test('valid numbers at the bounds', () => {
  expect(cfg({ APPLE_MAIL_MAX_RESULTS: '100' }).maxResults).toBe(100)
  expect(cfg({ APPLE_MAIL_MAX_BODY_CHARS: '1000' }).maxBodyChars).toBe(1000)
})
test('list trims and drops empty entries', () =>
  expect(cfg({ APPLE_MAIL_ACCOUNTS: ' a@example.com, ,B ' }).accounts).toEqual(['a@example.com', 'B']))
test('exclude list and helper path and debug', () => {
  const c = cfg({ APPLE_MAIL_EXCLUDE_MAILBOXES: 'Foo, Bar/Baz', APPLE_MAIL_HELPER_PATH: '/x/helper', APPLE_MAIL_MCP_DEBUG: '1' })
  expect(c.excludeMailboxes).toEqual(['Foo', 'Bar/Baz'])
  expect(c.helperPath).toBe('/x/helper')
  expect(c.debug).toBe(true)
})

test.each(['APPLE_MAIL_ACCOUNTS', 'APPLE_MAIL_EXCLUDE_MAILBOXES'])('%s with only separators is invalid', (key) => {
  for (const v of [',', ' , ', ',,']) expect(loadConfig({ [key]: v })).toMatchObject({ ok: false, key })
})

// Claude Desktop laesst ${user_config.x} stehen, wenn das Feld keinen Wert und keinen Default hat
// (und bei Array-Werten). Ein Platzhalter ist nie ein Kontoname und nie "alle Konten".
test.each([
  ['APPLE_MAIL_ACCOUNTS', '${user_config.accounts}'],
  ['APPLE_MAIL_EXCLUDE_MAILBOXES', '${user_config.exclude_mailboxes}'],
  ['APPLE_MAIL_INCLUDE_JUNK', '${user_config.include_junk}'],
  ['APPLE_MAIL_MAX_RESULTS', '${user_config.max_results}'],
])('unreplaced MCPB placeholder in %s is CONFIG_INVALID', (key, value) => {
  const r = loadConfig({ [key]: value })
  expect(r).toMatchObject({ ok: false, key })
  if (!r.ok) expect(r.error).toContain('not replaced')
})
test('APPLE_MAIL_BODY_INDEX is a boolean, default false', () => {
  expect(cfg({}).bodyIndex).toBe(false)
  expect(cfg({ APPLE_MAIL_BODY_INDEX: 'true' }).bodyIndex).toBe(true)
  expect(loadConfig({ APPLE_MAIL_BODY_INDEX: 'yes' })).toMatchObject({ ok: false, key: 'APPLE_MAIL_BODY_INDEX' })
})
