import type { Writable } from 'node:stream'
import { loadConfig, type Config } from '../config.js'
import { defaultOpen } from '../fdaPrompt.js'
import { createHelperRunner, packagedHelperBundle, type HelperRunner } from '../helper.js'
import { defaultDoctorExec, runDoctor } from './doctor.js'
import { runSetup } from './setup.js'

const DEFAULT_CONFIG: Config = {
  accounts: [], includeJunk: false, includeTrash: false, excludeMailboxes: [], showSecurityMails: false,
  bodySearch: true, maxResults: 50, maxBodyChars: 20000, helperPath: null, debug: false,
}

type CliRunner = HelperRunner & { stop(): void; bundlePath: string }

export interface CliDeps {
  env?: NodeJS.ProcessEnv
  makeRunner?: (config: Config) => CliRunner
  out?: Writable
  isTTY?: boolean
  /** Signal-Registrierung und Exit sind injizierbar, damit der Test kein echtes Signal braucht. */
  onSignal?: (signal: 'SIGINT' | 'SIGTERM', handler: () => void) => void
  exit?: (code: number) => void
}

/** Einstieg fuer `setup` und `doctor`; stoppt den Helper in jedem Fall vor der Rueckkehr. */
export async function runCli(command: 'setup' | 'doctor', args: string[], deps: CliDeps = {}): Promise<number> {
  const env = deps.env ?? process.env
  const out = deps.out ?? process.stdout
  const configResult = loadConfig(env)
  let config: Config
  if (configResult.ok) {
    config = configResult.config
  } else {
    // Auch bei ungueltiger Konfiguration gilt der Helper-Override (leer = nicht gesetzt).
    const h = env.APPLE_MAIL_HELPER_PATH?.trim()
    config = { ...DEFAULT_CONFIG, helperPath: h ? h : null }
  }
  const runner = (deps.makeRunner ?? createHelperRunner)(config)
  const onSignal = deps.onSignal ?? ((sig, h) => void process.on(sig, h))
  const exit = deps.exit ?? ((c: number) => process.exit(c))
  onSignal('SIGINT', () => { runner.stop(); exit(130) })
  onSignal('SIGTERM', () => { runner.stop(); exit(143) })
  try {
    if (command === 'setup') {
      return await runSetup({
        runner,
        bundlePath: runner.bundlePath || packagedHelperBundle(),
        open: defaultOpen,
        out,
        isTTY: deps.isTTY ?? process.stdout.isTTY === true,
        sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
        now: Date.now,
        ...(configResult.ok ? {} : { configWarning: `${configResult.key}: ${configResult.error}` }),
      })
    }
    return await runDoctor({
      runner,
      bundlePath: runner.bundlePath,
      configResult,
      exec: defaultDoctorExec,
      out,
      verbose: args.includes('--verbose'),
      json: args.includes('--json'),
      schema: args.includes('--schema'),
    })
  } finally {
    runner.stop()
  }
}
