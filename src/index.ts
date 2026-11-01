#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio'
import type { Indexer } from './bodyIndex/indexer.js'
import { startBodyIndex } from './bodyIndex/lifecycle.js'
import { loadConfig } from './config.js'
import { createContext } from './context.js'
import { createHelperRunner, type HelperRunner } from './helper.js'
import { createServer } from './server.js'

// Auf stdout darf im Servermodus nur das Protokoll stehen; setup/doctor sind eigene Kommandozeilenmodi.
const arg = process.argv[2]
if (arg === 'setup' || arg === 'doctor') {
  const { runCli } = await import('./cli/main.js')
  process.exit(await runCli(arg, process.argv.slice(3)))
}

const configResult = loadConfig(process.env)
let runner: HelperRunner & { stop(): void; bundlePath: string }
if (configResult.ok) {
  runner = createHelperRunner(configResult.config)
} else {
  // Ungueltige Konfiguration: Server startet trotzdem, jeder Aufruf scheitert vorher mit CONFIG_INVALID.
  runner = { bundlePath: '', run: () => Promise.reject(new Error('unreachable')), stop: () => {} }
}

// Body-Index (opt-in): startet erst nach dem ersten erfolgreichen Helper-Aufruf eines Tools, damit ohne
// FDA nichts passiert. Er benutzt den Runner direkt; nur Tool-Aufrufe melden sich ueber notify().
let indexer: Indexer | null = null
let accessSeen = false
const toolRunner: HelperRunner = {
  async run(command, payload) {
    const out = await runner.run(command, payload)
    accessSeen = true
    indexer?.notify()
    return out
  },
  helperVersion: () => runner.helperVersion?.() ?? null,
}

const ctx = createContext({ runner: toolRunner, configResult, bundlePath: runner.bundlePath, bodyIndex: () => indexer })
const server = createServer(ctx)

void startBodyIndex({ configResult, runner, policy: () => ctx.policy() }).then((i) => {
  indexer = i
  if (accessSeen) indexer?.notify()
})

const shutdown = (): void => {
  indexer?.stop()
  runner.stop()
}

// Bei einem Signal raeumt Node die Pipes nicht auf; ohne stop() bliebe der Helper verwaist.
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    shutdown()
    process.exit(0)
  })
}

// EOF auf stdin schliesst den Transport; dann darf der Helper-Kindprozess nicht ueberleben.
server.server.onclose = () => {
  shutdown()
  process.exit(0)
}

await server.connect(new StdioServerTransport())
