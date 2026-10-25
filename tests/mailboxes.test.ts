import { expect, test } from 'vitest'
import { parseMailbox } from '../src/mailboxes.js'

const p = (url: string) => parseMailbox({ id: 1, url, total: 0, unread: 0 })

test.each([
  ['imap://U/INBOX', 'inbox'], ['imap://U/inbox', 'inbox'], ['imap://U/Junk', 'junk'], ['imap://U/Spam', 'junk'],
  ['imap://U/Papierkorb', 'trash'], ['imap://U/Deleted%20Messages', 'trash'],
  ['imap://U/Gesendete%20Objekte', 'sent'], ['imap://U/%5BGmail%5D/All%20Mail', 'allmail'],
  ['imap://U/%5BGoogle%20Mail%5D/Alle%20Nachrichten', 'allmail'], ['imap://U/Archiv/2024', 'other'],
  ['imap://U/Archive', 'archive'], ['imap://U/Courrier%20ind%C3%A9sirable', 'junk'],
  ['imap://U/Entw%C3%BCrfe', 'drafts'], ['imap://U/Borradores', 'drafts'],
  ['imap://U/Elementos%20enviados', 'sent'], ['imap://U/Posta%20inviata', 'sent'],
  ['imap://U/Verzonden%20items', 'sent'], ['imap://U/%5BGmail%5D/Trash', 'trash'],
  ['imap://U/%5BGoogle%20Mail%5D/Papierkorb', 'trash'], ['imap://U/Projekte', 'other'],
  ['imap://U/Foo/Archive', 'archive'],
])('role of %s is %s', (url, role) => expect(p(url).role).toBe(role))

test('splits url into account, path, name and type', () => {
  expect(p('imap://ABC-123/Kunden/M%C3%BCller')).toMatchObject({
    accountId: 'ABC-123', type: 'imap', path: ['Kunden', 'Müller'], name: 'Müller', role: 'other',
  })
})
test.each([['local://L/Foo', 'local'], ['ews://E/Inbox', 'exchange'], ['pop://P/Inbox', 'other']])(
  'type of %s is %s', (url, type) => expect(p(url).type).toBe(type))
test('keeps id, total, unread', () =>
  expect(parseMailbox({ id: 7, url: 'imap://U/INBOX', total: 5, unread: 2 })).toMatchObject({ id: 7, total: 5, unread: 2 }))
test('broken percent encoding does not throw', () =>
  expect(p('imap://U/%ZZ')).toMatchObject({ role: 'other', path: [] }))
test.each(['imap://U/a//b', 'imap://U/a/.', 'imap://U/..', 'imap://U/a%2Fb', 'imap://U/a%00b', 'imap://U/'])(
  'invalid segment in %s gives other with empty path', (url) =>
    expect(p(url)).toMatchObject({ role: 'other', path: [] }))
test('name falls back to raw url tail when path is empty', () =>
  expect(p('imap://U/%ZZ').name).toBe('%ZZ'))
test('garbage url does not throw', () => expect(p('not a url')).toMatchObject({ role: 'other', path: [], type: 'other' }))

test.each([
  ['imap://U/INBOX/Sent', 'sent'], ['imap://U/INBOX/Junk', 'junk'], ['imap://U/%5BGmail%5D/Spam', 'junk'],
  ['imap://U/%ZZ/Junk', 'junk'], ['imap://U/a//Trash', 'trash'], ['imap://U/../Papierkorb', 'trash'],
  ['imap://U/a%2FJunk', 'junk'], ['imap://U/%ZZ/INBOX', 'other'],
])('role of %s is %s', (url, role) => expect(p(url).role).toBe(role))
test('invalid url keeps empty path but classifies junk', () =>
  expect(p('imap://U/%ZZ/Junk')).toMatchObject({ path: [], role: 'junk' }))
