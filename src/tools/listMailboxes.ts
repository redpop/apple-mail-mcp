import type { McpServer } from '@modelcontextprotocol/server'
import { z } from 'zod/v4'
import type { ToolContext } from '../context.js'
import { respond } from './respond.js'

const Input = z.object({}).strict()

const Output = z.object({
  accounts: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      address: z.string().nullable(),
      type: z.enum(['imap', 'local', 'exchange', 'other']),
      mailboxes: z.array(
        z.object({
          id: z.string(),
          name: z.string(),
          path: z.string(),
          role: z.enum(['inbox', 'sent', 'drafts', 'archive', 'junk', 'trash', 'allmail', 'other']),
          total: z.number().int(),
          unread: z.number().int(),
        }),
      ),
    }),
  ),
  note: z.string().optional(),
})

export function registerListMailboxes(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    'list_mailboxes',
    {
      description: 'Lists the mail accounts and mailboxes that are visible under the current settings, with message counts. Changes nothing.',
      inputSchema: Input,
      outputSchema: Output,
      annotations: { title: 'List mailboxes', readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async () =>
      respond(async () => {
        const policy = await ctx.policy(true)
        const accounts = policy.accounts.map((a) => ({
          id: a.id,
          name: a.name,
          address: a.address,
          type: a.type,
          mailboxes: [...policy.mailboxes.values()]
            .filter((m) => m.accountId === a.id)
            .map((m) => ({
              id: String(m.id),
              name: m.name,
              path: m.path.join('/'),
              role: m.role,
              total: m.total,
              unread: m.unread,
            })),
        }))
        const n = policy.unmatchedAllowlistEntries
        const note = n > 0 ? `${n} configured account${n === 1 ? '' : 's'} did not match any mail account.` : undefined
        return { structured: Output.parse({ accounts, ...(note ? { note } : {}) }) }
      }, ctx),
  )
}
