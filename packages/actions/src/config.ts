import { type Config, loadConfig } from '@redpop/apple-mail-mcp/dist/config.js'
import { DEFAULT_ATTACHMENT_TYPES, NEVER_ALLOWED, resolveAttachmentDir } from './attachmentFiles.js'

export interface ActionsConfig extends Config {
  maxMoves: number
  excludeTargets: string[]
  actionsPath: string | null
  saveAttachments: boolean
  attachmentDir: string
  maxAttachmentBytes: number
  attachmentTypes: string[]
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
    let saveAttachments = false
    const sa = raw(env, 'APPLE_MAIL_SAVE_ATTACHMENTS')
    if (sa !== undefined) {
      if (sa !== 'true' && sa !== 'false') throw new KeyError('APPLE_MAIL_SAVE_ATTACHMENTS', 'APPLE_MAIL_SAVE_ATTACHMENTS must be true or false')
      saveAttachments = sa === 'true'
    }
    // Der Ordner zaehlt nur, wenn Speichern an ist; sonst darf ein fehlendes HOME das Verschieben nicht stoeren.
    let attachmentDir = ''
    if (saveAttachments) {
      const dir = resolveAttachmentDir(raw(env, 'APPLE_MAIL_ATTACHMENT_DIR'), env.HOME ?? '')
      if (dir === null) throw new KeyError('APPLE_MAIL_ATTACHMENT_DIR', 'APPLE_MAIL_ATTACHMENT_DIR must be an absolute path or start with ~/ (and HOME must be set for the default folder)')
      attachmentDir = dir
    }
    let maxAttachmentBytes = 26214400
    const mb = raw(env, 'APPLE_MAIL_MAX_ATTACHMENT_BYTES')
    if (mb !== undefined) {
      if (!/^\d+$/.test(mb) || Number(mb) < 1 || Number(mb) > 104857600) throw new KeyError('APPLE_MAIL_MAX_ATTACHMENT_BYTES', 'APPLE_MAIL_MAX_ATTACHMENT_BYTES must be an integer between 1 and 104857600')
      maxAttachmentBytes = Number(mb)
    }
    let attachmentTypes = [...DEFAULT_ATTACHMENT_TYPES]
    const at = raw(env, 'APPLE_MAIL_ATTACHMENT_TYPES')
    if (at !== undefined) {
      attachmentTypes = at.split(',').map((s) => s.trim().replace(/^\./, '').toLowerCase()).filter((s) => s !== '')
      if (attachmentTypes.length === 0) throw new KeyError('APPLE_MAIL_ATTACHMENT_TYPES', 'APPLE_MAIL_ATTACHMENT_TYPES contains no entries')
      const never = attachmentTypes.find((t) => NEVER_ALLOWED.includes(t))
      if (never !== undefined) throw new KeyError('APPLE_MAIL_ATTACHMENT_TYPES', `APPLE_MAIL_ATTACHMENT_TYPES must not contain "${never}"; executable types are never saved`)
    }
    return {
      ok: true,
      config: { ...base.config, maxMoves, excludeTargets, actionsPath: raw(env, 'APPLE_MAIL_ACTIONS_PATH') ?? null, saveAttachments, attachmentDir, maxAttachmentBytes, attachmentTypes },
    }
  } catch (e) {
    if (e instanceof KeyError) return { ok: false, key: e.key, error: e.message }
    throw e
  }
}
