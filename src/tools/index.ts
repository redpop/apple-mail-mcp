import type { McpServer } from '@modelcontextprotocol/server'
import type { ToolContext } from '../context.js'
import { registerGetMessage } from './getMessage.js'
import { registerGetThread } from './getThread.js'
import { registerListMailboxes } from './listMailboxes.js'
import { registerSearchMessages } from './searchMessages.js'

export function registerTools(server: McpServer, ctx: ToolContext): void {
  registerListMailboxes(server, ctx)
  registerSearchMessages(server, ctx)
  registerGetMessage(server, ctx)
  registerGetThread(server, ctx)
}
