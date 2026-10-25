#!/usr/bin/env node
// Misst die Laufzeit der Helper-Befehle an der echten Ablage.
// Gibt nur Bezeichnung, Millisekunden und Zeilenzahlen aus, nie Inhalte.
//
// Aufruf (nach npm run build und npm run build:helper, Dev-Bundle mit FDA):
//   APPLE_MAIL_HELPER_PATH="$PWD/bin/Mail MCP Helper (Dev).app" node scripts/measure-latency.mjs [suchwort]
import { loadConfig } from '../dist/config.js'
import { createHelperRunner } from '../dist/helper.js'
import { computePolicy } from '../dist/policy.js'
import { scanBodies } from '../dist/bodyScan.js'

const term = process.argv[2] ?? 'rechnung'
const configResult = loadConfig(process.env)
if (!configResult.ok) {
  console.error(`Config invalid: ${configResult.key}`)
  process.exit(1)
}
const config = configResult.config
const runner = createHelperRunner(config)

function median(values) {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)]
}

async function time(label, fn, runs = 5) {
  const durations = []
  let rows = 0
  for (let i = 0; i < runs; i++) {
    const start = performance.now()
    rows = await fn()
    durations.push(performance.now() - start)
  }
  const first = durations[0].toFixed(0)
  console.log(`${label.padEnd(34)} first ${first.padStart(5)} ms  median ${median(durations).toFixed(0).padStart(5)} ms  rows ${rows}`)
}

try {
  const raw = await runner.run('list-mailboxes', {})
  const policy = computePolicy(config, raw)
  const allowed = policy.allowedMailboxIds
  const base = { allowedMailboxIds: allowed, limit: 20, maxRecipients: 5, countTotal: true }
  const search = (extra) => async () => (await runner.run('search', { ...base, ...extra })).messages.length

  await time('list-mailboxes', async () => (await runner.run('list-mailboxes', {})).mailboxes.length)
  await time('search, no filter', search({}))
  await time('search, no filter, no count', search({ countTotal: false }))
  await time('search, subject', search({ subject: term }))
  await time('search, from', search({ from: term }))
  await time('search, to', search({ to: term }))
  await time('search, query', search({ query: term }))
  await time('search, unread', search({ unread: true }))
  await time('search, hasAttachment', search({ hasAttachment: true }))

  const page = await runner.run('search', { ...base, countTotal: false })
  const gids = page.messages.map((m) => m.gid)
  await time('get-messages, 1 message', async () => {
    const r = await runner.run('get-messages', { allowedMailboxIds: allowed, gids: gids.slice(0, 1), maxBytesPerMessage: 8 * 1024 * 1024, maxBytesTotal: 16 * 1024 * 1024 })
    return r.messages.length
  })
  await time('get-messages, 20 messages', async () => {
    const r = await runner.run('get-messages', { allowedMailboxIds: allowed, gids, maxBytesPerMessage: 256 * 1024, maxBytesTotal: 16 * 1024 * 1024 })
    return r.messages.length
  })
  await time('thread', async () => (await runner.run('thread', { allowedMailboxIds: allowed, gid: gids[0], limit: 50, maxRecipients: 5 })).messages.length)

  const scanStart = performance.now()
  const scan = await scanBodies({ runner, policy, config, filters: {}, term, after: null, limit: 20 })
  const scanMs = performance.now() - scanStart
  console.log(`${'body scan'.padEnd(34)} ${scanMs.toFixed(0)} ms  matches ${scan.matches.length}  scanned ${scan.scan.scanned}  unavailable ${scan.scan.unavailable}  stoppedBy ${scan.scan.stoppedBy}`)
} catch (error) {
  console.error(`Failed: ${error?.code ?? error?.name ?? 'error'}`)
  process.exitCode = 1
} finally {
  runner.stop()
}
