import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { HelperError } from './errors.js'
import type { HelperRunner } from './helper.js'
import { helloResult } from './schemas.js'

/** Protokollversion, die dieser Node-Teil spricht (Spec 7.3 hello). */
export const PROTOCOL_VERSION = 1
/** Laengste erlaubte Antwortzeile (Spec 7.1). */
export const MAX_LINE_BYTES = 32 * 1024 * 1024

/**
 * Fristen (Spec 7.2). Die erste Anfrage nach dem Start (hello) bekommt mehr Zeit
 * (kalter Cache, erstes Oeffnen einer grossen Datenbank); es gibt keinen Systemdialog.
 */
export interface StdioTimeouts {
  firstRequestMs: number
  requestMs: number
}

export const DEFAULT_TIMEOUTS: StdioTimeouts = { firstRequestMs: 15_000, requestMs: 10_000 }

export interface StdioHelperRunner extends HelperRunner {
  /** Beendet den Helper und lehnt alles Offene ab. */
  stop(): void
}

interface PendingRequest {
  id: number
  isHello: boolean
  resolve: (value: unknown) => void
  reject: (error: HelperError) => void
  timer: ReturnType<typeof setTimeout>
}

interface HelperResponse {
  id?: unknown
  ok?: unknown
  result?: unknown
  error?: { code?: string; message?: string }
}

interface Live {
  proc: ChildProcess
  /** Erfuellt, sobald hello mit passender Protokollversion beantwortet ist. */
  ready: Promise<void>
}

/**
 * Haelt `mail-helper serve` als langlebigen Kindprozess und spricht NDJSON ueber
 * stdin/stdout. Nach jedem Start geht zuerst `hello` raus; passt die Protokollversion
 * nicht, wird der Prozess verworfen und alles Offene mit HELPER_VERSION_MISMATCH abgelehnt.
 * Der Helper arbeitet sequenziell; die id macht eine Desynchronisation laut statt still.
 */
export function createStdioRunner(
  executable: string,
  timeouts: StdioTimeouts = DEFAULT_TIMEOUTS,
): StdioHelperRunner {
  let live: Live | undefined
  let buffer = ''
  let nextId = 1
  /** Hat der aktuelle Prozess schon eine echte (nicht-hello) Anfrage beantwortet? Steuert die Frist. */
  let isWarm = false
  /** Timeouts in Folge auf einem warmen Helper; zwei davon heissen: haengt, neu starten. */
  let consecutiveTimeouts = 0
  const MAX_CONSECUTIVE_TIMEOUTS = 2
  const pending: PendingRequest[] = []

  function rejectAllPending(error: HelperError): void {
    while (pending.length > 0) {
      const entry = pending.shift()
      if (entry === undefined) continue
      clearTimeout(entry.timer)
      entry.reject(error)
    }
  }

  /** Verwirft den Prozess; der naechste Aufruf startet von selbst einen frischen. */
  function discardChild(error: HelperError): void {
    const previous = live?.proc
    live = undefined
    buffer = ''
    isWarm = false
    consecutiveTimeouts = 0
    rejectAllPending(error)
    if (previous !== undefined) {
      previous.removeAllListeners()
      previous.stdout?.removeAllListeners()
      previous.stdin?.end()
      previous.kill()
    }
  }

  function handleLine(line: string): void {
    let parsed: HelperResponse
    try {
      parsed = JSON.parse(line) as HelperResponse
    } catch {
      // Unlesbare Zeile: die Leitung ist nicht mehr vertrauenswuerdig, also alles ablehnen und neu anfangen.
      discardChild(new HelperError('HELPER_CRASHED', 'Unreadable response from the helper.'))
      return
    }

    const index = typeof parsed.id === 'number' ? pending.findIndex((entry) => entry.id === parsed.id) : 0
    if (index === -1 || pending.length === 0) return // Antwort auf etwas, das nicht mehr offen ist (z. B. nach Timeout).

    const entry = pending.splice(index, 1)[0]
    if (entry === undefined) return
    clearTimeout(entry.timer)
    if (!entry.isHello) {
      isWarm = true
      consecutiveTimeouts = 0
    }

    if (parsed.ok === true) {
      entry.resolve(parsed.result)
      return
    }
    entry.reject(new HelperError(parsed.error?.code ?? 'HELPER_CRASHED', parsed.error?.message ?? 'Unknown error'))
  }

  function onData(chunk: string): void {
    buffer += chunk
    let newlineIndex = buffer.indexOf('\n')
    while (newlineIndex !== -1) {
      const line = buffer.slice(0, newlineIndex)
      buffer = buffer.slice(newlineIndex + 1)
      if (Buffer.byteLength(line, 'utf8') > MAX_LINE_BYTES) {
        discardChild(new HelperError('HELPER_CRASHED', 'response too large'))
        return
      }
      const trimmed = line.trim()
      if (trimmed.length > 0) {
        const before = live
        handleLine(trimmed)
        if (live !== before) return // handleLine hat den Prozess verworfen.
      }
      newlineIndex = buffer.indexOf('\n')
    }
    // Zeichen sind hoechstens so gross wie Bytes: diese Schranke greift sicher, nie zu frueh.
    if (buffer.length > MAX_LINE_BYTES) discardChild(new HelperError('HELPER_CRASHED', 'response too large'))
  }

  /** Schickt eine Anfrage an den aktuellen Prozess und setzt die Frist. */
  function send(proc: ChildProcess, command: string, payload: Record<string, unknown>, timeoutMs: number, isHello: boolean): Promise<unknown> {
    return new Promise<unknown>((resolve, reject) => {
      const id = nextId++
      const entry: PendingRequest = {
        id,
        isHello,
        resolve,
        reject,
        timer: setTimeout(() => {
          const index = pending.findIndex((candidate) => candidate.id === id)
          if (index !== -1) pending.splice(index, 1)
          const timeout = new HelperError('HELPER_TIMEOUT', `No response from the helper within ${String(timeoutMs)}ms.`)
          if (isHello) {
            discardChild(timeout)
            return
          }
          if (isWarm) {
            consecutiveTimeouts += 1
            if (consecutiveTimeouts >= MAX_CONSECUTIVE_TIMEOUTS) {
              discardChild(new HelperError('HELPER_TIMEOUT', 'The helper stopped responding and was restarted.'))
            }
          }
          reject(timeout)
        }, timeoutMs),
      }
      pending.push(entry)
      proc.stdin?.write(`${JSON.stringify({ id, command, payload })}\n`)
    })
  }

  function ensureChild(): Live {
    if (live !== undefined) return live

    // stderr geht unveraendert an den Elternprozess (Diagnose des Helpers).
    const proc = spawn(executable, ['serve'], { stdio: ['pipe', 'pipe', 'inherit'] })
    isWarm = false
    buffer = ''

    proc.stdout?.setEncoding('utf8')
    proc.stdout?.on('data', onData)
    // EPIPE auf stdin darf den Server nicht mitreissen; 'exit' entscheidet ueber Offenes.
    proc.stdin?.on('error', () => {})
    proc.on('error', (error: NodeJS.ErrnoException) => {
      discardChild(new HelperError(error.code === 'ENOENT' ? 'HELPER_MISSING' : 'HELPER_CRASHED', error.message))
    })
    proc.on('exit', (code, signal) => {
      const reason = signal !== null ? `signal ${signal}` : `exit code ${String(code)}`
      discardChild(new HelperError('HELPER_CRASHED', `The helper exited (${reason}).`))
    })

    const ready = send(proc, 'hello', {}, timeouts.firstRequestMs, true).then((result) => {
      const hello = helloResult.safeParse(result)
      if (!hello.success || hello.data.protocolVersion !== PROTOCOL_VERSION) {
        const error = new HelperError('HELPER_VERSION_MISMATCH', 'The helper speaks a different protocol version.')
        discardChild(error)
        throw error
      }
    })
    ready.catch(() => {}) // Fehler erreichen den Aufrufer ueber run(); hier nur unbehandelte Rejection vermeiden.
    live = { proc, ready }
    return live
  }

  return {
    async run(command, payload) {
      if (!existsSync(executable)) throw new HelperError('HELPER_MISSING', executable)
      const current = ensureChild()
      await current.ready
      if (live !== current) throw new HelperError('HELPER_CRASHED', 'The helper stopped before the request could be sent.')
      return send(current.proc, command, payload, isWarm ? timeouts.requestMs : timeouts.firstRequestMs, false)
    },

    stop() {
      discardChild(new HelperError('HELPER_CRASHED', 'The helper was shut down.'))
    },
  }
}
