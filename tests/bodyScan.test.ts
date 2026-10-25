import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { CANDIDATE_CAP, findMatch, foldFast, scanBodies } from '../src/bodyScan.js'
import { fold } from '../src/fold.js'
import { parseForScan, parseMessage } from '../src/mime.js'
import { loadConfig, type Config } from '../src/config.js'
import { createContext } from '../src/context.js'
import { HelperError } from '../src/errors.js'
import type { HelperRunner } from '../src/helper.js'
import { computePolicy } from '../src/policy.js'
import { createServer } from '../src/server.js'

const mailboxes = {
  mailboxes: [{ id: 1, url: 'imap://ACC1/INBOX', total: 10, unread: 2 }],
  accounts: [{ uuid: 'ACC1', description: 'Privat', username: 'a@example.com' }],
  accountNames: 'available',
}

function cfg(env: Record<string, string> = {}): Config {
  const r = loadConfig(env)
  if (!r.ok) throw new Error(r.error)
  return r.config
}

function row(gid: number, over: Record<string, unknown> = {}) {
  return {
    gid,
    messageIdHeader: `<m${gid}@example.com>`,
    subject: `Subject ${gid}`,
    sender: { address: 'anna@example.com', name: 'Anna' },
    recipients: [],
    recipientCount: 0,
    dateReceived: 2000000 - gid,
    dateSent: null,
    mailboxIds: [1],
    read: true,
    flagged: false,
    attachmentNames: [],
    conversationId: null,
    file: 'full',
    ...over,
  }
}

function raw(body: string): string {
  const mime = `From: Anna <anna@example.com>\r\nSubject: x\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${body}\r\n`
  return Buffer.from(`${Buffer.byteLength(mime)}\n${mime}`).toString('base64')
}

/** Beliebige MIME-Nachricht im .emlx-Rahmen. */
function rawMime(mime: string): string {
  return Buffer.from(`${Buffer.byteLength(mime)}\n${mime}`).toString('base64')
}

interface World {
  rows: ReturnType<typeof row>[]
  bodies: Record<number, string>
  mimes?: Record<number, string>
  onCall?: (command: string) => void
  budgetOnce?: boolean
}

/** Fake-Helper: search blaettert ueber world.rows (absteigend nach gid-Reihenfolge), get-messages liefert Rohtexte. */
function fakeRunner(w: World) {
  const calls: { command: string; payload: Record<string, any> }[] = []
  let budgetUsed = false
  const runner: HelperRunner = {
    async run(command, payload: Record<string, any>) {
      calls.push({ command, payload })
      w.onCall?.(command)
      if (command === 'list-mailboxes') return mailboxes
      if (command === 'search') {
        const start = payload.after ? w.rows.findIndex((r) => r.gid === payload.after.gid) + 1 : 0
        const page = w.rows.slice(start, start + payload.limit)
        return { messages: page, hasMore: start + payload.limit < w.rows.length }
      }
      if (command === 'get-messages') {
        const gids: number[] = payload.gids
        let messages = gids.map((g) => {
          const r = w.rows.find((x) => x.gid === g)!
          const b = w.bodies[g]
          const mime = w.mimes?.[g]
          const data = mime !== undefined ? rawMime(mime) : b === undefined ? null : raw(b)
          return { ...r, raw: r.file === 'none' ? null : data, rawSize: 10, rawTruncated: false }
        })
        let budgetExhausted = false
        if (w.budgetOnce && !budgetUsed && gids.length > 2) {
          budgetUsed = true
          budgetExhausted = true
          messages = messages.map((m, i) => (i >= 2 ? { ...m, raw: null } : m))
        }
        return { messages, missing: [], budgetExhausted }
      }
      throw new Error(`unexpected ${command}`)
    },
  }
  return { runner, calls }
}

const policyOf = (config: Config) => computePolicy(config, mailboxes as never)

async function scan(w: World, over: Record<string, unknown> = {}, env: Record<string, string> = {}) {
  const { runner, calls } = fakeRunner(w)
  const config = cfg(env)
  const res = await scanBodies({ runner, policy: policyOf(config), config, filters: {}, term: 'needle', after: null, limit: 20, ...over } as never)
  return { res, calls }
}

const rowsOf = (n: number, over: (i: number) => Record<string, unknown> = () => ({})) => Array.from({ length: n }, (_, i) => row(i + 1, over(i + 1)))

describe('scanBodies', () => {
  it('stops at limit and resumes after the last scanned candidate', async () => {
    const rows = rowsOf(10)
    const bodies: Record<number, string> = {}
    for (const r of rows) bodies[r.gid] = r.gid % 2 === 0 ? 'has a needle here' : 'nothing'
    const { res, calls } = await scan({ rows, bodies }, { limit: 2 })
    expect(res.matches.map((m) => m.row.gid)).toEqual([2, 4])
    expect(res.scan).toEqual({ scanned: 4, unavailable: 0, stoppedBy: 'limit', complete: false })
    expect(res.resumeAfter).toEqual({ d: rows[3]!.dateReceived, g: 4 })
    const search = calls.find((c) => c.command === 'search')!.payload
    expect(search).toMatchObject({ limit: 200, countTotal: false, maxRecipients: 5, allowedMailboxIds: [1] })
    const get = calls.find((c) => c.command === 'get-messages')!.payload
    expect(get).toMatchObject({ maxBytesPerMessage: 256 * 1024, maxBytesTotal: 16 * 1024 * 1024 })
    // Fortsetzung ab dem Keyset
    const next = await scan({ rows, bodies }, { limit: 2, after: res.resumeAfter })
    expect(next.res.matches.map((m) => m.row.gid)).toEqual([6, 8])
    expect(next.calls.find((c) => c.command === 'search')!.payload.after).toEqual({ date: rows[3]!.dateReceived, gid: 4 })
  })

  it('reports complete with stoppedBy null when all candidates were scanned', async () => {
    const rows = rowsOf(3)
    const { res } = await scan({ rows, bodies: { 1: 'needle', 2: 'x', 3: 'y' } }, { limit: 1 })
    // Treffer beim ersten Kandidaten, aber es gibt weitere: limit.
    expect(res.scan.stoppedBy).toBe('limit')
    const all = await scan({ rows, bodies: { 1: 'x', 2: 'y', 3: 'needle' } }, { limit: 1 })
    expect(all.res.scan).toEqual({ scanned: 3, unavailable: 0, stoppedBy: null, complete: true })
    expect(all.res.resumeAfter).toBeNull()
  })

  it('stops at 2000 candidates with stoppedBy cap', async () => {
    const rows = rowsOf(CANDIDATE_CAP + 300)
    const bodies: Record<number, string> = {}
    for (const r of rows) bodies[r.gid] = 'nothing'
    const { res, calls } = await scan({ rows, bodies })
    expect(res.scan).toEqual({ scanned: 2000, unavailable: 0, stoppedBy: 'cap', complete: false })
    expect(res.resumeAfter).toEqual({ d: rows[1999]!.dateReceived, g: 2000 })
    expect(calls.filter((c) => c.command === 'search')).toHaveLength(10)
    expect(calls.filter((c) => c.command === 'get-messages').every((c) => c.payload.gids.length <= 50)).toBe(true)
  })

  it('stops after 3 s with stoppedBy time (fake clock)', async () => {
    const rows = rowsOf(120)
    const bodies: Record<number, string> = {}
    for (const r of rows) bodies[r.gid] = 'nothing'
    let t = 0
    const { res } = await scan({ rows, bodies, onCall: (c) => { if (c === 'get-messages') t += 2000 } }, { now: () => t })
    // Zwei Bloecke zu 50 sind geholt: nach dem ersten Abruf 2000 ms, nach dem zweiten 4000 ms.
    // Vor der 51. Nachricht ist das Budget weg; sie wird nicht mehr geprueft.
    expect(res.scan.stoppedBy).toBe('time')
    expect(res.scan.complete).toBe(false)
    expect(res.scan.scanned).toBe(50)
    expect(res.resumeAfter?.g).toBe(50)
  })

  it('stops within a batch as soon as the budget is gone and the next page resumes without gaps', async () => {
    const rows = rowsOf(12)
    const bodies: Record<number, string> = {}
    for (const r of rows) bodies[r.gid] = 'a needle'
    // Uhr: der Abruf kostet 2500 ms, danach kostet jedes Ablesen 100 ms.
    const clocked = () => {
      let t = 0
      let ticking = false
      return {
        now: () => (ticking ? (t += 100) : t),
        onCall: (c: string) => {
          if (c === 'get-messages') {
            t += 2500
            ticking = true
          }
        },
      }
    }
    const seen: number[] = []
    let after: { d: number; g: number } | null = null
    for (let call = 0; call < 10; call++) {
      const clock = clocked()
      const { res, calls } = await scan({ rows, bodies, onCall: clock.onCall }, { now: clock.now, after, limit: 100 })
      seen.push(...res.matches.map((m) => m.row.gid))
      if (res.scan.complete) break
      expect(res.scan.stoppedBy).toBe('time')
      // Abbruch mitten im Block: ein Abruf, weniger Kandidaten als der Block hat.
      expect(calls.filter((c) => c.command === 'get-messages')).toHaveLength(1)
      expect(res.scan.scanned).toBe(5)
      expect(res.resumeAfter?.g).toBe(seen[seen.length - 1])
      after = res.resumeAfter
    }
    // Jeder Kandidat genau einmal, in Reihenfolge.
    expect(seen).toEqual(rows.map((r) => r.gid))
  })

  it('checks the budget before fetching the next batch', async () => {
    const rows = rowsOf(120)
    const bodies: Record<number, string> = {}
    for (const r of rows) bodies[r.gid] = 'nothing'
    let t = 0
    let ticking = false
    const onCall = (c: string) => {
      if (c === 'get-messages') {
        t += 1000
        ticking = true
      }
    }
    // 1000 ms Abruf, dann 49 Ablesungen zu 40 ms bis zur 50. Nachricht (2960 ms); die Pruefung vor dem
    // naechsten Block erreicht 3000 ms und holt ihn nicht mehr.
    const { res, calls } = await scan({ rows, bodies, onCall }, { now: () => (ticking ? (t += 40) : t) })
    expect(res.scan).toEqual({ scanned: 50, unavailable: 0, stoppedBy: 'time', complete: false })
    expect(res.resumeAfter?.g).toBe(50)
    expect(calls.filter((c) => c.command === 'get-messages')).toHaveLength(1)
  })

  it('scans at least one candidate even when the first fetch exceeds the budget', async () => {
    const rows = rowsOf(3)
    let t = 0
    const { res } = await scan({ rows, bodies: { 1: 'needle', 2: 'needle', 3: 'needle' }, onCall: (c) => { if (c === 'get-messages') t += 5000 } }, { now: () => t })
    expect(res.scan).toEqual({ scanned: 1, unavailable: 0, stoppedBy: 'time', complete: false })
    expect(res.matches.map((m) => m.row.gid)).toEqual([1])
    expect(res.resumeAfter?.g).toBe(1)
  })

  it('security mails never match even if the term is in the body', async () => {
    const rows = rowsOf(2, (g) => (g === 1 ? { subject: 'Your verification code' } : {}))
    const bodies = { 1: 'Your verification code is 482913. Never share it.', 2: 'unrelated 482913 number' }
    const { res } = await scan({ rows, bodies }, { term: '482913' })
    expect(res.matches.map((m) => m.row.gid)).toEqual([2])
    expect(res.scan.scanned).toBe(2)
  })

  it('a security mail detected only by its body cannot be found by its code (E2)', async () => {
    // Neutraler Betreff, nur der Text verraet die Sicherheitsmail.
    const rows = rowsOf(1, () => ({ subject: 'Hello' }))
    const { res } = await scan({ rows, bodies: { 1: 'Your verification code is 482913' } }, { term: '482913' })
    expect(res.matches).toEqual([])
    // Nur scanned zaehlt; die Mail ist weder "nicht verfuegbar" noch beendet sie den Scan.
    expect(res.scan).toEqual({ scanned: 1, unavailable: 0, stoppedBy: null, complete: true })
    expect(res.resumeAfter).toBeNull()
  })

  const html = (body: string) => `From: Anna <anna@example.com>\r\nSubject: x\r\nContent-Type: text/html; charset=utf-8\r\n\r\n${body}\r\n`
  const alternative = (plain: string, htmlBody: string) =>
    'From: Anna <anna@example.com>\r\nSubject: x\r\nContent-Type: multipart/alternative; boundary="b"\r\n\r\n' +
    `--b\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${plain}\r\n` +
    `--b\r\nContent-Type: text/html; charset=utf-8\r\n\r\n${htmlBody}\r\n--b--\r\n`

  it('a security mail whose code sits only in the HTML part is excluded from the scan (E2)', async () => {
    const rows = rowsOf(4, () => ({ subject: 'Hello' }))
    const mimes = {
      // Nur HTML, Code fett gesetzt.
      1: html('<html><body><p>Your verification <span>code</span> is <b>482913</b>.</p></body></html>'),
      // Leerer Klartext-Teil: der Text kommt aus dem HTML-Teil.
      2: alternative('   ', '<p>Ihr Best&auml;tigungscode lautet <strong>482913</strong></p>'),
      // Schluesselwort nur im Linkziel, das html-to-text in den Text uebernimmt.
      3: html('<p>Weiter mit <a href="https://example.com/verify-your-email?c=1">diesem Link</a>. Kennung 482913</p>'),
      // Gegenprobe: gewoehnliche HTML-Mail mit derselben Zahl wird gefunden.
      4: html('<p>Bestellnummer <b>482913</b> &ndash; danke</p>'),
    }
    const { res } = await scan({ rows, bodies: {}, mimes }, { term: '482913' })
    expect(res.matches.map((m) => m.row.gid)).toEqual([4])
    expect(res.matches[0]!.matchContext).toBe('Bestellnummer 482913 – danke')
    expect(res.scan).toEqual({ scanned: 4, unavailable: 0, stoppedBy: null, complete: true })
  })

  it('mails with attachments are scanned without the attachment and verified on the full text', async () => {
    const pdf = Buffer.alloc(40000, 1).toString('base64').replace(/.{76}/g, '$&\r\n')
    const mixed = (text: string) =>
      'From: Anna <anna@example.com>\r\nSubject: x\r\nContent-Type: multipart/mixed; boundary="m"\r\n\r\n' +
      `--m\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${text}\r\n` +
      `--m\r\nContent-Type: application/pdf\r\nContent-Disposition: attachment; filename="a.pdf"\r\nContent-Transfer-Encoding: base64\r\n\r\n${pdf}\r\n--m--\r\n`
    const rows = rowsOf(3, () => ({ subject: 'Hello' }))
    const mimes = {
      1: mixed('Rechnung 482913 im Anhang'),
      2: mixed('Your one-time code is 482913'),
      3: mixed('nichts'),
    }
    const { res } = await scan({ rows, bodies: {}, mimes }, { term: '482913' })
    expect(res.matches.map((m) => m.row.gid)).toEqual([1])
    expect(res.matches[0]!.matchContext).toBe('Rechnung 482913 im Anhang')
    expect(res.scan).toEqual({ scanned: 3, unavailable: 0, stoppedBy: null, complete: true })
  })

  it('scan counters do not depend on the term when the full parse fails after the prefilter (E2)', async () => {
    // A: reines HTML, so tief verschachtelt, dass html-to-text scheitert; der schnelle Weg geht.
    const deep = html(`${'<div>'.repeat(30000)}Your verification code is 482913${'</div>'.repeat(30000)}`)
    // B: unbekannter Zeichensatz nur im Anhang; gekuerzt ist er weg, ungekuerzt scheitert parseMessage.
    const att = 'Content-Type: text/plain; charset=x-unknown-cs\r\n\r\nirrelevant\r\n'
    const unknown =
      'From: Anna <anna@example.com>\r\nSubject: x\r\nContent-Type: multipart/mixed; boundary="m"\r\n\r\n' +
      '--m\r\nContent-Type: text/plain\r\n\r\nYour one-time code is 482913\r\n' +
      `--m\r\nContent-Type: application/octet-stream\r\nContent-Disposition: attachment; filename="x.eml"\r\n\r\n${att}--m--\r\n`
    for (const mime of [deep, unknown]) {
      expect((await parseMessage(Buffer.from(rawMime(mime), 'base64'))).ok).toBe(false)
      expect((await parseForScan(Buffer.from(rawMime(mime), 'base64'))).ok).toBe(true)
    }
    const rows = rowsOf(3, () => ({ subject: 'Hello' }))
    const mimes = { 1: deep, 2: unknown }
    const results = []
    for (const term of ['482913', '4', '48', '4829', '999999']) {
      const { res } = await scan({ rows, bodies: { 3: 'no digits here' }, mimes }, { term, limit: 2 })
      expect(res.matches).toEqual([])
      results.push({ scan: res.scan, resumeAfter: res.resumeAfter })
    }
    for (const r of results) expect(r).toEqual(results[0])
    expect(results[0]).toEqual({ scan: { scanned: 3, unavailable: 0, stoppedBy: null, complete: true }, resumeAfter: null })
  })

  describe('html prefilter recall: whatever the full parse matches, the scan matches', () => {
    const cases: Array<[string, string, string]> = [
      ['unknown named entity', 'Ich &hearts; K&ouml;ln', '\u2665 k\u00f6ln'],
      ['legacy entity without semicolon', 'Firma &copy2026 Beispiel', '\u00a92026 beispiel'],
      ['upper-case legacy entity', 'A &AMP; B', 'a & b'],
      ['title inside an svg in the body', '<html><head><title>T</title></head><body><svg><title>Rechnungsdetails</title></svg> Ende</body></html>', 'rechnungsdetails ende'],
      ['zero-width space', 'Rech&#8203;nung', 'rech nung'],
      ['">" inside a quoted attribute value', '<p>Ihre <span title="a > b">Rech</span>nung</p>', 'ihre rechnung'],
    ]
    for (const [name, body, term] of cases) {
      it(name, async () => {
        const full = await parseMessage(Buffer.from(rawMime(html(body)), 'base64'))
        if (!full.ok) throw new Error('expected ok')
        expect(findMatch(full.text, term)).not.toBeNull()
        const { res } = await scan({ rows: rowsOf(1), bodies: {}, mimes: { 1: html(body) } }, { term })
        expect(res.matches.map((m) => m.row.gid)).toEqual([1])
      })
    }
  })

  it('html-only mails match across tags and entities with context from html-to-text', async () => {
    const rows = rowsOf(3)
    const mimes = {
      1: html('<style>.needle{color:red}</style><div>Ihre <b>Rech</b>nung &amp; Liefer<br>schein</div>'),
      2: html('<script>var needle = 1</script><p>nothing here</p>'),
      3: html('<p>Gr&ouml;&szlig;e passt</p>'),
    }
    const a = await scan({ rows, bodies: {}, mimes }, { term: 'rechnung & liefer' })
    expect(a.res.matches.map((m) => m.row.gid)).toEqual([1])
    expect(a.res.matches[0]!.matchContext).toContain('Rechnung & Liefer')
    // Inhalt von <style> und <script> zaehlt nicht.
    const b = await scan({ rows, bodies: {}, mimes }, { term: 'needle' })
    expect(b.res.matches).toEqual([])
    const c = await scan({ rows, bodies: {}, mimes }, { term: 'GRÖSSE' })
    expect(c.res.matches.map((m) => m.row.gid)).toEqual([3])
  })

  it('a decomposed search term matches precomposed text', async () => {
    const rows = rowsOf(1)
    const decomposed = 'ko\u0308ln'
    expect(decomposed).not.toBe('köln')
    const { res } = await scan({ rows, bodies: { 1: 'Treffen in Köln am Montag' } }, { term: decomposed })
    expect(res.matches.map((m) => m.row.gid)).toEqual([1])
    expect(res.matches[0]!.matchContext).toContain('Köln')
  })

  it('security mails match when APPLE_MAIL_SHOW_SECURITY_MAILS is true', async () => {
    const rows = rowsOf(1, () => ({ subject: 'Your verification code' }))
    const { res } = await scan({ rows, bodies: { 1: 'Your verification code is 482913.' } }, { term: '482913' }, { APPLE_MAIL_SHOW_SECURITY_MAILS: 'true' })
    expect(res.matches).toHaveLength(1)
    expect(res.matches[0]!.matchContext).toContain('482913')
  })

  it('matching folds umlauts and collapses whitespace', async () => {
    const rows = rowsOf(3)
    const bodies = { 1: 'Das GRÖSSTE  Fest\r\n  des Jahres', 2: 'Straße nach Köln', 3: 'groesste' }
    const a = await scan({ rows, bodies }, { term: 'größte   fest' })
    expect(a.res.matches.map((m) => m.row.gid)).toEqual([1])
    expect(a.res.matches[0]!.matchContext).toBe('Das GRÖSSTE Fest des Jahres')
    const b = await scan({ rows, bodies }, { term: 'STRASSE' })
    expect(b.res.matches.map((m) => m.row.gid)).toEqual([2])
    // diakritiksensitiv: ö ≠ o
    const c = await scan({ rows, bodies }, { term: 'koln' })
    expect(c.res.matches).toHaveLength(0)
  })

  it('messages without file count as unavailable', async () => {
    const rows = [row(1, { file: 'none' }), row(2), row(3)]
    const { res, calls } = await scan({ rows, bodies: { 2: 'needle', 3: 'x' } })
    expect(res.scan).toEqual({ scanned: 3, unavailable: 1, stoppedBy: null, complete: true })
    expect(res.matches.map((m) => m.row.gid)).toEqual([2])
    expect(calls.find((c) => c.command === 'get-messages')!.payload.gids).toEqual([2, 3])
  })

  it('requests the rest of a batch after budgetExhausted', async () => {
    const rows = rowsOf(5)
    const bodies = { 1: 'x', 2: 'x', 3: 'x', 4: 'needle', 5: 'x' }
    const { res, calls } = await scan({ rows, bodies, budgetOnce: true })
    expect(res.matches.map((m) => m.row.gid)).toEqual([4])
    expect(res.scan.unavailable).toBe(0)
    const gets = calls.filter((c) => c.command === 'get-messages')
    expect(gets).toHaveLength(2)
    expect(gets[1]!.payload.gids).toEqual([3, 4, 5])
  })

  it('helper crash mid-scan surfaces HELPER_CRASHED and the next call works', async () => {
    const rows = rowsOf(3)
    let crash = true
    const w: World = { rows, bodies: { 1: 'needle', 2: 'x', 3: 'x' }, onCall: (c) => { if (c === 'get-messages' && crash) { crash = false; throw new HelperError('HELPER_CRASHED', 'boom') } } }
    await expect(scan(w)).rejects.toMatchObject({ code: 'HELPER_CRASHED' })
    const ok = await scan(w)
    expect(ok.res.matches).toHaveLength(1)
  })
})

describe('foldFast', () => {
  it('equals folding every codepoint on its own', () => {
    const perCodepoint = (t: string) => [...t].map((ch) => fold(ch)).join('')
    const samples = [
      'Grüße aus KÖLN, Straße ẞ ß',
      'ΣΟΦΟΣ σοφος ΌΣΟΣ',
      'İstanbul KELVIN \u212a Ω \u2126 Å \u212b',
      'zerlegt: o\u0308 A\u030a e\u0301',
      '😀 Emoji 𝐀𝐁 \ud800 einsam',
      'ﬁ ﬂ ǅ ǈ',
    ]
    let seed = 7
    const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff)
    for (let k = 0; k < 200; k++) {
      let t = ''
      for (let j = 0; j < 40; j++) t += String.fromCodePoint(Math.floor(rnd() * 0x3000))
      samples.push(t)
    }
    for (const t of samples) expect(foldFast(t)).toBe(perCodepoint(t))
  })

  it('relies on toLowerCase only where it equals fold (below U+0340, except ß)', () => {
    for (let c = 0; c < 0x340; c++) {
      const ch = String.fromCodePoint(c)
      expect(foldFast(`${ch}A${ch}`)).toBe(`${fold(ch)}a${fold(ch)}`)
    }
    // Ausgabe von fold ist klein und ohne grosses Sigma, fuer jeden Codepoint.
    for (let c = 0; c <= 0x10ffff; c += c < 0x20000 ? 1 : 97) {
      if (c >= 0xd800 && c <= 0xdfff) continue
      const f = fold(String.fromCodePoint(c))
      if (f.toLowerCase() !== f || f.includes('\u03a3')) throw new Error(`fold output not lowercase at ${c.toString(16)}`)
    }
  })
})

describe('findMatch', () => {
  it('keeps positions correct when fold changes length (ß)', () => {
    const text = 'Eine Straße in der Stadt ist die Fußstraße der Maße'
    expect(findMatch(text, 'fussstrasse')).toBe(text)
    const ctx = findMatch('x'.repeat(300) + ' Fußgänger ' + 'y'.repeat(300), 'fussgänger')!
    expect(ctx.length).toBeLessThanOrEqual(160)
    expect(ctx).toContain('Fußgänger')
    expect(findMatch('y'.repeat(300) + ' needle', 'needle')!.endsWith('needle')).toBe(true)
  })
})

describe('search_messages bodyContains', () => {
  function setup(w: World, env: Record<string, string> = {}) {
    const { runner, calls } = fakeRunner(w)
    const ctx = createContext({ runner, configResult: loadConfig(env), bundlePath: '/x.app', open: () => {}, stateDir: mkdtempSync(join(tmpdir(), 'bs-')) })
    const server = createServer(ctx)
    const t = (server as unknown as { _registeredTools: Record<string, any> })._registeredTools.search_messages
    const call = async (args: Record<string, unknown>) => t.handler(t.inputSchema.parse(args), {})
    return { call, calls }
  }

  it('search_messages with bodySearch=false rejects bodyContains with INVALID_INPUT', async () => {
    const { call, calls } = setup({ rows: [], bodies: {} }, { APPLE_MAIL_BODY_SEARCH: 'false' })
    const res = await call({ bodyContains: 'invoice' })
    expect(res.isError).toBe(true)
    expect(res.content[0].text).toMatch(/disabled|turned off/i)
    expect(calls.filter((c) => c.command === 'search')).toHaveLength(0)
  })

  it('search_messages note mentions scanned count and how to continue', async () => {
    const rows = rowsOf(10)
    const bodies: Record<number, string> = {}
    for (const r of rows) bodies[r.gid] = 'a needle'
    const { call } = setup({ rows, bodies })
    const res = await call({ bodyContains: 'needle', limit: 3 })
    expect(res.isError).toBeUndefined()
    const s = res.structuredContent
    expect(s.scan).toEqual({ scanned: 3, unavailable: 0, stoppedBy: 'limit', complete: false })
    expect(s.totalMatched).toBeUndefined()
    expect(s.messages[0].matchContext).toBe('a needle')
    expect(s.note).toContain('Scanned the 3 newest candidate messages')
    expect(s.note).toContain('3 matches')
    expect(s.note).toContain('nextCursor to continue')
    // Cursor setzt den Scan fort und gehoert nur zu dieser Suche
    const next = await call({ bodyContains: 'needle', limit: 3, cursor: s.nextCursor })
    expect(next.structuredContent.messages.map((m: any) => m.id)).toEqual(['4', '5', '6'])
    const other = await call({ bodyContains: 'other', limit: 3, cursor: s.nextCursor })
    expect(other.isError).toBe(true)
  })
})
