import type { McpServer } from '@modelcontextprotocol/server'
import { z } from 'zod/v4'
import { respond } from '@redpop/apple-mail-mcp/dist/tools/respond.js'
import type { ActionsContext } from '../context.js'
import { ActionsError, describeActionsError } from '../errors.js'
import type { SaveStatus } from '../rules.js'
import { saveAttachment } from '../saver.js'

const Id = z.string().regex(/^\d+$/)

const Input = z.object({ id: Id, attachment: z.number().int().min(0).max(19), sourceMailboxId: Id.optional() }).strict()

// Jeder SaveStatus aus rules.ts; der Typ-Check unten faellt auf, wenn einer fehlt oder dazukommt.
const SAVE_STATUSES = [
  'saved', 'failed', 'skipped_security_mail', 'skipped_type_not_allowed', 'skipped_too_large', 'skipped_not_found',
  'skipped_attachment_not_found', 'skipped_mismatch', 'skipped_source_not_visible', 'skipped_ambiguous',
  'skipped_unsupported_account', 'skipped_unsupported_folder', 'skipped_no_message_id',
] as const
type Missing = Exclude<SaveStatus, (typeof SAVE_STATUSES)[number]>
const _complete: [Missing] extends [never] ? true : never = true
void _complete

const Output = z.object({
  status: z.enum(SAVE_STATUSES),
  path: z.string().optional(),
  name: z.string().optional(),
  bytes: z.number().optional(),
})

export function registerSaveAttachment(server: McpServer, ctx: ActionsContext): void {
  server.registerTool(
    'save_attachment',
    {
      description:
        'Saves one attachment of a message to a fixed handover folder, downloading it through Mail if needed, and returns the file path. attachment is the zero-based position in attachmentNames of get_message.',
      inputSchema: Input,
      outputSchema: Output,
      annotations: { title: 'Save attachment', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async (input) => {
      // Wie bei move_messages: ActionsError innen abfangen, damit respond() ihn nicht zu UNKNOWN macht.
      const failure: { error: ActionsError | null } = { error: null }
      const result = await respond(async () => {
        try {
          const out = await saveAttachment({ helper: ctx.helper, actions: ctx.actions, config: ctx.config() }, input)
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
