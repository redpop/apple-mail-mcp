import type { McpServer } from '@modelcontextprotocol/server'
import { z } from 'zod/v4'
import type { ToolContext } from '../context.js'
import { HelperError } from '../errors.js'
import { formatLocal } from '../dates.js'
import { parseMessage, truncateText } from '../mime.js'
import { stripQuotes } from '../quotes.js'
import { getMessagesResult } from '../schemas.js'
import { classify, redactSubject } from '../securityMail.js'
import { MessageSummary, toSummary } from '../summary.js'
import { respond } from './respond.js'

const MAX_RECIPIENTS = 100

const Input = z
  .object({
    id: z.string().regex(/^\d+$/),
    maxChars: z.number().int().min(500).max(100_000).default(20_000),
    stripQuoted: z.boolean().default(false),
  })
  .strict()

const Address = z.object({ address: z.string(), name: z.string().nullable() })

const Output = MessageSummary.omit({ matchContext: true }).extend({
  replyTo: z.array(Address),
  dateSent: z.string().nullable(),
  body: z
    .object({
      text: z.string(),
      format: z.enum(['plain', 'html']),
      truncated: z.boolean(),
      totalChars: z.number().int(),
      quotedRemoved: z.boolean(),
    })
    .nullable(),
  bodyAvailable: z.boolean(),
  bodyUnavailableReason: z.enum(['not_downloaded', 'file_not_found', 'withheld_security', 'parse_failed']).nullable(),
  attachments: z.array(z.object({ name: z.string(), downloaded: z.boolean() })),
  note: z.string().optional(),
})

export function registerGetMessage(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    'get_message',
    {
      description: 'Returns one message with its headers, attachment names and body text, as plain text with quoted replies optionally removed. Changes nothing.',
      inputSchema: Input,
      outputSchema: Output,
      annotations: { title: 'Get message', readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async (input) =>
      respond(async () => {
        const config = ctx.config()
        const policy = await ctx.policy()
        if (policy.allowedMailboxIds.length === 0) throw new HelperError('MESSAGE_NOT_FOUND', '')
        const gid = Number(input.id)
        // Jenseits von 2^53 waere die Zahl gerundet und traefe womoeglich eine andere Mail: nie an den Helper.
        if (!Number.isSafeInteger(gid)) throw new HelperError('MESSAGE_NOT_FOUND', '')
        const raw = getMessagesResult.parse(
          await ctx.runner.run('get-messages', {
            allowedMailboxIds: policy.allowedMailboxIds,
            gids: [gid],
            maxBytesPerMessage: 8 * 1024 * 1024,
            maxBytesTotal: 16 * 1024 * 1024,
          }),
        )
        const row = raw.messages.find((m) => m.gid === gid)
        if (!row || raw.missing.includes(gid)) throw new HelperError('MESSAGE_NOT_FOUND', '')

        const summary = toSummary(row, policy, config, MAX_RECIPIENTS)
        const { matchContext: _m, ...base } = summary
        const exchange = row.mailboxIds.some((id) => policy.mailboxes.get(id)?.type === 'exchange')
        const attachments = row.attachmentNames.map((name) => ({ name, downloaded: row.file === 'full' }))

        type Reason = 'not_downloaded' | 'file_not_found' | 'withheld_security' | 'parse_failed'
        const result: Record<string, unknown> = {
          ...base,
          replyTo: [],
          dateSent: row.dateSent === null ? null : formatLocal(row.dateSent),
          body: null,
          bodyAvailable: false,
          bodyUnavailableReason: null,
          attachments,
        }
        const unavailable = (reason: Reason, extra: Record<string, unknown> = {}) =>
          ({ structured: Output.parse({ ...result, bodyUnavailableReason: reason, ...extra }) })

        if (row.raw === null && exchange) return unavailable('file_not_found')
        if (row.file === 'none') return unavailable('not_downloaded')
        if (row.raw === null) return unavailable('file_not_found')

        const parsed = await parseMessage(Buffer.from(row.raw, 'base64'))
        if (!parsed.ok) return unavailable('parse_failed')

        result.to = parsed.headers.to.slice(0, MAX_RECIPIENTS)
        result.cc = parsed.headers.cc.slice(0, MAX_RECIPIENTS)
        result.replyTo = parsed.headers.replyTo.slice(0, MAX_RECIPIENTS)

        const verdict = classify({ subject: row.subject, fromAddress: summary.from?.address ?? null, text: parsed.text })
        if (verdict.security && !config.showSecurityMails) {
          return unavailable('withheld_security', {
            subject: redactSubject(row.subject),
            subjectRedacted: true,
            note: 'The body of this message was withheld because it looks like a security message (code, password reset or sign-in). The configuration decides this; tool parameters cannot change it.',
          })
        }

        let text = parsed.text
        let quotedRemoved = false
        if (input.stripQuoted) {
          const s = stripQuotes(text)
          text = s.text
          quotedRemoved = s.removed
        }
        const cut = truncateText(text, Math.min(input.maxChars, config.maxBodyChars))
        return {
          structured: Output.parse({
            ...result,
            body: { text: cut.text, format: parsed.format, truncated: cut.truncated, totalChars: cut.totalChars, quotedRemoved },
            bodyAvailable: true,
            ...(row.rawTruncated ? { note: 'The message file is larger than the read limit, so the body may end early.' } : {}),
          }),
        }
      }, ctx),
  )
}
