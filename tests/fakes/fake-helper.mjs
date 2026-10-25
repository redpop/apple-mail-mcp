#!/usr/bin/env node
// Fake-Helper fuer stdioHelper.test.ts: eine JSON-Zeile rein, eine raus, id gespiegelt.
// Verhalten ueber Umgebungsvariablen: FAKE_PROTOCOL_VERSION, FAKE_LOG (Datei, eine Zeile je Kommando).
import { appendFileSync } from 'node:fs'

const protocolVersion = Number(process.env.FAKE_PROTOCOL_VERSION ?? '1')
const log = process.env.FAKE_LOG

let buffer = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  buffer += chunk
  let index = buffer.indexOf('\n')
  while (index !== -1) {
    const line = buffer.slice(0, index)
    buffer = buffer.slice(index + 1)
    handle(JSON.parse(line))
    index = buffer.indexOf('\n')
  }
})
process.stdin.on('end', () => process.exit(0))

function reply(object) {
  process.stdout.write(JSON.stringify(object) + '\n')
}

function handle(request) {
  const id = request.id
  if (log) appendFileSync(log, `${request.command}\n`)
  switch (request.command) {
    case 'hello':
      if (process.env.FAKE_HELLO_HANG) return
      reply({ id, ok: true, result: { protocolVersion, helperVersion: '0.1.0' } })
      return
    case 'echo-pid':
      reply({ id, ok: true, result: { pid: process.pid } })
      return
    case 'echo-payload':
      reply({ id, ok: true, result: request.payload })
      return
    case 'fail':
      reply({ id, ok: false, error: { code: 'MESSAGE_NOT_FOUND', message: 'weg' } })
      return
    case 'garbage':
      process.stdout.write('das ist kein JSON\n')
      return
    case 'crash':
      process.exit(3)
      return
    case 'hang':
      return
    case 'big':
      // Eine gueltige, aber grosse Antwortzeile (unter der 32-MiB-Grenze).
      reply({ id, ok: true, result: { s: 'x'.repeat(22 * 1024 * 1024) } })
      return
    case 'huge':
      process.stdout.write('x'.repeat(33 * 1024 * 1024) + '\n')
      return
    default:
      reply({ id, ok: false, error: { code: 'INVALID_INPUT', message: 'Unbekannt: ' + request.command } })
  }
}
