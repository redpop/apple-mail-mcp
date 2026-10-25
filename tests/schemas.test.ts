import { describe, expect, it } from 'vitest'
import { getMessagesResult, helloResult, listMailboxesResult, messageRow, probeResult, searchResult, threadResult } from '../src/schemas.js'

const row = {
  gid: 120001, messageIdHeader: '<abc@example.com>', subject: 'Re: Angebot',
  sender: { address: 'anna@example.com', name: 'Anna Beispiel' },
  recipients: [{ type: 'to', address: 'ich@example.org', name: null }], recipientCount: 3,
  dateReceived: 1768000000, dateSent: 1767999000, mailboxIds: [12], read: false, flagged: false,
  attachmentNames: ['angebot.pdf'], conversationId: 88123, file: 'full',
}

describe('schemas', () => {
  it('message row from spec 7.3', () => {
    expect(messageRow.parse(row).gid).toBe(120001)
    expect(() => messageRow.parse({ ...row, file: 'weird' })).toThrow()
    expect(() => messageRow.parse({ ...row, gid: '1' })).toThrow()
  })
  it('search result', () => {
    expect(searchResult.parse({ messages: [row], hasMore: true, totalMatched: 42, totalMatchedCapped: false }).hasMore).toBe(true)
  })
  it('get-messages result', () => {
    const r = getMessagesResult.parse({ messages: [{ ...row, raw: 'AAAA', rawSize: 3, rawTruncated: false }, { ...row, file: 'none', raw: null, rawSize: 0, rawTruncated: false }], missing: [2], budgetExhausted: false })
    expect(r.messages[1]!.raw).toBeNull()
  })
  it('thread result', () => {
    expect(threadResult.parse({ conversationId: 88123, messages: [row], hasMore: false }).messages).toHaveLength(1)
  })
  it('list-mailboxes with accounts block', () => {
    const r = listMailboxesResult.parse({
      mailboxes: [{ id: 12, url: 'imap://x/INBOX', total: 290, unread: 3 }],
      accounts: [{ uuid: 'u', description: 'd', username: null }], accountNames: 'available',
    })
    expect(r.accounts[0]!.username).toBeNull()
    expect(() => listMailboxesResult.parse({ mailboxes: [], accounts: [], accountNames: 'maybe' })).toThrow()
  })
  it('probe granted and denied', () => {
    expect(probeResult.parse({
      osVersion: '27.0.1', mailDir: 'V10', access: 'granted',
      schema: { compatible: true, missing: [], fingerprint: 'sha256:x' },
      counts: { mailboxes: 1, messages: 2, uniqueMessages: 1 },
      accountNames: { status: 'available', unmatchedAccounts: 0 },
    }).access).toBe('granted')
    expect(probeResult.parse({ osVersion: '27', mailDir: null, access: 'denied', accountNames: { status: 'unavailable', unmatchedAccounts: 0 } }).access).toBe('denied')
  })
  it('hello', () => {
    expect(helloResult.parse({ protocolVersion: 1, helperVersion: '0.1.0' }).protocolVersion).toBe(1)
  })
})
