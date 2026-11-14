#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio'
import { createHelperRunner } from '@redpop/apple-mail-mcp/dist/helper.js'
import type { HelperRunner } from '@redpop/apple-mail-mcp/dist/helper.js'
import { createActionsRunner } from './bundle.js'
import { loadActionsConfig } from './config.js'
import { createActionsContext } from './context.js'
import { createServer } from './server.js'

// Auf stdout darf im Servermodus nur das Protokoll stehen; setup/doctor sind eigene Kommandozeilenmodi.
const arg = process.argv[2]
if (arg === 'setup' || arg === 'doctor') {
  const { runCli } = await import('./cli/main.js')
  process.exit(await runCli(arg, process.argv.slice(3)))
}

const configResult = loadActionsConfig(process.env)
type Stoppable = HelperRunner & { stop(): void; bundlePath: string }
const unreachable: Stoppable = { bundlePath: '', run: () => Promise.reject(new Error('unreachable')), stop: () => {} }
// Ungueltige Konfiguration: Server startet trotzdem, jeder Aufruf scheitert vorher mit CONFIG_INVALID.
const helper: Stoppable = configResult.ok ? createHelperRunner(configResult.config) : unreachable
const actions: Stoppable = configResult.ok ? createActionsRunner(configResult.config) : unreachable

const ctx = createActionsContext({ helper, actions, configResult, helperBundlePath: helper.bundlePath })
const server = createServer(ctx, { saveAttachments: configResult.ok && configResult.config.saveAttachments })

const shutdown = (): void => {
  helper.stop()
  actions.stop()
}

// Bei einem Signal raeumt Node die Pipes nicht auf; ohne stop() blieben die Kindprozesse verwaist.
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    shutdown()
    process.exit(0)
  })
}

// EOF auf stdin schliesst den Transport; dann duerfen die Kindprozesse nicht ueberleben.
server.server.onclose = () => {
  shutdown()
  process.exit(0)
}

await server.connect(new StdioServerTransport())
