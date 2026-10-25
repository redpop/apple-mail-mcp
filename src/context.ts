import type { Config, ConfigResult } from './config.js'
import { HelperError } from './errors.js'
import { defaultOpen, openFdaOnce, type OpenFn } from './fdaPrompt.js'
import type { HelperRunner } from './helper.js'
import { computePolicy, type Policy } from './policy.js'
import { listMailboxesResult } from './schemas.js'
import { defaultStateDir, recordAccessOk } from './state.js'

export interface ToolContext {
  runner: HelperRunner
  /** Wirft HelperError CONFIG_INVALID, wenn die Konfiguration ungueltig ist. */
  config(): Config
  /** Gecacht fuer 60 s; `refresh` erzwingt eine neue Abfrage. */
  policy(refresh?: boolean): Promise<Policy>
  bundlePath: string
  onHelperError(e: unknown): void
  onHelperSuccess(): void
}

const POLICY_TTL_MS = 60_000

export function createContext(deps: {
  runner: HelperRunner
  configResult: ConfigResult
  bundlePath: string
  open?: OpenFn
  stateDir?: string
  now?: () => number
}): ToolContext {
  const now = deps.now ?? Date.now
  const open = deps.open ?? defaultOpen
  const stateDir = deps.stateDir ?? defaultStateDir()

  const onHelperSuccess = (): void => recordAccessOk({ helperSha256: null, helperVersion: null }, stateDir, now)
  const onHelperError = (e: unknown): void => {
    if (e instanceof HelperError && e.code === 'FULL_DISK_ACCESS_REQUIRED') openFdaOnce(deps.bundlePath, open)
  }

  // Jeder erfolgreiche Helper-Aufruf zaehlt als Zugriff.
  const runner: HelperRunner = {
    async run(command, payload) {
      const out = await deps.runner.run(command, payload)
      onHelperSuccess()
      return out
    },
  }

  const config = (): Config => {
    if (!deps.configResult.ok) throw new HelperError('CONFIG_INVALID', deps.configResult.key)
    return deps.configResult.config
  }

  let cached: { at: number; policy: Policy } | null = null
  const policy = async (refresh = false): Promise<Policy> => {
    const cfg = config()
    if (!refresh && cached && now() - cached.at < POLICY_TTL_MS) return cached.policy
    const raw = listMailboxesResult.parse(await runner.run('list-mailboxes', {}))
    const p = computePolicy(cfg, raw)
    cached = { at: now(), policy: p }
    return p
  }

  return { runner, config, policy, bundlePath: deps.bundlePath, onHelperError, onHelperSuccess }
}
