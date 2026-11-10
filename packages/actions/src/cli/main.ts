import type { Writable } from 'node:stream'
import { loadConfig, type Config } from '@redpop/apple-mail-mcp/dist/config.js'
import { runCli as runReadCli, type CliDeps as ReadCliDeps } from '@redpop/apple-mail-mcp/dist/cli/main.js'
import { createHelperRunner, type HelperRunner } from '@redpop/apple-mail-mcp/dist/helper.js'
import { createActionsRunner } from '../bundle.js'
import { loadActionsConfig, type ActionsConfig, type ActionsConfigResult } from '../config.js'
import { defaultDoctorExec } from '@redpop/apple-mail-mcp/dist/cli/doctor.js'
import { runActionsDoctor, type DoctorExec } from './doctor.js'
import { runActionsSetup } from './setup.js'

type CliRunner = HelperRunner & { stop(): void; bundlePath: string }

export interface ActionsCliDeps {
  env?: NodeJS.ProcessEnv
  out?: Writable
  isTTY?: boolean
  makeHelper?: (config: Config) => CliRunner
  makeActions?: (config: ActionsConfig) => CliRunner
  readCli?: (command: 'setup' | 'doctor', args: string[], deps: ReadCliDeps) => Promise<number>
  exec?: DoctorExec
  onSignal?: (signal: 'SIGINT' | 'SIGTERM', handler: () => void) => void
  exit?: (code: number) => void
}

const BASE_FALLBACK: Config = {
  accounts: [], includeJunk: false, includeTrash: false, excludeMailboxes: [], showSecurityMails: false,
  bodySearch: true, bodyIndex: false, maxResults: 50, maxBodyChars: 20000, helperPath: null, debug: false,
}

/** Einstieg fuer `setup` und `doctor` des Actions-Pakets; beide Helper werden in jedem Fall gestoppt. */
export async function runCli(command: 'setup' | 'doctor', args: string[], deps: ActionsCliDeps = {}): Promise<number> {
  const env = deps.env ?? process.env
  const out = deps.out ?? process.stdout
  const baseResult = loadConfig(env)
  const configResult: ActionsConfigResult = loadActionsConfig(env)
  const baseConfig: Config | null = baseResult.ok ? baseResult.config : null
  const helperOverride = env.APPLE_MAIL_HELPER_PATH?.trim()
  const readConfig: Config = baseConfig ?? { ...BASE_FALLBACK, helperPath: helperOverride ? helperOverride : null }
  // Leere Kontenliste macht die Actions-Konfiguration ungueltig; Bundle-Pfad und Debug-Flag gelten trotzdem.
  const actionsConfig: ActionsConfig = configResult.ok
    ? configResult.config
    : { ...readConfig, maxMoves: 25, excludeTargets: [], actionsPath: env.APPLE_MAIL_ACTIONS_PATH?.trim() || null }

  const helper = (deps.makeHelper ?? createHelperRunner)(readConfig)
  const actions = (deps.makeActions ?? createActionsRunner)(actionsConfig)
  const stopAll = (): void => {
    helper.stop()
    actions.stop()
  }
  const onSignal = deps.onSignal ?? ((sig, h) => void process.on(sig, h))
  const exit = deps.exit ?? ((c: number) => process.exit(c))
  onSignal('SIGINT', () => { stopAll(); exit(130) })
  onSignal('SIGTERM', () => { stopAll(); exit(143) })

  // Der Lese-CLI bekommt den geteilten Helper; sein stop() ist ein No-op, gestoppt wird erst am Ende hier.
  const shared: CliRunner = { ...helper, run: (c, p) => helper.run(c, p), stop: () => {} }
  const readDeps: ReadCliDeps = {
    env, out, makeRunner: () => shared, onSignal: () => {}, exit: () => {},
    ...(deps.isTTY !== undefined ? { isTTY: deps.isTTY } : {}),
  }
  const read = deps.readCli ?? runReadCli
  try {
    if (command === 'setup') {
      return await runActionsSetup({ readSetup: () => read('setup', args, readDeps), actions, out })
    }
    // --json und --schema sind Formate des Lese-Doctors; ihre Ausgabe bliebe sonst nicht maschinenlesbar.
    if (args.includes('--json') || args.includes('--schema')) return await read('doctor', args, readDeps)
    return await runActionsDoctor({
      readDoctor: () => read('doctor', args, readDeps),
      helper, actions, configResult, baseConfig,
      bundlePath: actions.bundlePath,
      override: actionsConfig.actionsPath !== null,
      exec: deps.exec ?? defaultDoctorExec,
      out,
      verbose: args.includes('--verbose'),
    })
  } finally {
    stopAll()
  }
}
