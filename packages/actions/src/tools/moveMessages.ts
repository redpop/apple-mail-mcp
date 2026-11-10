import type { McpServer } from '@modelcontextprotocol/server'
import { z } from 'zod/v4'
import { respond } from '@redpop/apple-mail-mcp/dist/tools/respond.js'
import type { ActionsContext } from '../context.js'
import { ActionsError, describeActionsError } from '../errors.js'
import { moveMessages } from '../mover.js'
import type { MoveStatus } from '../rules.js'

const Id = z.string().regex(/^\d+$/)

const Input = z
  .object({
    moves: z
      .array(z.object({ id: Id, targetMailboxId: Id, sourceMailboxId: Id.optional() }).strict())
      .min(1),
  })
  .strict()

// Jeder MoveStatus aus rules.ts; der Typ-Check unten faellt auf, wenn einer fehlt oder dazukommt.
const STATUSES = [
  'moved', 'moved_unverified', 'failed', 'skipped_ambiguous', 'skipped_target_not_allowed', 'skipped_source_not_visible',
  'skipped_other_account', 'skipped_same_folder', 'skipped_unsupported_account', 'skipped_unsupported_folder',
  'skipped_security_mail', 'skipped_locked', 'skipped_no_message_id', 'skipped_not_found', 'skipped_mismatch', 'skipped_aborted',
] as const
type Missing = Exclude<MoveStatus, (typeof STATUSES)[number]>
const _complete: [Missing] extends [never] ? true : never = true
void _complete

const Output = z.object({
  results: z.array(z.object({ id: z.string(), status: z.enum(STATUSES) })),
  note: z.string(),
})

export function registerMoveMessages(server: McpServer, ctx: ActionsContext): void {
  server.registerTool(
    'move_messages',
    {
      description:
        'Moves messages to another mailbox of the same account in Apple Mail. Each entry names a message id and a target mailbox id; sourceMailboxId picks the copy when a message is visible in several mailboxes. Returns one status per message.',
      inputSchema: Input,
      outputSchema: Output,
      annotations: { title: 'Move messages', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async (input) => {
      // respond() des Lesepakets macht alles ausser HelperError zu UNKNOWN. ActionsError wird deshalb
      // innen abgefangen und danach als Text mit eigener Meldung ausgegeben.
      const failure: { error: ActionsError | null } = { error: null }
      const result = await respond(async () => {
        try {
          const out = await moveMessages({ helper: ctx.helper, actions: ctx.actions, locks: ctx.locks, config: ctx.config() }, input.moves)
          return { structured: Output.parse(out) }
        } catch (e) {
          if (!(e instanceof ActionsError)) throw e
          failure.error = e
          return { structured: {} }
        }
      }, ctx.respondContext)
      if (failure.error) return { content: [{ type: 'text' as const, text: describeActionsError(failure.error.code) }], isError: true }
      return result
    },
  )
}
