import type { McpServer } from '@modelcontextprotocol/server'
import { z } from 'zod/v4'
import type { ToolContext } from '../context.js'
import { HelperError } from '../errors.js'
import { threadResult } from '../schemas.js'
import { MessageSummary, toSummary } from '../summary.js'
import { respond } from './respond.js'

const Input = z
  .object({
    id: z.string().regex(/^\d+$/),
    limit: z.number().int().min(1).max(100).default(50),
  })
  .strict()

const Output = z.object({
  threadId: z.string().nullable(),
  messages: z.array(MessageSummary),
  hasMore: z.boolean(),
  note: z.string().optional(),
})

export function registerGetThread(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    'get_thread',
    {
      description: 'Returns summaries of the messages in the conversation that contains the given message (up to the limit, oldest first), without bodies. Changes nothing.',
      inputSchema: Input,
      outputSchema: Output,
      annotations: { title: 'Get thread', readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async (input) =>
      respond(async () => {
        const config = ctx.config()
        const policy = await ctx.policy()
        if (policy.allowedMailboxIds.length === 0) throw new HelperError('MESSAGE_NOT_FOUND', '')
        const gid = Number(input.id)
        // Jenseits von 2^53 waere die Zahl gerundet und traefe womoeglich eine andere Mail: nie an den Helper.
        if (!Number.isSafeInteger(gid)) throw new HelperError('MESSAGE_NOT_FOUND', '')
        const raw = threadResult.parse(
          await ctx.runner.run('thread', {
            allowedMailboxIds: policy.allowedMailboxIds,
            gid,
            limit: input.limit,
            maxRecipients: 5,
          }),
        )
        const note = raw.hasMore
          ? `This thread has more messages than the limit. The oldest ${input.limit} messages are shown; use get_message on a listed id for details.`
          : undefined
        return {
          structured: Output.parse({
            threadId: raw.conversationId ? String(raw.conversationId) : null,
            messages: raw.messages.map((r) => toSummary(r, policy, config, 5)),
            hasMore: raw.hasMore,
            ...(note ? { note } : {}),
          }),
        }
      }, ctx),
  )
}
