import type { HelperRunner } from '../../src/helper.js'
import type { Policy } from '../../src/policy.js'

// Kleine Mail-Welt hinter dem HelperRunner-Fake: messages-Zeilen mit ROWID, gid, Mailbox und Rohtext.
export interface FakeRow {
  rowid: number
  gid: number
  mailbox: number
  subject: string
  from: string
  /** null = keine .emlx-Datei (Body nie geladen). */
  body: string | null
  deleted?: boolean
}

export function emlx(body: string, subject = 'Hello'): string {
  const mime = `From: Anna <anna@example.com>\r\nTo: x@example.org\r\nSubject: ${subject}\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${body}\r\n`
  return Buffer.from(`${Buffer.byteLength(mime)}\n${mime}`).toString('base64')
}

export interface Call {
  command: string
  payload: Record<string, unknown>
}

export class FakeMail {
  rows: FakeRow[] = []
  allowed: number[] = [1]
  fingerprint = 'sha256:abc'
  access: 'granted' | 'denied' = 'granted'
  calls: Call[] = []
  /** Wird vor jedem Befehl aufgerufen; wirft, um Fehler zu simulieren. */
  fail: ((command: string, payload: Record<string, unknown>) => void) | null = null

  add(gid: number, body: string | null, over: Partial<FakeRow> = {}): FakeRow {
    const rowid = Math.max(0, ...this.rows.map((r) => r.rowid)) + 1
    const row: FakeRow = { rowid, gid, mailbox: 1, subject: `Subject ${gid}`, from: 'anna@example.com', body, ...over }
    this.rows.push(row)
    return row
  }

  policy = (): Promise<Policy> => Promise.resolve({ allowedMailboxIds: [...this.allowed] } as Policy)

  private visible(allowed: number[]): FakeRow[] {
    return this.rows.filter((r) => !r.deleted && allowed.includes(r.mailbox))
  }

  private messageRow(r: FakeRow) {
    return {
      gid: r.gid, messageIdHeader: null, subject: r.subject, sender: { address: r.from, name: null }, recipients: [], recipientCount: 0,
      dateReceived: 1768000000 + r.gid, dateSent: null, mailboxIds: [r.mailbox], read: true, flagged: false, attachmentNames: [],
      conversationId: null, file: r.body === null ? 'none' : 'full',
    }
  }

  runner: HelperRunner = {
    run: (command, payload) => {
      this.calls.push({ command, payload })
      try {
        this.fail?.(command, payload)
        return Promise.resolve(this.answer(command, payload))
      } catch (e) {
        return Promise.reject(e)
      }
    },
  }

  callsOf(command: string): Call[] {
    return this.calls.filter((c) => c.command === command)
  }

  private answer(command: string, p: Record<string, unknown>): unknown {
    const allowed = p.allowedMailboxIds as number[]
    switch (command) {
      case 'probe':
        return {
          osVersion: '0.0.0', mailDir: '/Users/x/Library/Mail/V10', access: this.access,
          schema: { compatible: true, missing: [], fingerprint: this.fingerprint },
          accountNames: { status: 'available', unmatchedAccounts: 0 },
        }
      case 'index-feed': {
        const after = p.afterRowid as number
        const limit = p.limit as number
        const all = this.visible(allowed).filter((r) => r.rowid > after).sort((a, b) => a.rowid - b.rowid)
        return {
          rows: all.slice(0, limit).map((r) => ({ rowid: r.rowid, gid: r.gid, date: 1768000000 + r.gid })),
          maxRowid: Math.max(0, ...this.rows.map((r) => r.rowid)),
          hasMore: all.length > limit,
        }
      }
      case 'index-gids': {
        const after = p.afterGid as number
        const limit = p.limit as number
        const by = new Map<number, boolean>()
        for (const r of this.visible(allowed)) by.set(r.gid, (by.get(r.gid) ?? false) || r.body !== null)
        const gids = [...by].filter(([g]) => g > after).sort((a, b) => a[0] - b[0])
        return { gids: gids.slice(0, limit), hasMore: gids.length > limit }
      }
      case 'get-messages': {
        const vis = this.visible(allowed)
        const messages = []
        const missing = []
        for (const g of p.gids as number[]) {
          const r = vis.find((x) => x.gid === g)
          if (r === undefined) missing.push(g)
          else messages.push({ ...this.messageRow(r), raw: r.body === null ? null : emlx(r.body, r.subject), rawSize: 0, rawTruncated: false })
        }
        return { messages, missing, budgetExhausted: false }
      }
      case 'list-mailboxes': {
        const ids = [...new Set([1, ...this.rows.map((r) => r.mailbox)])].sort((a, b) => a - b)
        return {
          mailboxes: ids.map((id) => ({ id, url: id === 1 ? 'imap://ACC1/INBOX' : `imap://ACC1/Folder${id}`, total: 0, unread: 0 })),
          accounts: [{ uuid: 'ACC1', description: 'Privat', username: 'a@example.com' }],
          accountNames: 'available',
        }
      }
      case 'search': {
        // Wie der Helper: optional nur diese gids, Reihenfolge (date DESC, gid DESC), Keyset `after`, limit.
        const want = p.gids === undefined ? null : new Set(p.gids as number[])
        const after = p.after as { date: number; gid: number } | undefined
        const seen = new Set<number>()
        const rows = []
        for (const r of this.visible(allowed)) {
          if ((want !== null && !want.has(r.gid)) || seen.has(r.gid)) continue
          seen.add(r.gid)
          rows.push(this.messageRow(r))
        }
        rows.sort((a, b) => b.dateReceived - a.dateReceived || b.gid - a.gid)
        const page = rows.filter((m) => after === undefined || m.dateReceived < after.date || (m.dateReceived === after.date && m.gid < after.gid))
        const limit = p.limit as number
        return { messages: page.slice(0, limit), hasMore: page.length > limit }
      }
      default:
        throw new Error(`unexpected ${command}`)
    }
  }
}
