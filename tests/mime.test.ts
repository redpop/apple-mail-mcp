import { readFileSync } from 'node:fs'
import { expect, test } from 'vitest'
import { parseMessage, stripEmlxFrame, truncateText, type ParsedMessage } from '../src/mime.js'

const eml = (n: string) => readFileSync(new URL(`./fixtures/eml/${n}`, import.meta.url))
const text = (m: ParsedMessage) => (m.ok ? m.text : '')

test('frame is stripped by declared length', () =>
  expect(stripEmlxFrame(Buffer.from('5\nhello<plist/>')).toString()).toBe('hello'))
test('frame without number keeps everything', () =>
  expect(stripEmlxFrame(Buffer.from('From: a\n')).toString()).toBe('From: a\n'))
test('frame length beyond file keeps the rest', () =>
  expect(stripEmlxFrame(Buffer.from('999\nshort')).toString()).toBe('short'))

test('quoted-printable umlauts decode', async () =>
  expect(text(await parseMessage(eml('plain-qp.eml')))).toContain('Grüße'))
test('base64 decodes', async () =>
  expect(text(await parseMessage(eml('plain-base64.eml')))).toContain('Hello base64 world'))
test('latin1 decodes', async () =>
  expect(text(await parseMessage(eml('latin1.eml')))).toContain('Grüße aus Köln'))
test('cp1252 decodes', async () => {
  const t = text(await parseMessage(eml('cp1252.eml')))
  expect(t).toContain('€')
  expect(t).toContain('“Anführung”')
})

test('html-only becomes text with link targets', async () => {
  const m = await parseMessage(eml('html-only.eml'))
  expect(m).toMatchObject({ ok: true, format: 'html' })
  expect(text(m)).toContain('Details [https://example.com/x]')
  expect(text(m)).not.toContain('bild')
})

test('alternative prefers plain', async () => {
  const m = await parseMessage(eml('alternative.eml'))
  expect(m).toMatchObject({ ok: true, format: 'plain' })
  expect(text(m)).toContain('Plain part wins')
})

test('headers are extracted', async () => {
  const m = await parseMessage(eml('plain-qp.eml'))
  if (!m.ok) throw new Error('expected ok')
  expect(m.headers.from).toEqual({ address: 'anna@example.com', name: 'Anna Beispiel' })
  expect(m.headers.to).toEqual([
    { address: 'bob@example.org', name: 'Bob Test' },
    { address: 'carol@example.net', name: null },
  ])
  expect(m.headers.cc).toHaveLength(1)
  expect(m.headers.replyTo).toEqual([{ address: 'reply@example.com', name: null }])
  expect(m.headers.date?.toISOString()).toBe('2025-10-20T08:00:00.000Z')
})

test('attachment before text still yields text when truncated to 256 KiB', async () => {
  const head =
    'From: a@example.com\r\nTo: b@example.org\r\nContent-Type: multipart/mixed; boundary="mix"\r\n\r\n' +
    '--mix\r\nContent-Type: application/octet-stream\r\nContent-Disposition: attachment; filename="big.bin"\r\nContent-Transfer-Encoding: base64\r\n\r\n'
  const line = 'QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVphYmNkZWZnaGlqa2xtbm9wcXJzdHV2d3h5ejAxMjM0\r\n'
  const bigBody = line.repeat(Math.ceil((30 * 1024 * 1024) / line.length))
  const tail = '--mix\r\nContent-Type: text/plain\r\n\r\nText after huge attachment\r\n--mix--\r\n'
  const raw = Buffer.from(head + bigBody + tail).subarray(0, 256 * 1024)
  expect(raw.length).toBe(256 * 1024)
  // Der Text liegt hinter dem Anhang und ist weggeschnitten: ehrlich ok:false, kein Wurf.
  const m = await parseMessage(raw)
  expect(m.ok).toBe(false)
})

test('text before attachment survives truncation', async () => {
  const head =
    'From: a@example.com\r\nTo: b@example.org\r\nContent-Type: multipart/mixed; boundary="mix"\r\n\r\n' +
    '--mix\r\nContent-Type: text/plain\r\n\r\nText first\r\n--mix\r\nContent-Type: application/octet-stream\r\nContent-Transfer-Encoding: base64\r\n\r\n'
  const raw = Buffer.from(head + 'QUJD\r\n'.repeat(100000)).subarray(0, 256 * 1024)
  const m = await parseMessage(raw)
  expect(text(m)).toContain('Text first')
})

test('broken or unknown charset gives ok:false, never throws', async () => {
  await expect(parseMessage(eml('broken.eml'))).resolves.toBeDefined()
  expect((await parseMessage(eml('unknown-charset.eml'))).ok).toBe(false)
})

test('garbage and empty input never throw', async () => {
  await expect(parseMessage(Buffer.alloc(0))).resolves.toBeDefined()
  await expect(parseMessage(Buffer.from([0, 255, 254, 10, 13]))).resolves.toBeDefined()
})

test('normalises line endings and blank lines', async () => {
  const m = await parseMessage(Buffer.from('Content-Type: text/plain\r\n\r\na\r\n\r\n\r\n\r\n\r\nb\r\n'))
  expect(text(m)).toBe('a\n\n\nb')
})

test('truncate cuts at word boundary', () =>
  expect(truncateText('alpha beta gamma', 8)).toEqual({ text: 'alpha', truncated: true, totalChars: 16 }))
test('truncate leaves short text alone', () =>
  expect(truncateText('alpha', 8)).toEqual({ text: 'alpha', truncated: false, totalChars: 5 }))
