import { readdirSync, readFileSync } from 'node:fs'
import { expect, test } from 'vitest'
import { declaredCharsets, parseForScan, parseMessage, stripEmlxFrame, truncateText, type ParsedMessage } from '../src/mime.js'
import { quickHtmlText } from '../src/quickHtml.js'

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

// Die fruehere Fassung von declaredCharsets (ganze Nachricht in Zeilen zerlegt) als Referenz.
function charsetsByLines(raw: Buffer): string[] {
  const out: string[] = []
  let inContentType = false
  for (const line of raw.toString('latin1').split(/\r?\n/)) {
    if (/^content-type:/i.test(line)) inContentType = true
    else if (!/^[ \t]/.test(line)) inContentType = false
    if (!inContentType) continue
    for (const m of line.matchAll(/charset\s*=\s*"?([A-Za-z0-9_.:-]+)/gi)) out.push(m[1] as string)
  }
  return out
}

test('declaredCharsets finds the same labels as a line-by-line scan', () => {
  const samples = [
    ...readdirSync(new URL('./fixtures/eml/', import.meta.url)).map(eml),
    Buffer.from('Content-Type: text/plain;\r\n charset="iso-8859-1"\r\nX: charset=no\r\n\r\nbody charset=utf-8\r\n'),
    Buffer.from('content-type: multipart/mixed; boundary=b\n\tcharset=a\n\n--b\nContent-Type: text/plain; charset=b\r\n \r\n charset=c\nContent-Type: text/html; charset=d'),
    Buffer.from('Content-Type: text/plain; charset=\r\n utf-8\r\nContent-Type: x;charset=y\rcharset=z\n'),
    Buffer.from('X: 1\nContent-Type: text/plain; charset=utf-8'),
    Buffer.alloc(0),
  ]
  for (const raw of samples) expect(declaredCharsets(raw)).toEqual(charsetsByLines(raw))
})

test('quickHtmlText drops tags, comments, script and style and decodes entities', () => {
  const t = quickHtmlText(
    '<!DOCTYPE html><html><head><title>Titel</title><style>p{color:red}</style></head><body>' +
      '<!-- versteckt --><p>Gr&ouml;&szlig;e &amp; Preis &euro;&#160;12 &#x2013; a &lt; b</p><script>var x = 1</script>' +
      '<p>Mehr <a href="https://example.com/x?a=1&amp;b=2">Details</a> und <a href="https://example.com">https://example.com</a></p>' +
      '<img src="https://example.com/i.png" alt="Bild > Text"> 3 < 4 &unknown</body></html>',
  )
  const words = t.text.replace(/\s+/g, ' ').trim()
  expect(words).toBe('Größe & Preis € 12 – a < b Mehr Details [https://example.com/x?a=1&b=2] und https://example.com 3 < 4 &unknown')
  // Ohne Semikolon ist "&unknown" kein Entity; das ist sicher.
  expect(t.sure).toBe(true)
})

test('quickHtmlText is unsure about unknown named entities and decodes legacy ones like HTML', () => {
  expect(quickHtmlText('I &hearts; it').sure).toBe(false)
  expect(quickHtmlText('A &AUML; B').sure).toBe(false)
  const legacy = quickHtmlText('&copy2026 &AMP; &COPY; &notit &amp')
  expect(legacy).toEqual({ text: '\u00a92026 & \u00a9 \u00acit &', sure: true })
  // Im Attribut bleibt ein Legacy-Name vor Buchstabe, Ziffer oder "=" stehen.
  expect(quickHtmlText('<a href="https://example.com/?a=1&copy=2&notx=3">x</a>').text).toContain('[https://example.com/?a=1&copy=2&notx=3]')
  expect(quickHtmlText('<a href="https://example.com/?a&copy;">x</a>').text).toContain('?a\u00a9]')
})

test('quickHtmlText keeps a title inside the body and ends tags outside quoted values', () => {
  const t = quickHtmlText('<html><head><title>Kopf</title></head><body><svg><title>Grafik</title></svg><img alt="Weiter >">Ende</body></html>').text
  expect(t.replace(/\s+/g, ' ').trim()).toBe('Grafik Ende')
  expect(quickHtmlText('<p title=\'a > b\' x=y>Text</p>').text.trim()).toBe('Text')
})

test('quickHtmlText survives unterminated markup', () => {
  expect(quickHtmlText('a <b c="d').text.trim()).toBe('a')
  expect(quickHtmlText('a <b c="d>e').text.trim()).toBe('a')
  expect(quickHtmlText('a <script>never closed').text.trim()).toBe('a')
  expect(quickHtmlText('a <!-- open').text.trim()).toBe('a')
  expect(quickHtmlText('<style>x</style>').text.trim()).toBe('')
})

test('quickHtmlText keeps every word of the html-to-text output', async () => {
  const html = eml('html-only.eml')
  const parsed = await parseMessage(html)
  if (!parsed.ok) throw new Error('expected ok')
  const scan = await parseForScan(html)
  if (!scan.ok) throw new Error('expected ok')
  const quick = (scan.quick ?? '').replace(/\s+/g, '')
  expect(scan.quick).not.toBeNull()
  for (const word of parsed.text.split(/[\s[\]]+/).filter((w) => w !== '')) expect(quick).toContain(word)
})

test('parseForScan gives the parseMessage text for plain and, via full(), for html', async () => {
  for (const name of readdirSync(new URL('./fixtures/eml/', import.meta.url))) {
    const raw = eml(name)
    const full = await parseMessage(raw)
    const scan = await parseForScan(raw)
    expect(scan.ok).toBe(full.ok)
    if (!full.ok || !scan.ok) continue
    if (scan.exact) expect(full.format).toBe('plain')
    // Klartext, auch aus einer gekuerzten Nachricht, ist derselbe Text.
    if (full.format === 'plain') expect(scan.quick).toBe(full.text)
    expect(await scan.full()).toBe(full.text)
  }
})
