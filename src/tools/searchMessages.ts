import type { McpServer } from '@modelcontextprotocol/server'
import { z } from 'zod/v4'
import type { ToolContext } from '../context.js'
import { scanBodies, type ScanInfo } from '../bodyScan.js'
import { decodeCursor, encodeCursor, queryHash } from '../cursor.js'
import { parseDateInput } from '../dates.js'
import { HelperError } from '../errors.js'
import { searchResult } from '../schemas.js'
import { MessageSummary, toSummary } from '../summary.js'
import { respond } from './respond.js'

const IsoDateOrDateTime = z.string().min(1).max(40)

const Input = z
  .object({
    query: z.string().min(1).max(200).optional(),
    from: z.string().min(1).max(200).optional(),
    to: z.string().min(1).max(200).optional(),
    subject: z.string().min(1).max(200).optional(),
    bodyContains: z.string().min(2).max(200).optional(),
    mailboxIds: z.array(z.string()).min(1).max(50).optional(),
    since: IsoDateOrDateTime.optional(),
    before: IsoDateOrDateTime.optional(),
    unread: z.boolean().optional(),
    flagged: z.boolean().optional(),
    hasAttachment: z.boolean().optional(),
    limit: z.number().int().min(1).max(100).default(20),
    cursor: z.string().optional(),
  })
  .strict()

const ScanInfoSchema = z.object({
  scanned: z.number().int(),
  unavailable: z.number().int(),
  stoppedBy: z.enum(['limit', 'cap', 'time']).nullable(),
  complete: z.boolean(),
})

const Output = z.object({
  messages: z.array(MessageSummary),
  totalMatched: z.number().int().optional(),
  totalMatchedCapped: z.boolean().optional(),
  nextCursor: z.string().nullable(),
  scan: ScanInfoSchema.optional(),
  note: z.string().optional(),
})

const fmt = (n: number): string => n.toLocaleString('en-US')

function scanNote(scan: ScanInfo, matches: number): string {
  const found = `${matches} ${matches === 1 ? 'match' : 'matches'}`
  const noBody = scan.unavailable > 0 ? ` ${fmt(scan.unavailable)} of them could not be searched because their body is not on this Mac or could not be read.` : ''
  if (scan.complete) return `Scanned all ${fmt(scan.scanned)} candidate messages and found ${found}.${noBody}`
  const why = { limit: 'the requested number of matches was reached', cap: 'the scan limit of 2,000 messages was reached', time: 'the 3 second time budget ran out' }[scan.stoppedBy!]
  return `Scanned the ${fmt(scan.scanned)} newest candidate messages and found ${found}; stopped because ${why}.${noBody} Call again with nextCursor to continue, or narrow the search with from, since or mailboxIds.`
}

function defined(o: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined))
}

export function registerSearchMessages(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    'search_messages',
    {
      description:
        'Searches mail by sender, recipient, subject, free text, mailbox, date range, unread, flagged and attachment state, newest first, and returns message summaries without bodies. Changes nothing.',
      inputSchema: Input,
      outputSchema: Output,
      annotations: { title: 'Search messages', readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async (input) =>
      respond(async () => {
        const config = ctx.config()
        if (input.bodyContains !== undefined && !config.bodySearch) {
          throw new HelperError('INVALID_INPUT', 'Body search is disabled: the user turned it off (APPLE_MAIL_BODY_SEARCH=false), so bodyContains cannot be used.')
        }
        const policy = await ctx.policy()

        let mailboxIds: number[] | undefined
        if (input.mailboxIds) {
          const allowed = new Set(policy.allowedMailboxIds)
          mailboxIds = input.mailboxIds.map((s) => (/^\d+$/.test(s) ? Number(s) : NaN))
          // Unbekannt, ausgeschlossen und unlesbar sehen gleich aus.
          if (mailboxIds.some((id) => !allowed.has(id))) throw new HelperError('MAILBOX_NOT_FOUND', '')
        }
        // Ohne sichtbare Mailbox gibt es nichts zu suchen; der Helper verlangt eine nicht leere Menge.
        if (policy.allowedMailboxIds.length === 0) {
          return {
            structured: Output.parse({
              messages: [],
              nextCursor: null,
              note: 'No mailbox is visible with the current configuration, so there is nothing to search. Call list_mailboxes to see what is visible.',
            }),
          }
        }
        const since = input.since !== undefined ? parseDateInput(input.since) : undefined
        const before = input.before !== undefined ? parseDateInput(input.before) : undefined
        const limit = Math.min(input.limit, config.maxResults)

        const filters = defined({
          query: input.query,
          from: input.from,
          to: input.to,
          subject: input.subject,
          mailboxIds: mailboxIds ? [...mailboxIds].sort((a, b) => a - b) : undefined,
          since,
          before,
          unread: input.unread,
          flagged: input.flagged,
          hasAttachment: input.hasAttachment,
        })
        // bodyContains gehoert in den Hash, damit ein Cursor nur zur selben Body-Suche passt.
        const hash = queryHash(input.bodyContains !== undefined ? { ...filters, bodyContains: input.bodyContains } : filters, policy.fingerprint)
        const after = input.cursor !== undefined ? decodeCursor(input.cursor, hash) : undefined

        if (input.bodyContains !== undefined) {
          const res = await scanBodies({
            runner: ctx.runner,
            policy,
            config,
            filters: defined({ ...filters, mailboxIds }),
            term: input.bodyContains,
            after: after ?? null,
            limit,
          })
          const messages = res.matches.map((m) => ({ ...toSummary(m.row, policy, config, 5), matchContext: m.matchContext }))
          return {
            structured: Output.parse({
              messages,
              nextCursor: res.resumeAfter ? encodeCursor(res.resumeAfter, hash) : null,
              scan: res.scan,
              note: scanNote(res.scan, messages.length),
            }),
          }
        }

        const raw = searchResult.parse(
          await ctx.runner.run('search', {
            allowedMailboxIds: policy.allowedMailboxIds,
            ...defined({ ...filters, mailboxIds }),
            ...(after ? { after: { date: after.d, gid: after.g } } : {}),
            limit,
            maxRecipients: 5,
            countTotal: true,
          }),
        )

        const messages = raw.messages.map((r) => toSummary(r, policy, config, 5))
        const last = raw.messages[raw.messages.length - 1]
        const nextCursor = raw.hasMore && last ? encodeCursor({ d: last.dateReceived, g: last.gid }, hash) : null
        let note: string | undefined
        if (raw.hasMore) {
          const total = raw.totalMatched
          const of = total === null || total === undefined ? '' : ` of ${raw.totalMatchedCapped ? 'more than ' : ''}${total}`
          note = `Showing ${messages.length}${of} matches. Use nextCursor for more, or narrow with from, since or mailboxIds.`
        }
        return {
          structured: Output.parse({
            messages,
            ...(raw.totalMatched != null ? { totalMatched: raw.totalMatched } : {}),
            ...(raw.totalMatchedCapped !== undefined ? { totalMatchedCapped: raw.totalMatchedCapped } : {}),
            nextCursor,
            ...(note ? { note } : {}),
          }),
        }
      }, ctx),
  )
}
