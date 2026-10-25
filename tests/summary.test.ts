import { expect, test } from 'vitest'
import type { Config } from '../src/config.js'
import { computePolicy } from '../src/policy.js'
import { messageRow, type ListMailboxesResult, type MessageRow } from '../src/schemas.js'
import { toSummary } from '../src/summary.js'

const config: Config = {
  accounts: [], includeJunk: false, includeTrash: false, excludeMailboxes: [], showSecurityMails: false,
  bodySearch: true, maxResults: 50, maxBodyChars: 20000, helperPath: null, debug: false,
}
const A = 'AAAAAAAA-0000-0000-0000-000000000001'
const raw: ListMailboxesResult = {
  mailboxes: [{ id: 1, url: `imap://${A}/INBOX`, total: 1, unread: 0 }, { id: 2, url: `imap://${A}/Junk`, total: 1, unread: 0 }],
  accounts: [{ uuid: A, description: 'Work', username: 'me@work.example' }],
  accountNames: 'available',
}
const policy = computePolicy(config, raw)

const row = (over: Partial<MessageRow> = {}): MessageRow => ({
  gid: 42, messageIdHeader: '<abc@example.com>', subject: 'Hello', sender: { address: 'a@b.example', name: 'Ann' },
  recipients: [], recipientCount: 0, dateReceived: 1767225600, dateSent: null, mailboxIds: [1], read: false, flagged: true,
  attachmentNames: ['x.pdf'], conversationId: 7, file: 'full', ...over,
})
const rowNoHeader = row({ messageIdHeader: null, subject: '', sender: { address: '', name: null }, conversationId: null, file: 'none' })

test('summary of message without header, sender, subject', () => {
  expect(toSummary(rowNoHeader, policy, config)).toMatchObject({ link: null, from: null, subject: '', threadId: null, bodyLocal: 'none' })
})
test('Swift-shaped row with sender null parses and yields from null', () => {
  const swiftShaped = JSON.parse(JSON.stringify({ ...row(), sender: null }))
  const parsed = messageRow.parse(swiftShaped)
  expect(parsed.sender).toBeNull()
  expect(toSummary(parsed, policy, config).from).toBeNull()
})
test('basic field mapping', () => {
  expect(toSummary(row(), policy, config)).toEqual({
    id: '42', link: 'message://%3Cabc%40example.com%3E', subject: 'Hello', from: { address: 'a@b.example', name: 'Ann' },
    to: [], cc: [], recipientCount: 0, date: '2026-01-01T01:00:00+01:00',
    mailboxes: [{ id: '1', name: 'INBOX', account: 'Work' }], unread: true, flagged: true,
    attachmentNames: ['x.pdf'], attachmentCount: 1, threadId: '7', bodyLocal: 'full',
  })
})
test('summary redacts security subject unless configured', () => {
  const r = row({ subject: '123456 is your code' })
  expect(toSummary(r, policy, config)).toMatchObject({ subject: '•••• is your code', subjectRedacted: true })
  const shown = toSummary(r, policy, { ...config, showSecurityMails: true })
  expect(shown.subject).toBe('123456 is your code')
  expect('subjectRedacted' in shown).toBe(false)
  expect('subjectRedacted' in toSummary(row(), policy, config)).toBe(false)
})
test('summary maps mailboxes to allowed refs only and splits to/cc', () => {
  const p = (type: 'to' | 'cc' | 'bcc', n: number) => ({ type, address: `${type}${n}@x.example`, name: null })
  const r = row({
    mailboxIds: [1, 2, 99],
    recipients: [p('to', 1), p('cc', 1), p('bcc', 1), p('to', 2), p('to', 3)],
    recipientCount: 5, attachmentCount: 3,
  })
  const s = toSummary(r, policy, config, 2)
  expect(s.mailboxes).toEqual([{ id: '1', name: 'INBOX', account: 'Work' }])
  expect(s.to.map((a) => a.address)).toEqual(['to1@x.example', 'to2@x.example'])
  expect(s.cc.map((a) => a.address)).toEqual(['cc1@x.example'])
  expect(s.recipientCount).toBe(5)
  expect(s.attachmentCount).toBe(3)
})
