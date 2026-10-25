import { readdirSync, readFileSync } from 'node:fs'
import PostalMime from 'postal-mime'
import { describe, expect, it } from 'vitest'
import { stripEmlxFrame } from '../src/mime.js'
import { trimForScan } from '../src/mimeTrim.js'

const HEAD = 'From: Anna <anna@example.com>\r\nTo: bob@example.org\r\nSubject: x\r\n'
const b64 = (n: number) => Buffer.alloc(n, 7).toString('base64').replace(/.{76}/g, '$&\r\n')

async function textOf(raw: Buffer): Promise<{ text?: string; html?: string; attachments: string[] }> {
  const e = await PostalMime.parse(raw)
  return { text: e.text, html: e.html, attachments: e.attachments.map((a) => `${a.mimeType}:${a.filename ?? ''}`) }
}

/** Kuerzen aendert den Text nicht; die Anhaenge bleiben als leere Eintraege erhalten. */
async function expectSameText(mime: string, shrinks = true) {
  const raw = Buffer.from(mime, 'latin1')
  const trimmed = trimForScan(raw)
  if (!shrinks) {
    expect(trimmed).toBeNull()
    return
  }
  expect(trimmed).not.toBeNull()
  expect(trimmed!.length).toBeLessThan(raw.length)
  const a = await textOf(raw)
  const b = await textOf(trimmed!)
  expect(b.text).toBe(a.text)
  expect(b.attachments).toEqual(a.attachments)
  return { raw, trimmed: trimmed!, a, b }
}

describe('trimForScan', () => {
  it('drops attachment bodies and keeps text before and after them (Apple Mail layout)', async () => {
    const r = await expectSameText(
      `${HEAD}Content-Type: multipart/mixed; boundary="mix"\r\n\r\npreamble\r\n` +
        '--mix\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nText before\r\n' +
        `--mix\r\nContent-Type: application/pdf; name="a.pdf"\r\nContent-Disposition: inline; filename="a.pdf"\r\nContent-Transfer-Encoding: base64\r\n\r\n${b64(30000)}\r\n` +
        '--mix\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nText after\r\n' +
        `--mix\r\nContent-Type: image/png\r\nContent-Transfer-Encoding: base64\r\n\r\n${b64(20000)}\r\n` +
        '--mix--\r\nepilogue\r\n',
    )
    expect(r!.a.text).toContain('Text before')
    expect(r!.a.text).toContain('Text after')
    expect(r!.trimmed.length).toBeLessThan(1000)
  })

  it('cuts an attachment truncated at 256 KiB to the end', async () => {
    const mime =
      `${HEAD}Content-Type: multipart/mixed; boundary=mix\r\n\r\n` +
      '--mix\r\nContent-Type: text/plain\r\nContent-Transfer-Encoding: quoted-printable\r\n\r\nGr=C3=BC=C3=9Fe\r\n' +
      `--mix\r\nContent-Type: application/octet-stream\r\nContent-Disposition: attachment; filename="big.bin"\r\nContent-Transfer-Encoding: base64\r\n\r\n${b64(300000)}`
    const raw = Buffer.from(mime, 'latin1').subarray(0, 256 * 1024)
    const trimmed = trimForScan(raw)!
    expect(trimmed.length).toBeLessThan(400)
    expect((await textOf(trimmed)).text).toBe((await textOf(raw)).text)
  })

  it('drops the html part of an alternative that has a plain part, also nested', async () => {
    const r = await expectSameText(
      `${HEAD}Content-Type: multipart/mixed;\r\n boundary="outer"\r\n\r\n` +
        '--outer\r\nContent-Type: multipart/alternative; boundary="alt"\r\n\r\n' +
        '--alt\r\nContent-Type: text/plain\r\n\r\nPlain wins\r\n' +
        `--alt\r\nContent-Type: text/html\r\n\r\n<p>${'x'.repeat(5000)}</p>\r\n` +
        '--alt--\r\n' +
        '--outer\r\nContent-Type: text/calendar; method=REQUEST\r\n\r\nBEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n' +
        '--outer--\r\n',
    )
    expect(r!.a.text).toContain('Plain wins')
  })

  it('keeps the html part of an alternative without a plain part and of html-only mail', async () => {
    await expectSameText(
      `${HEAD}Content-Type: multipart/alternative; boundary="alt"\r\n\r\n--alt\r\nContent-Type: text/html\r\n\r\n<p>Only html</p>\r\n--alt--\r\n`,
      false,
    )
    await expectSameText(`${HEAD}Content-Type: text/html\r\n\r\n<p>Only html</p>\r\n`, false)
  })

  it('keeps inline messages and parts without content type', async () => {
    await expectSameText(
      `${HEAD}Content-Type: multipart/mixed; boundary="m"\r\n\r\n--m\r\n\r\nNo headers, still text\r\n` +
        `--m\r\nContent-Type: message/rfc822\r\n\r\nSubject: inner\r\nContent-Type: text/plain\r\n\r\nForwarded body\r\n--m--\r\n`,
      false,
    )
  })

  it('works with LF line ends and trailing whitespace after a delimiter', async () => {
    await expectSameText(
      `From: a@example.com\nContent-Type: multipart/mixed; boundary=b\n\n--b  \nContent-Type: text/plain\n\nHello\n--b\t\nContent-Type: image/jpeg\n\n${'A'.repeat(4000)}\n--b-- \n`,
    )
  })

  it('does not take a longer boundary that starts with the active one for a delimiter', async () => {
    await expectSameText(
      `${HEAD}Content-Type: multipart/mixed; boundary="b"\r\n\r\n--b\r\nContent-Type: text/plain\r\n\r\nline\r\n--bx\r\nstill text\r\n` +
        `--b\r\nContent-Type: application/zip\r\n\r\n${'Z'.repeat(3000)}\r\n--b--\r\n`,
    )
  })

  it('gives up on unclear structure', () => {
    const none = (s: string) => expect(trimForScan(Buffer.from(s, 'latin1'))).toBeNull()
    none(`${HEAD}Content-Type: text/plain\r\n\r\nplain\r\n`)
    none(`${HEAD}Content-Type: multipart/mixed\r\n\r\n--\r\nContent-Type: image/png\r\n\r\nAAAA\r\n`)
    none(`${HEAD}Content-Type: multipart/mixed; boundary="b"\r\nContent-Type: multipart/mixed; boundary="c"\r\n\r\n--b\r\nContent-Type: image/png\r\n\r\nAAAA\r\n`)
    // Dieselbe Boundary innen und aussen.
    none(
      `${HEAD}Content-Type: multipart/mixed; boundary="b"\r\n\r\n--b\r\nContent-Type: multipart/mixed; boundary="b"\r\n\r\n` +
        '--b\r\nContent-Type: image/png\r\n\r\nAAAA\r\n--b--\r\n--b--\r\n',
    )
    none('')
    none('no headers at all')
  })

  it('never changes the text of the fixture messages', async () => {
    for (const name of readdirSync(new URL('./fixtures/eml/', import.meta.url))) {
      const raw = stripEmlxFrame(readFileSync(new URL(`./fixtures/eml/${name}`, import.meta.url)))
      const trimmed = trimForScan(raw)
      if (trimmed === null) continue
      expect((await textOf(trimmed)).text).toBe((await textOf(raw)).text)
    }
  })
})
