import { expect, test } from 'vitest'
import type { Config } from '../src/config.js'
import { computePolicy, indexFingerprintOf } from '../src/policy.js'
import type { ListMailboxesResult } from '../src/schemas.js'

const base: Config = {
  accounts: [], includeJunk: false, includeTrash: false, excludeMailboxes: [], showSecurityMails: false,
  bodySearch: true, bodyIndex: false, maxResults: 50, maxBodyChars: 20000, helperPath: null, debug: false,
}
const A = 'AAAAAAAA-0000-0000-0000-000000000001'
const B = 'BBBBBBBB-0000-0000-0000-000000000002'
const mb = (id: number, url: string) => ({ id, url, total: 10, unread: 1 })
const raw = (over: Partial<ListMailboxesResult> = {}): ListMailboxesResult => ({
  mailboxes: [
    mb(1, `imap://${A}/INBOX`), mb(2, `imap://${A}/Junk`), mb(3, `imap://${A}/Trash`),
    mb(4, `imap://${A}/Kunden/Privat`), mb(5, `imap://${B}/INBOX`), mb(6, `imap://${B}/Privat`),
  ],
  accounts: [
    { uuid: A, description: 'Work', username: 'me@work.example' },
    { uuid: B, description: 'Privat Konto', username: 'not-an-address' },
  ],
  accountNames: 'available',
  ...over,
})
const cfg = (o: Partial<Config>): Config => ({ ...base, ...o })

test('junk and trash excluded by default', () => {
  const pol = computePolicy(base, raw())
  expect(pol.allowedMailboxIds).toEqual([1, 4, 5, 6])
  expect([...pol.mailboxes.keys()]).toEqual([1, 4, 5, 6])
})
test('includeJunk and includeTrash add them back', () => {
  expect(computePolicy(cfg({ includeJunk: true }), raw()).allowedMailboxIds).toEqual([1, 2, 4, 5, 6])
  expect(computePolicy(cfg({ includeTrash: true }), raw()).allowedMailboxIds).toEqual([1, 3, 4, 5, 6])
})
test('allowlist matches uuid, address and description case-insensitively', () => {
  for (const e of [A.toLowerCase(), 'ME@WORK.EXAMPLE', 'work']) {
    const pol = computePolicy(cfg({ accounts: [e] }), raw())
    expect(pol.allowedMailboxIds).toEqual([1, 4])
    expect(pol.unmatchedAllowlistEntries).toBe(0)
    expect(pol.accounts.map((a) => a.id)).toEqual([A])
  }
})
test('allowlist entry matching nothing is counted and allows nothing', () => {
  const pol = computePolicy(cfg({ accounts: ['nobody'] }), raw())
  expect(pol.allowedMailboxIds).toEqual([])
  expect(pol.unmatchedAllowlistEntries).toBe(1)
})
test('allowlist entry by address with names unavailable matches nothing', () => {
  const pol = computePolicy(cfg({ accounts: ['me@work.example'] }), raw({ accountNames: 'unavailable', accountNamesReason: 'x' }))
  expect(pol.allowedMailboxIds).toEqual([])
  expect(pol.unmatchedAllowlistEntries).toBe(1)
  expect(pol.accountNamesAvailable).toBe(false)
})
test('uuid still matches with names unavailable', () => {
  const pol = computePolicy(cfg({ accounts: [A] }), raw({ accountNames: 'unavailable', accounts: [] }))
  expect(pol.allowedMailboxIds).toEqual([1, 4])
  expect(pol.unmatchedAllowlistEntries).toBe(0)
})
test('account views: address only if email-like, name falls back to uuid', () => {
  const pol = computePolicy(base, raw({ accounts: [{ uuid: A, description: null, username: 'me@work.example' }, { uuid: B, description: 'P', username: 'a@b@c' }] }))
  expect(pol.accounts).toEqual([
    { id: A, name: A, address: 'me@work.example', type: 'imap' },
    { id: B, name: 'P', address: null, type: 'imap' },
  ])
})
test('excludeMailboxes by name and by path', () => {
  expect(computePolicy(cfg({ excludeMailboxes: ['PRIVAT'] }), raw()).allowedMailboxIds).toEqual([1, 5])
  expect(computePolicy(cfg({ excludeMailboxes: ['kunden/privat'] }), raw()).allowedMailboxIds).toEqual([1, 5, 6])
})
test('fingerprint changes with config, ignores helperPath and debug', () => {
  const f = (c: Config) => computePolicy(c, raw()).fingerprint
  expect(f(base)).toMatch(/^[0-9a-f]{16}$/)
  expect(f(cfg({ includeJunk: true }))).not.toBe(f(base))
  expect(f(cfg({ excludeMailboxes: ['x'] }))).not.toBe(f(base))
  expect(f(cfg({ helperPath: '/a', debug: true }))).toBe(f(base))
  // Mit und ohne Index ist die Treffermenge dieselbe; Cursor bleiben gueltig.
  expect(f(cfg({ bodyIndex: true }))).toBe(f(base))
})
test('index fingerprint covers only what decides which mails may be indexed', () => {
  expect(indexFingerprintOf(base)).toMatch(/^[0-9a-f]{16}$/)
  expect(indexFingerprintOf(cfg({ accounts: ['x'] }))).not.toBe(indexFingerprintOf(base))
  expect(indexFingerprintOf(cfg({ includeJunk: true }))).not.toBe(indexFingerprintOf(base))
  expect(indexFingerprintOf(cfg({ includeTrash: true }))).not.toBe(indexFingerprintOf(base))
  expect(indexFingerprintOf(cfg({ excludeMailboxes: ['x'] }))).not.toBe(indexFingerprintOf(base))
  expect(indexFingerprintOf(cfg({ maxResults: 3, maxBodyChars: 5000, showSecurityMails: true, bodySearch: false, bodyIndex: true, helperPath: '/a', debug: true }))).toBe(indexFingerprintOf(base))
})

test('junk/trash mailbox with invalid url segment is excluded by default', () => {
  const r = raw({ mailboxes: [mb(1, `imap://${A}/INBOX`), mb(2, `imap://${A}/%ZZ/Junk`), mb(3, `imap://${A}/a//Trash`)] })
  expect(computePolicy(base, r).allowedMailboxIds).toEqual([1])
  expect(computePolicy(cfg({ includeJunk: true, includeTrash: true }), r).allowedMailboxIds).toEqual([1, 2, 3])
})
