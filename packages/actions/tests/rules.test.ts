import { computePolicy, type Policy } from '@redpop/apple-mail-mcp/dist/policy.js'
import type { ListMailboxesResult } from '@redpop/apple-mail-mcp/dist/schemas.js'
import { describe, expect, test } from 'vitest'
import { loadActionsConfig } from '../src/config.js'
import { checkMove, type MoveStatus } from '../src/rules.js'
import { ARCHIVE, DRAFTS, HOME_INBOX, INBOX, JUNK, message, NESTED, PRIVATE, rawMailboxes, SENT, TRASH, WORK, type LocatedMessage } from './fakes/fakeActions.js'

function policyFor(raw: ListMailboxesResult, env: NodeJS.ProcessEnv = {}): Policy {
  const r = loadActionsConfig({ APPLE_MAIL_ACCOUNTS: raw.accounts.map((a) => a.uuid).join(','), ...env })
  if (!r.ok) throw new Error(r.error)
  return computePolicy(r.config, raw)
}

function check(o: {
  target?: number | string
  source?: number | string
  located?: LocatedMessage | null
  raw?: ListMailboxesResult
  env?: NodeJS.ProcessEnv
  excludeTargets?: string[]
}) {
  const raw = o.raw ?? rawMailboxes()
  return checkMove({
    move: { id: '42', targetMailboxId: String(o.target ?? ARCHIVE), ...(o.source !== undefined ? { sourceMailboxId: String(o.source) } : {}) },
    located: o.located === null ? undefined : (o.located ?? message(42)),
    policy: policyFor(raw, o.env),
    raw,
    excludeTargets: o.excludeTargets ?? [],
  })
}

const status = (r: ReturnType<typeof check>): MoveStatus | 'ok' => (r.ok ? 'ok' : r.status)

const withAccount = (mutate: (raw: ListMailboxesResult) => void): ListMailboxesResult => {
  const raw = rawMailboxes()
  mutate(raw)
  return raw
}

describe('allowed move', () => {
  test('returns exactly what the bundle needs', () => {
    expect(check({ located: message(42, [{ rowid: 7, mailboxId: INBOX }]) })).toEqual({
      ok: true,
      rowid: 7,
      source: 'INBOX',
      target: 'Archive',
      account: 'Work',
      messageId: '<42@example.com>',
      sourceMailboxId: INBOX,
      targetMailboxId: ARCHIVE,
    })
  })

  test('mailbox path joins nested segments with a slash', () => {
    const r = check({ target: NESTED })
    expect(r.ok && r.target).toBe('Projects/Alpha')
  })

  test('an IMAP account with a non-Gmail address and no allmail folder is supported', () => {
    expect(status(check({}))).toBe('ok')
  })
})

describe('skipped_target_not_allowed', () => {
  test('junk visible by configuration', () => {
    expect(status(check({ target: JUNK, env: { APPLE_MAIL_INCLUDE_JUNK: 'true' } }))).toBe('skipped_target_not_allowed')
  })
  test('trash visible by configuration', () => {
    expect(status(check({ target: TRASH, env: { APPLE_MAIL_INCLUDE_TRASH: 'true' } }))).toBe('skipped_target_not_allowed')
  })
  test('drafts', () => {
    expect(status(check({ target: DRAFTS }))).toBe('skipped_target_not_allowed')
  })
  test('sent', () => {
    expect(status(check({ target: SENT }))).toBe('skipped_target_not_allowed')
  })
  test('allmail', () => {
    const raw = withAccount((r) => r.mailboxes.push({ id: 50, url: `imap://${WORK}/All%20Mail`, total: 1, unread: 0 }))
    expect(status(check({ target: 50, raw }))).toBe('skipped_target_not_allowed')
  })
  test('named in excludeTargets by name, ignoring case', () => {
    expect(status(check({ target: ARCHIVE, excludeTargets: ['archive'] }))).toBe('skipped_target_not_allowed')
  })
  test('named in excludeTargets by path', () => {
    expect(status(check({ target: NESTED, excludeTargets: ['Projects/Alpha'] }))).toBe('skipped_target_not_allowed')
  })
  test('junk target is not visible by default', () => {
    expect(status(check({ target: JUNK }))).toBe('skipped_target_not_allowed')
  })
  test('target hidden by APPLE_MAIL_EXCLUDE_MAILBOXES', () => {
    expect(status(check({ target: PRIVATE, env: { APPLE_MAIL_EXCLUDE_MAILBOXES: 'Private' } }))).toBe('skipped_target_not_allowed')
  })
  test('unknown target id', () => {
    expect(status(check({ target: 999 }))).toBe('skipped_target_not_allowed')
  })
  test('malformed target id', () => {
    expect(status(check({ target: 'x1' }))).toBe('skipped_target_not_allowed')
  })
})

describe('skipped_source_not_visible', () => {
  test('source mailbox is hidden', () => {
    expect(status(check({ source: JUNK, located: message(42, [{ rowid: 1, mailboxId: JUNK }]) }))).toBe('skipped_source_not_visible')
  })
  test('no message located', () => {
    expect(status(check({ located: null }))).toBe('skipped_source_not_visible')
  })
  test('no visible copy', () => {
    expect(status(check({ located: message(42, []) }))).toBe('skipped_source_not_visible')
  })
  test('a copy in a hidden mailbox does not count', () => {
    expect(status(check({ located: message(42, [{ rowid: 1, mailboxId: TRASH }]) }))).toBe('skipped_source_not_visible')
  })
  test('named source holds no copy', () => {
    expect(status(check({ source: NESTED }))).toBe('skipped_source_not_visible')
  })
  test('malformed source id is not treated as absent', () => {
    expect(status(check({ source: 'abc' }))).toBe('skipped_source_not_visible')
  })
})

describe('skipped_ambiguous', () => {
  const two = message(42, [{ rowid: 1, mailboxId: INBOX }, { rowid: 2, mailboxId: NESTED }])

  test('two visible copies without sourceMailboxId', () => {
    expect(status(check({ located: two }))).toBe('skipped_ambiguous')
  })
  test('sourceMailboxId picks the copy', () => {
    const r = check({ located: two, source: NESTED })
    expect(r.ok && r.rowid).toBe(2)
    expect(r.ok && r.source).toBe('Projects/Alpha')
  })
  test('two copies in the named source stay ambiguous', () => {
    const dup = message(42, [{ rowid: 1, mailboxId: INBOX }, { rowid: 2, mailboxId: INBOX }])
    expect(status(check({ located: dup, source: INBOX }))).toBe('skipped_ambiguous')
  })
  test('hidden copies do not make it ambiguous', () => {
    const r = check({ located: message(42, [{ rowid: 1, mailboxId: INBOX }, { rowid: 2, mailboxId: TRASH }]) })
    expect(r.ok && r.rowid).toBe(1)
  })
})

test('skipped_other_account: target in another account', () => {
  expect(status(check({ target: HOME_INBOX }))).toBe('skipped_other_account')
})

describe('skipped_unsupported_account', () => {
  test('exchange', () => {
    const raw = withAccount((r) => {
      r.mailboxes = [{ id: 1, url: 'ews://E1/Inbox', total: 1, unread: 0 }, { id: 2, url: 'ews://E1/Archive', total: 1, unread: 0 }]
      r.accounts = [{ uuid: 'E1', description: 'Corp', username: 'user@example.com' }]
    })
    expect(status(check({ raw }))).toBe('skipped_unsupported_account')
  })
  test('local', () => {
    const raw = withAccount((r) => {
      r.mailboxes = [{ id: 1, url: 'local://L1/Inbox', total: 1, unread: 0 }, { id: 2, url: 'local://L1/Archive', total: 1, unread: 0 }]
      r.accounts = [{ uuid: 'L1', description: 'On My Mac', username: null }]
    })
    expect(status(check({ raw }))).toBe('skipped_unsupported_account')
  })
  test('unknown scheme', () => {
    const raw = withAccount((r) => {
      r.mailboxes = [{ id: 1, url: 'pop://P1/Inbox', total: 1, unread: 0 }, { id: 2, url: 'pop://P1/Archive', total: 1, unread: 0 }]
      r.accounts = [{ uuid: 'P1', description: 'Old', username: null }]
    })
    expect(status(check({ raw }))).toBe('skipped_unsupported_account')
  })
  test('account has an allmail folder', () => {
    const raw = withAccount((r) => r.mailboxes.push({ id: 50, url: `imap://${WORK}/All%20Mail`, total: 1, unread: 0 }))
    expect(status(check({ raw }))).toBe('skipped_unsupported_account')
  })
  test('an allmail folder hidden by exclusion still counts', () => {
    const raw = withAccount((r) => r.mailboxes.push({ id: 50, url: `imap://${WORK}/All%20Mail`, total: 1, unread: 0 }))
    expect(status(check({ raw, env: { APPLE_MAIL_EXCLUDE_MAILBOXES: 'All Mail' } }))).toBe('skipped_unsupported_account')
  })
  test.each(['user@gmail.com', 'user@googlemail.com', 'USER@GMAIL.COM'])('username %s', (username) => {
    const raw = withAccount((r) => {
      r.accounts[0]!.username = username
    })
    expect(status(check({ raw }))).toBe('skipped_unsupported_account')
  })
  test('a domain that only starts with the Gmail name is not Gmail', () => {
    const raw = withAccount((r) => {
      r.accounts[0]!.username = 'user@gmail.com.example.org'
    })
    expect(status(check({ raw }))).toBe('ok')
  })
  test('account name missing', () => {
    const raw = withAccount((r) => {
      r.accounts[0]!.description = null
    })
    expect(status(check({ raw }))).toBe('skipped_unsupported_account')
  })
  test('account name blank', () => {
    const raw = withAccount((r) => {
      r.accounts[0]!.description = '  '
    })
    expect(status(check({ raw }))).toBe('skipped_unsupported_account')
  })
  test('account names unavailable', () => {
    const raw = withAccount((r) => {
      r.accountNames = 'unavailable'
    })
    expect(status(check({ raw }))).toBe('skipped_unsupported_account')
  })
  test('account absent from the account list', () => {
    const raw = withAccount((r) => {
      r.accounts = r.accounts.filter((a) => a.uuid !== WORK)
    })
    const policy = policyFor(rawMailboxes())
    const r = checkMove({ move: { id: '42', targetMailboxId: String(ARCHIVE) }, located: message(42), policy, raw, excludeTargets: [] })
    expect(r).toEqual({ ok: false, status: 'skipped_unsupported_account' })
  })
  test('account name duplicate', () => {
    const raw = withAccount((r) => {
      r.accounts[1]!.description = 'Work'
    })
    expect(status(check({ raw }))).toBe('skipped_unsupported_account')
  })
  test('account name duplicate differing in case only', () => {
    const raw = withAccount((r) => {
      r.accounts[1]!.description = 'WORK'
    })
    expect(status(check({ raw }))).toBe('skipped_unsupported_account')
  })
  test('a duplicate name on an account outside the allowlist still counts', () => {
    const raw = withAccount((r) => {
      r.accounts[1]!.description = 'Work'
    })
    expect(status(check({ raw, env: { APPLE_MAIL_ACCOUNTS: WORK } }))).toBe('skipped_unsupported_account')
  })
  test('account name with a control character', () => {
    const raw = withAccount((r) => {
      r.accounts[0]!.description = 'Wo\nrk'
    })
    expect(status(check({ raw }))).toBe('skipped_unsupported_account')
  })
})

describe('skipped_unsupported_folder', () => {
  test('target path cannot be addressed', () => {
    const raw = withAccount((r) => r.mailboxes.push({ id: 60, url: `imap://${WORK}/A%2FB`, total: 1, unread: 0 }))
    expect(status(check({ raw, target: 60 }))).toBe('skipped_unsupported_folder')
  })
  test('source path cannot be addressed', () => {
    const raw = withAccount((r) => r.mailboxes.push({ id: 60, url: `imap://${WORK}/A%0AB`, total: 1, unread: 0 }))
    expect(status(check({ raw, located: message(42, [{ rowid: 1, mailboxId: 60 }]) }))).toBe('skipped_unsupported_folder')
  })
})

describe('skipped_security_mail', () => {
  const secure = message(42, undefined, { subject: 'Your verification code' })
  test('subject classifies as security mail', () => {
    expect(status(check({ located: secure }))).toBe('skipped_security_mail')
  })
  test('even with showSecurityMails', () => {
    expect(status(check({ located: secure, env: { APPLE_MAIL_SHOW_SECURITY_MAILS: 'true' } }))).toBe('skipped_security_mail')
  })
})

describe('skipped_no_message_id', () => {
  test('null header', () => {
    expect(status(check({ located: message(42, undefined, { messageIdHeader: null }) }))).toBe('skipped_no_message_id')
  })
  test.each(['', '   ', '<>', '< >'])('empty header %j', (messageIdHeader) => {
    expect(status(check({ located: message(42, undefined, { messageIdHeader }) }))).toBe('skipped_no_message_id')
  })
  test('header with a control character, which the bundle refuses', () => {
    expect(status(check({ located: message(42, undefined, { messageIdHeader: '<a\r\nb@example.com>' }) }))).toBe('skipped_no_message_id')
  })
})

test('skipped_same_folder: source equals target', () => {
  expect(status(check({ target: INBOX }))).toBe('skipped_same_folder')
})

test('a result for a refused move carries only the status', () => {
  const r = check({ located: message(42, undefined, { subject: 'Your verification code', fromAddress: 'secret@example.net' }) })
  expect(r).toEqual({ ok: false, status: 'skipped_security_mail' })
})
