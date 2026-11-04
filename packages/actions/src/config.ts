import { type Config, loadConfig } from '@redpop/apple-mail-mcp/dist/config.js'

export interface ActionsConfig extends Config {
  maxMoves: number
  excludeTargets: string[]
  actionsPath: string | null
}

export type ActionsConfigResult =
  | { ok: true; config: ActionsConfig }
  | { ok: false; key: string; error: string }

// Gleiche Regeln wie in src/config.ts des Lesepakets (Platzhalter des MCPB-Hosts, leer = nicht gesetzt).
function raw(env: NodeJS.ProcessEnv, key: string): string | undefined {
  const t = env[key]?.trim()
  if (t === undefined) return undefined
  if (/\$\{user_config\.[^}]*\}/.test(t)) throw new KeyError(key, `${key} was not replaced by the MCPB host (it still reads ${t}); set a value or reinstall the extension`)
  return t === '' ? undefined : t
}

class KeyError extends Error {
  constructor(readonly key: string, message: string) {
    super(message)
  }
}

export function loadActionsConfig(env: NodeJS.ProcessEnv): ActionsConfigResult {
  const base = loadConfig(env)
  if (!base.ok) return base
  // Verschieben ohne Kontobegrenzung waere "alle Konten": hier ist die Liste Pflicht.
  if (base.config.accounts.length === 0) {
    return { ok: false, key: 'APPLE_MAIL_ACCOUNTS', error: 'APPLE_MAIL_ACCOUNTS must name at least one account; moving messages is never enabled for all accounts' }
  }
  try {
    let maxMoves = 25
    const m = raw(env, 'APPLE_MAIL_MAX_MOVES')
    if (m !== undefined) {
      if (!/^\d+$/.test(m) || Number(m) < 1 || Number(m) > 100) throw new KeyError('APPLE_MAIL_MAX_MOVES', 'APPLE_MAIL_MAX_MOVES must be an integer between 1 and 100')
      maxMoves = Number(m)
    }
    let excludeTargets: string[] = []
    const x = raw(env, 'APPLE_MAIL_MOVE_EXCLUDE_TARGETS')
    if (x !== undefined) {
      excludeTargets = x.split(',').map((s) => s.trim()).filter((s) => s !== '')
      if (excludeTargets.length === 0) throw new KeyError('APPLE_MAIL_MOVE_EXCLUDE_TARGETS', 'APPLE_MAIL_MOVE_EXCLUDE_TARGETS contains no entries')
    }
    return { ok: true, config: { ...base.config, maxMoves, excludeTargets, actionsPath: raw(env, 'APPLE_MAIL_ACTIONS_PATH') ?? null } }
  } catch (e) {
    if (e instanceof KeyError) return { ok: false, key: e.key, error: e.message }
    throw e
  }
}
