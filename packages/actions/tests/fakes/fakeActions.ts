import type { HelperRunner } from '@redpop/apple-mail-mcp/dist/helper.js'
import { HelperError } from '@redpop/apple-mail-mcp/dist/errors.js'
import { parseMailbox } from '@redpop/apple-mail-mcp/dist/mailboxes.js'
import type { ListMailboxesResult, LocateResult } from '@redpop/apple-mail-mcp/dist/schemas.js'

export type LocatedMessage = LocateResult['messages'][number]

export const WORK = 'AAAAAAAA-0000-4000-8000-000000000001'
export const HOME = 'AAAAAAAA-0000-4000-8000-000000000002'

export const INBOX = 1
export const ARCHIVE = 2
export const NESTED = 3
export const SENT = 4
export const DRAFTS = 5
export const JUNK = 6
export const TRASH = 7
export const PRIVATE = 8
export const HOME_INBOX = 20

const mb = (id: number, url: string): ListMailboxesResult['mailboxes'][number] => ({ id, url, total: 1, unread: 0 })

/** Ein unterstuetztes IMAP-Konto Work mit allen Rollen und ein zweites unterstuetztes Konto Home. */
export function rawMailboxes(): ListMailboxesResult {
  return {
    mailboxes: [
      mb(INBOX, `imap://${WORK}/INBOX`),
      mb(ARCHIVE, `imap://${WORK}/Archive`),
      mb(NESTED, `imap://${WORK}/Projects/Alpha`),
      mb(SENT, `imap://${WORK}/Sent`),
      mb(DRAFTS, `imap://${WORK}/Drafts`),
      mb(JUNK, `imap://${WORK}/Junk`),
      mb(TRASH, `imap://${WORK}/Trash`),
      mb(PRIVATE, `imap://${WORK}/Private`),
      mb(HOME_INBOX, `imap://${HOME}/INBOX`),
    ],
    accounts: [
      { uuid: WORK, description: 'Work', username: 'user@example.com' },
      { uuid: HOME, description: 'Home', username: 'user@example.org' },
    ],
    accountStores: [],
    accountNames: 'available',
    dueReminders: [],
  }
}

export function message(gid: number, copies: { rowid: number; mailboxId: number }[] = [{ rowid: gid + 1000, mailboxId: INBOX }], over: Partial<LocatedMessage> = {}): LocatedMessage {
  return { gid, messageIdHeader: `<${gid}@example.com>`, subject: 'Invoice for October', fromAddress: 'sender@example.net', copies, ...over }
}

type MoveOutcome = { outcome: string; code?: number } | { error: Error }

/**
 * Helper und Actions-Bundle als gemeinsame kleine Welt: ein erfolgreiches `move` aendert, was `locate`
 * danach zeigt, sofern `applyMoves` an ist. Zeichnet alle Aufrufe auf und merkt sich Ueberlappungen.
 */
export class FakeMail {
  raw: ListMailboxesResult = rawMailboxes()
  messages = new Map<number, LocatedMessage>()
  /** Antwort je rowid; ohne Eintrag `moved`. */
  outcomes = new Map<number, MoveOutcome>()
  applyMoves = true
  permission: unknown = { status: 'granted' }
  permissionError: Error | null = null
  /** Wirft beim n-ten locate-Aufruf (1-basiert). */
  locateErrorFrom: number | null = null

  helperCalls: { command: string; payload: Record<string, unknown> }[] = []
  actionCalls: { command: string; payload: Record<string, unknown> }[] = []
  order: string[] = []
  active = 0
  maxActive = 0
  private nextRowid = 900_000

  constructor(messages: LocatedMessage[] = []) {
    for (const m of messages) this.messages.set(m.gid, m)
  }

  get moveCalls(): Record<string, unknown>[] {
    return this.actionCalls.filter((c) => c.command === 'move').map((c) => c.payload)
  }

  get locateCalls(): Record<string, unknown>[] {
    return this.helperCalls.filter((c) => c.command === 'locate').map((c) => c.payload)
  }

  readonly helper: HelperRunner = {
    run: async (command, payload) => {
      this.helperCalls.push({ command, payload })
      this.order.push(command)
      if (command === 'list-mailboxes') return this.raw
      if (command === 'locate') {
        if (this.locateErrorFrom !== null && this.locateCalls.length >= this.locateErrorFrom) throw new HelperError('DATABASE_BUSY', 'busy')
        const allowed = new Set(payload.allowedMailboxIds as number[])
        const messages = (payload.gids as number[]).flatMap((gid) => {
          const m = this.messages.get(gid)
          if (!m) return []
          return [{ ...m, copies: m.copies.filter((c) => allowed.has(c.mailboxId)) }]
        })
        return { messages }
      }
      throw new Error(`unexpected helper command ${command}`)
    },
  }

  readonly actions: HelperRunner = {
    run: async (command, payload) => {
      this.actionCalls.push({ command, payload })
      this.order.push(command)
      if (command === 'permission') {
        if (this.permissionError) throw this.permissionError
        return this.permission
      }
      if (command !== 'move') throw new Error(`unexpected actions command ${command}`)
      this.active++
      this.maxActive = Math.max(this.maxActive, this.active)
      await new Promise((r) => setImmediate(r))
      this.active--
      const planned = this.outcomes.get(payload.rowid as number) ?? { outcome: 'moved' }
      if ('error' in planned) throw planned.error
      if (planned.outcome === 'moved' && this.applyMoves) this.apply(payload)
      return planned
    },
  }

  // Die Mail wandert in den Zielordner und bekommt wie in Mail eine neue ROWID.
  private apply(payload: Record<string, unknown>): void {
    const target = this.raw.mailboxes.map(parseMailbox).find((m) => m.path.join('/') === payload.target)
    for (const m of this.messages.values()) {
      const i = m.copies.findIndex((c) => c.rowid === payload.rowid)
      if (i >= 0 && target) m.copies[i] = { rowid: this.nextRowid++, mailboxId: target.id }
    }
  }
}
