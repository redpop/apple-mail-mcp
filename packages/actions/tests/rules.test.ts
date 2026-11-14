import { computePolicy, type Policy } from '@redpop/apple-mail-mcp/dist/policy.js'
import type { ListMailboxesResult } from '@redpop/apple-mail-mcp/dist/schemas.js'
import { describe, expect, test } from 'vitest'
import { loadActionsConfig } from '../src/config.js'
import { checkMove, checkSave, type MoveStatus, type SaveStatus } from '../src/rules.js'
import { ARCHIVE, DRAFTS, HOME, HOME_INBOX, INBOX, JUNK, message, NESTED, PRIVATE, rawMailboxes, SENT, TRASH, WORK, type LocatedMessage } from './fakes/fakeActions.js'

function policyFor(raw: ListMailboxesResult, env: NodeJS.ProcessEnv = {}): Policy {
  const r = loadActionsConfig({ APPLE_MAIL_ACCOUNTS: raw.accounts.map((a) => a.uuid).join(','), HOME: '/Users/test', ...env })
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

describe('folder names differing only in case', () => {
  const twin = (url: string) => withAccount((r) => r.mailboxes.push({ id: 61, url, total: 1, unread: 0 }))

  test('a visible target twin is refused', () => {
    expect(status(check({ raw: twin(`imap://${WORK}/archive`) }))).toBe('skipped_unsupported_folder')
  })
  test('a target twin missing from the policy still counts', () => {
    const raw = twin(`imap://${WORK}/archive`)
    const policy = policyFor(raw)
    policy.mailboxes.delete(61)
    const r = checkMove({ move: { id: '42', targetMailboxId: String(ARCHIVE) }, located: message(42), policy, raw, excludeTargets: [] })
    expect(r).toEqual({ ok: false, status: 'skipped_unsupported_folder' })
  })
  test('a source twin is refused', () => {
    const raw = twin(`imap://${WORK}/projects/alpha`)
    expect(status(check({ raw, located: message(42, [{ rowid: 1, mailboxId: NESTED }]) }))).toBe('skipped_unsupported_folder')
  })
  test('the same path in another account is no twin', () => {
    const raw = twin(`imap://${HOME}/Archive`)
    expect(status(check({ raw }))).toBe('ok')
  })
  test('a different path that only shares the folder name is no twin', () => {
    const raw = twin(`imap://${WORK}/Projects/Archive`)
    expect(status(check({ raw }))).toBe('ok')
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

describe('checkSave', () => {
  const TYPES = ['pdf', 'png']
  const withAtt = (attachments: { partId: string; name: string }[] | undefined, over: Partial<LocatedMessage> = {}, mailboxId = INBOX): LocatedMessage =>
    message(42, [{ rowid: 7, mailboxId, ...(attachments !== undefined ? { attachments } : {}) } as LocatedMessage['copies'][number]], over)
  const inv = [{ partId: '1.2', name: 'invoice.pdf' }]

  function save(o: { located?: LocatedMessage | null; raw?: ListMailboxesResult; attachment?: number; source?: number | string; types?: string[]; env?: NodeJS.ProcessEnv }) {
    const raw = o.raw ?? rawMailboxes()
    return checkSave({
      request: { id: '42', attachment: o.attachment ?? 0, ...(o.source !== undefined ? { sourceMailboxId: String(o.source) } : {}) },
      located: o.located === null ? undefined : (o.located ?? withAtt(inv)),
      policy: policyFor(raw, o.env),
      raw,
      attachmentTypes: o.types ?? TYPES,
    })
  }
  const st = (r: ReturnType<typeof save>): SaveStatus | 'ok' => (r.ok ? 'ok' : r.status)

  test('returns exactly what the bundle needs', () => {
    expect(save({})).toEqual({ ok: true, account: 'Work', source: 'INBOX', rowid: 7, messageId: '<42@example.com>', partId: '1.2', fileName: 'invoice.pdf' })
  })
  test('source is the folder path of a nested mailbox', () => {
    const r = save({ located: withAtt(inv, {}, NESTED) })
    expect(r.ok && r.source).toBe('Projects/Alpha')
  })
  test('the attachment index picks within the chosen copy', () => {
    const r = save({ located: withAtt([{ partId: '1', name: 'a.pdf' }, { partId: '2', name: 'b.png' }]), attachment: 1 })
    expect(r.ok && r.partId).toBe('2')
    expect(r.ok && r.fileName).toBe('b.png')
  })

  test('two visible copies without source are ambiguous, a source picks one', () => {
    const two = message(42, [
      { rowid: 1, mailboxId: INBOX, attachments: inv } as LocatedMessage['copies'][number],
      { rowid: 2, mailboxId: NESTED, attachments: inv } as LocatedMessage['copies'][number],
    ])
    expect(st(save({ located: two }))).toBe('skipped_ambiguous')
    const r = save({ located: two, source: NESTED })
    expect(r.ok && r.rowid).toBe(2)
  })
  test('source not visible', () => {
    expect(st(save({ source: JUNK }))).toBe('skipped_source_not_visible')
    expect(st(save({ source: 'x' }))).toBe('skipped_source_not_visible')
    expect(st(save({ located: null }))).toBe('skipped_source_not_visible')
    expect(st(save({ located: withAtt(inv, {}, TRASH) }))).toBe('skipped_source_not_visible')
  })

  test('a Gmail account may save, but checkMove still refuses it', () => {
    const raw = withAccount((r) => {
      r.accounts[0]!.username = 'user@gmail.com'
    })
    expect(st(save({ raw }))).toBe('ok')
    expect(status(check({ raw }))).toBe('skipped_unsupported_account')
  })
  test('a non-IMAP account may save', () => {
    const raw = withAccount((r) => {
      r.mailboxes = [{ id: 1, url: 'ews://E1/Inbox', total: 1, unread: 0 }]
      r.accounts = [{ uuid: 'E1', description: 'Corp', username: 'user@example.com' }]
    })
    expect(st(save({ raw, located: withAtt(inv) }))).toBe('ok')
  })
  test('a duplicate account name is refused', () => {
    const raw = withAccount((r) => {
      r.accounts[1]!.description = 'WORK'
    })
    expect(st(save({ raw }))).toBe('skipped_unsupported_account')
  })
  test('a missing account name is refused', () => {
    const raw = withAccount((r) => {
      r.accountNames = 'unavailable'
    })
    expect(st(save({ raw }))).toBe('skipped_unsupported_account')
  })
  test('a folder path that cannot be addressed is refused', () => {
    const raw = withAccount((r) => r.mailboxes.push({ id: 60, url: `imap://${WORK}/A%0AB`, total: 1, unread: 0 }))
    expect(st(save({ raw, located: withAtt(inv, {}, 60) }))).toBe('skipped_unsupported_folder')
  })
  test('a case twin of the source folder is refused', () => {
    const raw = withAccount((r) => r.mailboxes.push({ id: 61, url: `imap://${WORK}/inbox`, total: 1, unread: 0 }))
    expect(st(save({ raw }))).toBe('skipped_unsupported_folder')
  })

  test('security mails are never saved, even with showSecurityMails', () => {
    const located = withAtt(inv, { subject: 'Your verification code' })
    expect(st(save({ located }))).toBe('skipped_security_mail')
    expect(st(save({ located, env: { APPLE_MAIL_SHOW_SECURITY_MAILS: 'true' } }))).toBe('skipped_security_mail')
  })
  test('a header with a control character is refused', () => {
    expect(st(save({ located: withAtt(inv, { messageIdHeader: '<a\r\nb@example.com>' }) }))).toBe('skipped_no_message_id')
    expect(st(save({ located: withAtt(inv, { messageIdHeader: null }) }))).toBe('skipped_no_message_id')
  })

  test.each([-1, 1, 99, 0.5, Number.NaN])('attachment index %s is not found', (attachment) => {
    expect(st(save({ attachment }))).toBe('skipped_attachment_not_found')
  })
  test('a copy without an attachment list has no attachment', () => {
    expect(st(save({ located: withAtt(undefined) }))).toBe('skipped_attachment_not_found')
  })
  test.each(['', '1.', '.1', '1..2', 'a', '1.x', ' 1'])('part id %j is not found', (partId) => {
    expect(st(save({ located: withAtt([{ partId, name: 'a.pdf' }]) }))).toBe('skipped_attachment_not_found')
  })

  test('executable type is refused, also behind a double extension', () => {
    expect(st(save({ located: withAtt([{ partId: '1', name: 'invoice.pdf.app' }]), types: ['pdf', 'app'] }))).toBe('skipped_type_not_allowed')
  })
  test('type outside the allowed list and names without an extension are refused', () => {
    expect(st(save({ located: withAtt([{ partId: '1', name: 'a.zip' }]) }))).toBe('skipped_type_not_allowed')
    expect(st(save({ located: withAtt([{ partId: '1', name: 'noext' }]) }))).toBe('skipped_type_not_allowed')
  })
  test('type is matched ignoring case', () => {
    expect(st(save({ located: withAtt([{ partId: '1', name: 'SCAN.PDF' }]) }))).toBe('ok')
  })
  test('the name is made safe', () => {
    const r = save({ located: withAtt([{ partId: '1', name: '../a:b.pdf' }]) })
    expect(r.ok && r.fileName).toBe('_a_b.pdf')
  })
  test('an empty name falls back to attachment-<id>-<partId>', () => {
    // Der Ersatzname hat keine Endung, die Typpruefung greift also normal: nur ueber die Variable moeglich.
    expect(st(save({ located: withAtt([{ partId: '1', name: '' }]) }))).toBe('skipped_type_not_allowed')
    const r = save({ located: withAtt([{ partId: '1.2', name: '' }]), types: ['2'] })
    expect(r.ok && r.fileName).toBe('attachment-42-1.2')
  })

  test('a refused save carries only the status', () => {
    expect(save({ located: withAtt(inv, { subject: 'Your verification code', fromAddress: 'secret@example.net' }) })).toEqual({ ok: false, status: 'skipped_security_mail' })
  })
})
