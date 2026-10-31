#!/usr/bin/env node
// Misst, wie lange der Body-Scan pro Nachricht in den einzelnen Stufen braucht.
// Die Nachrichten sind synthetisch und aehneln echter Post (Text, Newsletter, Anhang).
// Gibt nur Zeiten aus, nie Inhalte.
//
// Aufruf (nach npm run build):
//   node scripts/bench-mime.mjs [runden]
import PostalMime from 'postal-mime'
import { performance } from 'node:perf_hooks'
import { htmlToText, normalise, parseMessage, stripEmlxFrame } from '../dist/mime.js'
import { quickHtmlText } from '../dist/quickHtml.js'
import { textParts, trimForScan } from '../dist/mimeTrim.js'
import { classify } from '../dist/securityMail.js'
import { examine, findMatch, foldFast } from '../dist/bodyScan.js'

const ROUNDS = Number(process.argv[2] ?? 20)
const TERM = 'kontoauszug2026'
const SCAN_BYTES = 256 * 1024

// Deterministischer Zufall, damit jeder Lauf dieselben Nachrichten misst.
let seed = 42
const rand = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff)
const pick = (a) => a[Math.floor(rand() * a.length)]
const WORDS = [
  'Rechnung', 'Bestellung', 'Lieferung', 'Grüße', 'Köln', 'Straße', 'Angebot', 'März', 'über', 'für',
  'meeting', 'project', 'update', 'schedule', 'invoice', 'newsletter', 'Rabatt', 'Größe', 'Woche', 'heute',
  'Termin', 'Projekt', 'Unterlagen', 'Antwort', 'Frage', 'wir', 'und', 'die', 'der', 'das', 'mit', 'bitte',
]
function words(n) {
  const out = []
  for (let i = 0; i < n; i++) out.push(pick(WORDS))
  return out.join(' ')
}
function paragraphs(bytes) {
  let s = ''
  while (Buffer.byteLength(s) < bytes) s += `${words(12 + Math.floor(rand() * 30))}.\n\n`
  return s
}

function qp(text) {
  const bytes = Buffer.from(text.replace(/\r?\n/g, '\r\n'), 'utf8')
  let out = ''
  let line = ''
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i]
    if (b === 0x0d && bytes[i + 1] === 0x0a) {
      out += `${line}\r\n`
      line = ''
      i++
      continue
    }
    const enc = (b >= 33 && b <= 126 && b !== 61) || b === 32 ? String.fromCharCode(b) : `=${b.toString(16).toUpperCase().padStart(2, '0')}`
    if (line.length + enc.length > 75) {
      out += `${line}=\r\n`
      line = ''
    }
    line += enc
  }
  return out + line
}
const b64 = (buf) => buf.toString('base64').replace(/.{76}/g, '$&\r\n')

function newsletter(bytes, extra = '') {
  let s = '<!DOCTYPE html><html><head><meta charset="utf-8"><title>Newsletter</title><style>'
  for (let i = 0; i < 40; i++) s += `.c${i}{font-family:Arial,sans-serif;color:#333;padding:${i}px;margin:0 auto}`
  s += '</style><script>var x = 1;</script></head><body><table width="100%" cellpadding="0" cellspacing="0" border="0">'
  while (s.length < bytes) {
    s += `<tr><td class="c${Math.floor(rand() * 40)}" style="padding:16px;font-size:14px;line-height:20px;color:#333333;">`
    s += `<h2 style="margin:0">${words(5)}</h2><p>${words(30)} &nbsp;&amp; ${words(8)} &auml;&ouml;&uuml; &euro;12,99${extra}</p>`
    s += `<a href="https://example.com/track?id=${Math.floor(rand() * 1e9)}&amp;u=abc" style="color:#0066cc">${words(3)}</a>`
    s += `<img src="https://example.com/img/${Math.floor(rand() * 1e6)}.png" alt="${words(2)}" width="600" height="200">`
    s += `<!-- spacer --><div style="height:8px"><span>${words(4)}</span></div></td></tr>\n`
  }
  return `${s}</table></body></html>`
}

const HEAD = (ct, extra = '') =>
  `From: Anna Beispiel <anna@example.com>\r\nTo: bob@example.org\r\nSubject: ${words(5)}\r\nDate: Mon, 20 Oct 2025 10:00:00 +0200\r\nMessage-ID: <${Math.floor(rand() * 1e9)}@example.com>\r\nMIME-Version: 1.0\r\n${extra}Content-Type: ${ct}\r\n`

function emlx(mime) {
  const body = Buffer.from(mime, 'latin1')
  const plist = Buffer.from('<?xml version="1.0"?><plist version="1.0"><dict><key>flags</key><integer>8590195713</integer></dict></plist>\n')
  return Buffer.concat([Buffer.from(`${body.length}\n`), body, plist]).subarray(0, SCAN_BYTES)
}
// MIME-Text liegt als Latin-1-String vor (Bytes 1:1), damit 8bit-Teile korrekt bleiben.
const bin = (s) => Buffer.from(s, 'utf8').toString('latin1')

function makeMessages() {
  const m = {}
  m['plain 8bit 3 KB'] = emlx(HEAD('text/plain; charset=utf-8', 'Content-Transfer-Encoding: 8bit\r\n') + '\r\n' + bin(paragraphs(3000)))
  m['plain qp 6 KB'] = emlx(HEAD('text/plain; charset=utf-8', 'Content-Transfer-Encoding: quoted-printable\r\n') + '\r\n' + qp(paragraphs(6000)))
  m['plain base64 6 KB'] = emlx(HEAD('text/plain; charset=utf-8', 'Content-Transfer-Encoding: base64\r\n') + '\r\n' + b64(Buffer.from(paragraphs(6000))))
  for (const kb of [50, 150]) {
    m[`alternative qp + html ${kb} KB`] = emlx(
      HEAD('multipart/alternative; boundary="alt"') +
        '\r\n--alt\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: quoted-printable\r\n\r\n' + qp(paragraphs(8000)) +
        '\r\n--alt\r\nContent-Type: text/html; charset=utf-8\r\nContent-Transfer-Encoding: quoted-printable\r\n\r\n' + qp(newsletter(kb * 1024)) +
        '\r\n--alt--\r\n',
    )
  }
  m['alternative base64 + html 100 KB'] = emlx(
    HEAD('multipart/alternative; boundary="alt"') +
      '\r\n--alt\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: base64\r\n\r\n' + b64(Buffer.from(paragraphs(8000))) +
      '\r\n--alt\r\nContent-Type: text/html; charset=utf-8\r\nContent-Transfer-Encoding: base64\r\n\r\n' + b64(Buffer.from(newsletter(100 * 1024))) +
      '\r\n--alt--\r\n',
  )
  m['html only qp 100 KB'] = emlx(HEAD('text/html; charset=utf-8', 'Content-Transfer-Encoding: quoted-printable\r\n') + '\r\n' + qp(newsletter(100 * 1024)))
  // Ein Entity, das die Tabelle von quickHtmlText nicht kennt (wie &hearts; oder &check; in Newslettern).
  m['html only qp 100 KB, unknown entity'] = emlx(HEAD('text/html; charset=utf-8', 'Content-Transfer-Encoding: quoted-printable\r\n') + '\r\n' + qp(newsletter(100 * 1024, ' &hearts;')))
  const attachment = Buffer.alloc(200 * 1024)
  for (let i = 0; i < attachment.length; i++) attachment[i] = Math.floor(rand() * 256)
  m['mixed text + 200 KB attachment (cut)'] = emlx(
    HEAD('multipart/mixed; boundary="mix"') +
      '\r\n--mix\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: quoted-printable\r\n\r\n' + qp(paragraphs(4000)) +
      '\r\n--mix\r\nContent-Type: application/pdf; name="scan.pdf"\r\nContent-Disposition: attachment; filename="scan.pdf"\r\nContent-Transfer-Encoding: base64\r\n\r\n' + b64(attachment) +
      '\r\n--mix--\r\n',
  )
  return m
}

/** Fuehrt fn ueber alle Eingaben ROUNDS-mal aus und liefert Millisekunden pro Nachricht. */
async function per(inputs, fn) {
  for (const x of inputs) await fn(x) // Aufwaermen
  const t0 = performance.now()
  for (let r = 0; r < ROUNDS; r++) for (const x of inputs) await fn(x)
  return (performance.now() - t0) / (ROUNDS * inputs.length)
}

const fmt = (ms) => `${ms.toFixed(3).padStart(8)} ms`
const messages = makeMessages()

const ROW = { subject: 'Hello', sender: { address: 'anna@example.com', name: 'Anna' } }
const fullPath = async (x) => {
  const p = await parseMessage(x)
  if (p.ok) {
    classify({ subject: 'Hello', fromAddress: 'anna@example.com', text: p.text })
    findMatch(p.text, TERM)
  }
}
const scanPath = (b) => examine(b, ROW, TERM, TERM, false)

console.log(`Node ${process.version}, ${ROUNDS} rounds, term not present (worst case: whole text searched)`)
console.log('')
console.log('Stages per message (ms). postal = postal-mime on the whole message, trim = trimForScan,')
console.log('postal/t = postal-mime on the trimmed message, h2t = html-to-text, quick = quickHtmlText,')
console.log('loose = whitespace-free prefilter on the quick text.')
console.log('full = parse + classify + match as get_message would; scan = the body-scan path (examine, incl. base64).')
const header = ['type', 'KiB', 'b64', 'strip', 'charset', 'postal', 'trim', 'postal/t', 'h2t', 'quick', 'norm', 'classify', 'match', 'loose', 'full', 'scan']
const w = (i) => (i === 0 ? 36 : i === 1 ? 5 : 9)
console.log(header.map((h, i) => (i === 0 ? h.padEnd(w(i)) : h.padStart(w(i)))).join(''))

for (const [name, raw] of Object.entries(messages)) {
  const one = [raw]
  const base64 = raw.toString('base64')
  const stripped = stripEmlxFrame(raw)
  const email = await PostalMime.parse(stripped)
  const hasPlain = typeof email.text === 'string' && email.text.trim() !== ''
  const source = hasPlain ? email.text : htmlToText(email.html ?? '')
  const text = normalise(source)
  const quick = hasPlain ? '' : quickHtmlText(email.html ?? '').text
  const s = {
    b64: await per([base64], (x) => Buffer.from(x, 'base64')),
    strip: await per(one, (x) => stripEmlxFrame(x)),
    charset: await per([stripped], (x) => textParts(x)),
    postal: await per([stripped], (x) => PostalMime.parse(x)),
    trim: await per([stripped], (x) => trimForScan(x)),
    postalTrimmed: await per([trimForScan(stripped) ?? stripped], (x) => PostalMime.parse(x)),
    h2t: hasPlain ? 0 : await per([email.html ?? ''], (x) => htmlToText(x)),
    quick: hasPlain ? 0 : await per([email.html ?? ''], (x) => quickHtmlText(x)),
    norm: await per([source], (x) => normalise(x)),
    classify: await per([text], (x) => classify({ subject: 'Hello', fromAddress: 'anna@example.com', text: x })),
    match: await per([text], (x) => findMatch(x, TERM)),
    loose: hasPlain ? 0 : await per([quick], (x) => foldFast(x.replace(/[\s\u200b]+/g, '')).includes(TERM)),
    full: await per(one, fullPath),
    scan: await per([base64], scanPath),
  }
  const cells = Object.values(s).map((ms) => ms.toFixed(3).padStart(9))
  console.log(name.padEnd(w(0)) + String(Math.round(raw.length / 1024)).padStart(5) + cells.join(''))
}

const all = Object.values(messages)
const fullAvg = await per(all, fullPath)
const scanAvg = await per(all.map((x) => x.toString('base64')), scanPath)
console.log('')
console.log(`mix average, full path: ${fmt(fullAvg)}  = ${Math.round(1000 / fullAvg)} messages/s`)
console.log(`mix average, scan path: ${fmt(scanAvg)}  = ${Math.round(1000 / scanAvg)} messages/s`)
