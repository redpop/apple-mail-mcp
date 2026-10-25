#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio'
import { loadConfig } from './config.js'
import { createContext } from './context.js'
import { createHelperRunner, type HelperRunner } from './helper.js'
import { createServer } from './server.js'

// Task 16 ersetzt setup/doctor. Auf stdout darf im Servermodus nur das Protokoll stehen.
const arg = process.argv[2]
if (arg === 'setup' || arg === 'doctor') {
  process.stderr.write(`apple-mail-mcp ${arg}: not implemented yet\n`)
  process.exit(2)
}

const configResult = loadConfig(process.env)
let runner: HelperRunner & { stop(): void; bundlePath: string }
if (configResult.ok) {
  runner = createHelperRunner(configResult.config)
} else {
  // Ungueltige Konfiguration: Server startet trotzdem, jeder Aufruf scheitert vorher mit CONFIG_INVALID.
  runner = { bundlePath: '', run: () => Promise.reject(new Error('unreachable')), stop: () => {} }
}

const ctx = createContext({ runner, configResult, bundlePath: runner.bundlePath })
const server = createServer(ctx)

// Bei einem Signal raeumt Node die Pipes nicht auf; ohne stop() bliebe der Helper verwaist.
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    runner.stop()
    process.exit(0)
  })
}

await server.connect(new StdioServerTransport())
