export interface Config {
  accounts: string[]
  includeJunk: boolean
  includeTrash: boolean
  excludeMailboxes: string[]
  showSecurityMails: boolean
  bodySearch: boolean
  maxResults: number
  maxBodyChars: number
  helperPath: string | null
  debug: boolean
}

export type ConfigResult =
  | { ok: true; config: Config }
  | { ok: false; key: string; error: string }

class ConfigError extends Error {
  constructor(readonly key: string, message: string) {
    super(message)
  }
}

// Leerer String (MCPB ohne Eingabe) gilt als nicht gesetzt.
function raw(env: NodeJS.ProcessEnv, key: string): string | undefined {
  const v = env[key]
  if (v === undefined) return undefined
  const t = v.trim()
  return t === '' ? undefined : t
}

function bool(env: NodeJS.ProcessEnv, key: string, def: boolean): boolean {
  const v = raw(env, key)
  if (v === undefined) return def
  const l = v.toLowerCase()
  if (l === 'true' || l === '1') return true
  if (l === 'false' || l === '0') return false
  throw new ConfigError(key, `${key} must be one of true, false, 1, 0`)
}

function int(env: NodeJS.ProcessEnv, key: string, def: number, min: number, max: number): number {
  const v = raw(env, key)
  if (v === undefined) return def
  if (!/^\d+$/.test(v)) throw new ConfigError(key, `${key} must be an integer between ${min} and ${max}`)
  const n = Number(v)
  if (n < min || n > max) throw new ConfigError(key, `${key} must be an integer between ${min} and ${max}`)
  return n
}

function list(env: NodeJS.ProcessEnv, key: string): string[] {
  const v = raw(env, key)
  if (v === undefined) return []
  const items = v.split(',').map((s) => s.trim()).filter((s) => s !== '')
  // Nicht leerer Wert ohne Eintraege waere sonst "alle" (fail-open).
  if (items.length === 0) throw new ConfigError(key, `${key} contains no entries`)
  return items
}

export function loadConfig(env: NodeJS.ProcessEnv): ConfigResult {
  try {
    const config: Config = {
      accounts: list(env, 'APPLE_MAIL_ACCOUNTS'),
      includeJunk: bool(env, 'APPLE_MAIL_INCLUDE_JUNK', false),
      includeTrash: bool(env, 'APPLE_MAIL_INCLUDE_TRASH', false),
      excludeMailboxes: list(env, 'APPLE_MAIL_EXCLUDE_MAILBOXES'),
      showSecurityMails: bool(env, 'APPLE_MAIL_SHOW_SECURITY_MAILS', false),
      bodySearch: bool(env, 'APPLE_MAIL_BODY_SEARCH', true),
      maxResults: int(env, 'APPLE_MAIL_MAX_RESULTS', 50, 1, 100),
      maxBodyChars: int(env, 'APPLE_MAIL_MAX_BODY_CHARS', 20000, 1000, 100000),
      helperPath: raw(env, 'APPLE_MAIL_HELPER_PATH') ?? null,
      debug: bool(env, 'APPLE_MAIL_MCP_DEBUG', false),
    }
    return { ok: true, config }
  } catch (e) {
    if (e instanceof ConfigError) return { ok: false, key: e.key, error: e.message }
    throw e
  }
}
