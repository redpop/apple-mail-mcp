import { readdirSync, readFileSync } from 'node:fs'
import { BinTrieFlags, decodeHTMLStrict, determineBranch, htmlDecodeTree } from 'entities/lib/decode.js'
import { expect, test } from 'vitest'
import { fold } from '../src/fold.js'
import { htmlToText, parseForScan, parseMessage, stripEmlxFrame, truncateText, type ParsedMessage } from '../src/mime.js'
import { textParts } from '../src/mimeTrim.js'
import { decodeEntities, quickHtmlText, termSurvivesUnknownEntities } from '../src/quickHtml.js'

const eml = (n: string) => readFileSync(new URL(`./fixtures/eml/${n}`, import.meta.url))
const text = (m: ParsedMessage) => (m.ok ? m.text : '')

test('frame is stripped by declared length', () =>
  expect(stripEmlxFrame(Buffer.from('5\nhello<plist/>')).toString()).toBe('hello'))
test('frame without number keeps everything', () =>
  expect(stripEmlxFrame(Buffer.from('From: a\n')).toString()).toBe('From: a\n'))
test('frame shorter than the file cuts there even without a plist', () =>
  expect(stripEmlxFrame(Buffer.from('5\nhello world\n')).toString()).toBe('hello'))
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

const multipart = (sub: string, parts: string[]) =>
  Buffer.from(
    `From: a@example.com\r\nTo: b@example.org\r\nContent-Type: multipart/${sub}; boundary="b"\r\n\r\n` +
      parts.map((p) => `--b\r\n${p}\r\n`).join('') +
      '--b--\r\n',
    'latin1',
  )

test('charsets are checked per part: readable plain wins over an unknown html charset', async () => {
  const raw = multipart('alternative', ['Content-Type: text/plain\r\n\r\nPlain without charset', 'Content-Type: text/html; charset=x-nonsense\r\n\r\n<p>Html</p>'])
  const m = await parseMessage(raw)
  expect(m).toMatchObject({ ok: true, format: 'plain' })
  expect(text(m)).toBe('Plain without charset')
})

test('an unknown plain charset falls back to a readable html part', async () => {
  const raw = multipart('alternative', ['Content-Type: text/plain; charset=x-nonsense\r\n\r\nGeraten', 'Content-Type: text/html; charset=utf-8\r\n\r\n<p>Html wins</p>'])
  const m = await parseMessage(raw)
  expect(m).toMatchObject({ ok: true, format: 'html' })
  expect(text(m)).toBe('Html wins')
  const scan = await parseForScan(raw)
  expect(scan.ok && (await scan.full())).toBe('Html wins')
})

test('header lines inside a body or attachment do not count as charsets', async () => {
  const forwarded = Buffer.from('Content-Type: text/plain\r\n\r\nForwarded:\r\nContent-Type: text/plain; charset=x-nonsense\r\n\r\nold text\r\n')
  expect(textParts(forwarded)).toEqual([{ type: 'text/plain', charset: null }])
  expect(text(await parseMessage(forwarded))).toContain('old text')
  const attached = multipart('mixed', [
    'Content-Type: text/plain; charset=utf-8\r\n\r\nSee attachment',
    'Content-Type: text/plain; charset=x-nonsense\r\nContent-Disposition: attachment; filename="a.txt"\r\n\r\nraw',
  ])
  expect(textParts(attached)).toEqual([{ type: 'text/plain', charset: 'utf-8' }])
  expect(text(await parseMessage(attached))).toBe('See attachment')
})

test('textParts reads nested multiparts and inline message/rfc822 parts', () => {
  const raw = multipart('mixed', [
    'Content-Type: multipart/alternative; boundary="i"\r\n\r\n--i\r\nContent-Type: text/plain;\r\n charset="ISO-8859-1"\r\n\r\nA\r\n--i\r\nContent-Type: text/html\r\n\r\n<p>B</p>\r\n--i--',
    'Content-Type: message/rfc822\r\n\r\nSubject: inner\r\nContent-Type: text/plain; charset=koi8-r\r\n\r\nC',
    'Content-Type: image/png\r\n\r\nxx',
  ])
  expect(textParts(raw)).toEqual([
    { type: 'text/plain', charset: 'ISO-8859-1' },
    { type: 'text/html', charset: null },
    { type: 'text/plain', charset: 'koi8-r' },
  ])
  expect(textParts(Buffer.from('Subject: no body'))).toBeNull()
})

test('headings and table headers keep their case', async () => {
  const m = await parseMessage(Buffer.from('Content-Type: text/html\r\n\r\n<h1>Ihre Rechnung</h1><table><tr><th>Posten</th></tr><tr><td>Tee</td></tr></table>'))
  expect(text(m)).toContain('Ihre Rechnung')
  expect(text(m)).toContain('Posten')
  expect(text(m)).not.toMatch(/RECHNUNG|POSTEN/)
})

test('an attachment before the text part still yields the text', async () => {
  const m = await parseMessage(eml('attachment-first.eml'))
  expect(m).toMatchObject({ ok: true, format: 'plain' })
  expect(text(m)).toBe('Text after attachment')
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

/** Alle benannten Entities von HTML, aus der Tabelle des Pakets entities (die html-to-text nutzt). */
function htmlEntityNames(): string[] {
  const chars = [...'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789;']
  const names = new Set<string>()
  const walk = (idx: number, name: string): void => {
    const current = htmlDecodeTree[idx]!
    const valueLength = (current & BinTrieFlags.VALUE_LENGTH) >> 14
    if (valueLength !== 0 && name !== '') names.add(name.replace(/;$/, ''))
    // Ein Wert in einem Wort ist ein Blatt; seine Bits sind keine Verzweigungen.
    if (valueLength === 1) return
    for (const c of chars) {
      const next = determineBranch(htmlDecodeTree, current, idx + Math.max(1, valueLength), c.charCodeAt(0))
      if (next >= 0) walk(next, name + c)
    }
  }
  walk(0, '')
  return [...names]
}

test('quickHtmlText decodes known entities like HTML and unknown ones never hide a surviving term', () => {
  const names = htmlEntityNames()
  expect(names.length).toBeGreaterThan(2000)
  const wrong: string[] = []
  for (const name of names) {
    const want = decodeHTMLStrict(`&${name};`)
    const got = decodeEntities(`&${name};`)
    if (got.sure) {
      if (got.text !== want) wrong.push(`${name}: decodes differently`)
      continue
    }
    // Unbekannt: das Zeichen darf weder wegfallen (Leerraum) noch in einem Begriff stehen koennen.
    const folded = fold(want).replace(/[\s\u200b]+/g, '')
    if (folded === '' || [...folded].some((c) => termSurvivesUnknownEntities(c))) wrong.push(`${name}: must be in the table`)
  }
  expect(wrong).toEqual([])
  expect(termSurvivesUnknownEntities('rechnung-2026@example.com')).toBe(true)
  expect(termSurvivesUnknownEntities(fold('Grüße'))).toBe(true)
  expect(termSurvivesUnknownEntities('\u2665')).toBe(false)
})

test('quickHtmlText renders link targets like html-to-text', () => {
  const cases = [
    '<a href="https://example.com/a"><img src="x.png" alt="Logo"></a> next',
    '<a href="https://example.com/a">https://<b>example.com/a</b></a> next',
    '<a href="https://example.com/a"><span>Click</span> <b>here</b></a>',
    '<a href="mailto:x@example.com"><b>x@example.com</b></a> next',
    '<a href="mailto:x@example.com">Write</a>',
    '<a href="https://example.com/a">  https://example.com/a  </a>',
    '<a href="https://example.com/a">Https://example.com/a</a>',
    '<a href="https://example.com/a"><h2>Title</h2></a>',
    '<a href="https://example.com/a">a<br>b</a>',
    '<a href="#top">Top</a> <a href="">empty</a>',
  ]
  const loose = (t: string) => t.replace(/\s+/g, '')
  for (const html of cases) expect(loose(quickHtmlText(html).text), html).toBe(loose(htmlToText(html)))
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
  expect(scan).toMatchObject({ exact: false, sure: true })
  const quick = (scan.exact ? '' : scan.quick).replace(/\s+/g, '')
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
