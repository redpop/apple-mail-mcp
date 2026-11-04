import { expect, test } from 'vitest'
import type { Config } from '../src/config.js'
import { computePolicy, indexFingerprintOf, reminderMailboxIds } from '../src/policy.js'
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
  accountStores: [],
  dueReminders: [],
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
test('subfolders of junk and trash follow the same setting', () => {
  const sub = raw({ mailboxes: [mb(1, `imap://${A}/INBOX`), mb(2, `imap://${A}/Junk/Newsletter`), mb(3, `imap://${A}/Trash/Crypto`)] })
  expect(computePolicy(base, sub).allowedMailboxIds).toEqual([1])
  expect(computePolicy(cfg({ includeJunk: true }), sub).allowedMailboxIds).toEqual([1, 2])
  expect(computePolicy(cfg({ includeTrash: true }), sub).allowedMailboxIds).toEqual([1, 3])
})
test('index fingerprint changed with the role rules, so an existing index drops junk and trash subfolders', () => {
  // Wert vor der Vererbung der Rollen an Unterordner. Bei neuen Sichtbarkeitsregeln MAILBOX_RULES erhoehen.
  expect(indexFingerprintOf(base)).not.toBe('ba94a6a1648edd42')
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

// AMM-21: Konten ohne Store-Verzeichnis sind aus Mail entfernt und immer ausgeblendet.
const R = 'DDDDDDDD-0000-0000-0000-000000000003'
const withRemoved = (over: Partial<ListMailboxesResult> = {}) =>
  raw({
    mailboxes: [...raw().mailboxes, mb(7, `imap://${R}/INBOX`), mb(8, `imap://${R}/Archiv`)],
    accountStores: [{ uuid: A, hasStore: true }, { uuid: B, hasStore: true }, { uuid: R, hasStore: false }],
    ...over,
  })

test('accounts without a store directory are hidden and counted', () => {
  const pol = computePolicy(base, withRemoved())
  expect(pol.allowedMailboxIds).toEqual([1, 4, 5, 6])
  expect(pol.accounts.map((a) => a.id)).toEqual([A, B])
  expect(pol.removedAccounts).toBe(1)
  expect(pol.removedMailboxes).toBe(2)
})
test('removed accounts stay hidden with junk, trash and an allowlist naming them', () => {
  const pol = computePolicy(cfg({ includeJunk: true, includeTrash: true, accounts: [R] }), withRemoved())
  expect(pol.allowedMailboxIds).toEqual([])
  // Ein entferntes Konto ist kein Mail-Konto mehr: der Eintrag passt auf nichts.
  expect(pol.unmatchedAllowlistEntries).toBe(1)
})
test('an account without an accountStores entry stays visible', () => {
  const pol = computePolicy(base, withRemoved({ accountStores: [{ uuid: R, hasStore: false }] }))
  expect(pol.allowedMailboxIds).toEqual([1, 4, 5, 6])
  expect(computePolicy(base, raw()).removedAccounts).toBe(0)
  expect(computePolicy(base, raw()).removedMailboxes).toBe(0)
})
test('a live account with a store keeps all its mailboxes', () => {
  const pol = computePolicy(base, withRemoved({ accountStores: [{ uuid: R, hasStore: true }] }))
  expect(pol.allowedMailboxIds).toEqual([1, 4, 5, 6, 7, 8])
  expect(pol.removedAccounts).toBe(0)
})

// AMM-22: Konten, fuer die Mail abgeschaltet ist, sind immer ausgeblendet; nur ein eindeutiges false zaehlt.
const D = 'EEEEEEEE-0000-0000-0000-000000000004'
const withDisabled = (mailEnabled: boolean | undefined, over: Partial<ListMailboxesResult> = {}) =>
  raw({
    mailboxes: [...raw().mailboxes, mb(9, `imap://${D}/INBOX`), mb(10, `imap://${D}/Notes`)],
    accounts: [...raw().accounts, { uuid: D, description: 'iCloud', username: 'me@icloud.example', ...(mailEnabled === undefined ? {} : { mailEnabled }) }],
    ...over,
  })

test('accounts with Mail switched off are hidden and counted', () => {
  const pol = computePolicy(base, withDisabled(false))
  expect(pol.allowedMailboxIds).toEqual([1, 4, 5, 6])
  expect(pol.accounts.map((a) => a.id)).toEqual([A, B])
  expect(pol.mailDisabledAccounts).toBe(1)
  expect(pol.mailDisabledMailboxes).toBe(2)
  expect(pol.removedAccounts).toBe(0)
})
test('accounts with Mail switched off stay hidden with an allowlist naming them', () => {
  for (const e of [D, 'me@icloud.example', 'iCloud']) {
    const pol = computePolicy(cfg({ includeJunk: true, includeTrash: true, accounts: [e] }), withDisabled(false))
    expect(pol.allowedMailboxIds).toEqual([])
    expect(pol.unmatchedAllowlistEntries).toBe(1)
  }
})
test('mailEnabled true or missing keeps the account visible', () => {
  for (const v of [true, undefined]) {
    const pol = computePolicy(base, withDisabled(v))
    expect(pol.allowedMailboxIds).toEqual([1, 4, 5, 6, 9, 10])
    expect(pol.mailDisabledAccounts).toBe(0)
    expect(pol.mailDisabledMailboxes).toBe(0)
  }
})
test('a removed account with Mail switched off counts as removed only', () => {
  const pol = computePolicy(base, withDisabled(false, { accountStores: [{ uuid: D, hasStore: false }] }))
  expect(pol.allowedMailboxIds).toEqual([1, 4, 5, 6])
  expect(pol.removedAccounts).toBe(1)
  expect(pol.removedMailboxes).toBe(2)
  expect(pol.mailDisabledAccounts).toBe(0)
})

test('an inbox counts due reminders stored in allowed mailboxes of its account, as in Mail', () => {
  const r = raw({
    dueReminders: [
      { gid: 100, mailbox: 4, read: false },
      { gid: 101, mailbox: 4, read: true },
      // Junk ist nicht erlaubt.
      { gid: 102, mailbox: 2, read: false },
      // Liegt schon im Eingang: nicht doppelt.
      { gid: 103, mailbox: 1, read: false },
      { gid: 103, mailbox: 4, read: false },
      // Konto B.
      { gid: 104, mailbox: 6, read: false },
      // Gelesen nur in Trash: zaehlt ungelesen, solange Trash nicht erlaubt ist.
      { gid: 105, mailbox: 4, read: false },
      { gid: 105, mailbox: 3, read: true },
    ],
  })
  const pol = computePolicy(base, r)
  expect(pol.mailboxes.get(1)).toMatchObject({ total: 13, unread: 3 })
  expect(pol.mailboxes.get(5)).toMatchObject({ total: 11, unread: 2 })
  expect(pol.mailboxes.get(4)).toMatchObject({ total: 10, unread: 1 })
  expect(computePolicy(cfg({ includeJunk: true, includeTrash: true }), r).mailboxes.get(1)).toMatchObject({ total: 14, unread: 3 })
  // Ohne erlaubten Ordner zaehlt nichts dazu.
  expect(computePolicy(cfg({ excludeMailboxes: ['Kunden/Privat'] }), r).mailboxes.get(1)).toMatchObject({ total: 10, unread: 1 })
})
test('reminderMailboxIds lists the allowed mailboxes of the accounts whose inbox is searched', () => {
  const pol = computePolicy(base, raw())
  expect(reminderMailboxIds(pol, [1])).toEqual([1, 4])
  expect(reminderMailboxIds(pol, [1, 5])).toEqual([1, 4, 5, 6])
  expect(reminderMailboxIds(pol, [4, 6])).toEqual([])
})
