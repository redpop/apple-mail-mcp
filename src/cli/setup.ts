import type { Writable } from 'node:stream'
import { tildePath } from './doctor.js'
import { describeError, HelperError } from '../errors.js'
import { FDA_SETTINGS_URL, type OpenFn } from '../fdaPrompt.js'
import type { HelperRunner } from '../helper.js'
import { probeResult, type ProbeResult } from '../schemas.js'
import { recordAccessOk } from '../state.js'

export interface SetupDeps {
  runner: HelperRunner
  bundlePath: string
  open: OpenFn
  out: Writable
  isTTY: boolean
  sleep: (ms: number) => Promise<void>
  now: () => number
  /** Nur fuer Tests: wohin die Zustandsdatei geschrieben wird. */
  stateDir?: string
  /** Konfigurationsfehler, der vor dem Start als Warnung erscheint. */
  configWarning?: string
  home?: string
}

const POLL_MS = 2000
const TIMEOUT_MS = 10 * 60 * 1000
const ADD_LINE = 'claude mcp add apple-mail -- npx -y @redpop/apple-mail-mcp'

function fmt(n: number): string {
  return n.toLocaleString('en-US')
}

/** `setup` (Spec 12.2): Exit-Code 0 bei Zugriff, sonst 1. */
export async function runSetup(deps: SetupDeps): Promise<number> {
  const { out } = deps
  const say = (s: string): void => void out.write(s + '\n')
  const probe = async (): Promise<ProbeResult> => probeResult.parse(await deps.runner.run('probe', {}))

  const success = (p: ProbeResult): number => {
    if (!p.schema) {
      // Datei per open(2) lesbar, SQLite scheitert: weder "readable" noch Zugriff vermerken.
      say('Mail database could not be read (busy or damaged); try again.')
      return 1
    }
    recordAccessOk({ helperSha256: null, helperVersion: null }, deps.stateDir)
    const c = p.counts
    say('Full Disk Access is granted. Apple Mail is readable.')
    if (c) say(`Found ${fmt(c.mailboxes)} mailboxes and ${fmt(c.uniqueMessages)} messages (${fmt(c.messages)} including copies).`)
    say('')
    say('Add the server to Claude Code with:')
    say(`  ${ADD_LINE}`)
    return 0
  }

  if (deps.configWarning) say(`Warning: ${deps.configWarning}`)
  const shown = tildePath(deps.bundlePath, deps.home)
  let p: ProbeResult
  try {
    p = await probe()
  } catch (e) {
    say(e instanceof HelperError ? describeError(e.code, e.message) : 'The helper could not be started.')
    return 1
  }

  if (p.access === 'granted') return success(p)
  if (p.access === 'no_mail_data') {
    say('Apple Mail does not appear to be set up on this Mac. Open the Mail app, add an account, then run setup again.')
    return 1
  }
  if (p.access === 'untrusted_signature') {
    say('The helper reports that its signature is not trusted and refused to read mail. Reinstall the package from the official source.')
    return 1
  }

  say('Apple Mail data is protected by macOS. Grant Full Disk Access to "Mail MCP Helper":')
  say('  1. A Finder window shows "Mail MCP Helper" and System Settings opens on Full Disk Access.')
  say('  2. Drag "Mail MCP Helper" from Finder into the list and switch it on.')
  say(`  (If it is missing from the list: click +, press Cmd-Shift-G and paste ${shown})`)
  for (const args of [[FDA_SETTINGS_URL], ['-R', deps.bundlePath]]) {
    try {
      deps.open('/usr/bin/open', args)
    } catch {
      // Fehler von open sind egal; die Schritte oben stehen schon da.
    }
  }

  if (!deps.isTTY) {
    say('')
    say('Not waiting because this is not an interactive terminal. Run setup again after granting access.')
    return 1
  }

  const start = deps.now()
  while (deps.now() - start < TIMEOUT_MS) {
    out.write(`\rWaiting for Full Disk Access... ${Math.round((deps.now() - start) / 1000)} s`)
    await deps.sleep(POLL_MS)
    try {
      p = await probe()
    } catch {
      continue
    }
    if (p.access !== 'denied') break
  }
  out.write('\n')
  if (p.access === 'granted') return success(p)
  if (p.access === 'denied') say('Timed out after 10 minutes without Full Disk Access. Run setup again after granting it.')
  else say(`Access state changed to ${p.access}. Run setup again.`)
  return 1
}
