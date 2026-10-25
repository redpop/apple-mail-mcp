import { createHash } from 'node:crypto'
import type { Config } from './config.js'
import { fold } from './fold.js'
import { parseMailbox, type ParsedMailbox } from './mailboxes.js'

// Vorlaeufig lokal (Spec 7.3 list-mailboxes plus 5.6); Task 12 ersetzt ihn durch den zod-Typ.
export type ListMailboxesResult = {
  mailboxes: { id: number; url: string; total: number; unread: number }[]
  accounts: { uuid: string; description: string | null; username: string | null }[]
  accountNames: 'available' | 'unavailable'
  accountNamesReason?: string | null
}

export interface AccountView {
  id: string
  name: string
  address: string | null
  type: ParsedMailbox['type']
}

export interface Policy {
  allowedMailboxIds: number[]
  mailboxes: Map<number, ParsedMailbox>
  accounts: AccountView[]
  unmatchedAllowlistEntries: number
  accountNamesAvailable: boolean
  fingerprint: string
}

function looksLikeEmail(s: string | null): s is string {
  if (s === null) return false
  const parts = s.split('@')
  return parts.length === 2 && parts[0]!.length > 0 && parts[1]!.length > 0
}

function stableJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableJson).join(',')}]`
  if (v !== null && typeof v === 'object') {
    const o = v as Record<string, unknown>
    return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${stableJson(o[k])}`).join(',')}}`
  }
  return JSON.stringify(v)
}

export function fingerprintOf(config: Config): string {
  const { helperPath: _h, debug: _d, ...effective } = config
  return createHash('sha256').update(stableJson(effective)).digest('hex').slice(0, 16)
}

export function computePolicy(config: Config, raw: ListMailboxesResult): Policy {
  const namesAvailable = raw.accountNames === 'available'
  const parsed = raw.mailboxes.map(parseMailbox)

  // Konten aus den Mailbox-URLs, ergaenzt um Namen aus dem Helper.
  const info = new Map(raw.accounts.map((a) => [a.uuid, a]))
  const typeByAccount = new Map<string, ParsedMailbox['type']>()
  for (const mb of parsed) if (!typeByAccount.has(mb.accountId)) typeByAccount.set(mb.accountId, mb.type)
  const views: AccountView[] = [...typeByAccount].map(([id, type]) => {
    const i = namesAvailable ? info.get(id) : undefined
    return {
      id,
      name: i?.description ?? id,
      address: looksLikeEmail(i?.username ?? null) ? i!.username : null,
      type,
    }
  })

  // Allowlist: exakt gegen UUID, Adresse oder Name; ohne Namen nur UUID (fail-closed).
  let allowedAccounts: Set<string> | null = null
  let unmatched = 0
  if (config.accounts.length > 0) {
    allowedAccounts = new Set()
    for (const entry of config.accounts) {
      const e = fold(entry)
      let matched = false
      for (const v of views) {
        const hit = fold(v.id) === e || (namesAvailable && ((v.address !== null && fold(v.address) === e) || fold(v.name) === e))
        if (hit) {
          matched = true
          allowedAccounts.add(v.id)
        }
      }
      if (!matched) unmatched++
    }
  }

  const excluded = new Set(config.excludeMailboxes.map(fold))
  const mailboxes = new Map<number, ParsedMailbox>()
  for (const mb of parsed) {
    if (allowedAccounts && !allowedAccounts.has(mb.accountId)) continue
    if (mb.role === 'junk' && !config.includeJunk) continue
    if (mb.role === 'trash' && !config.includeTrash) continue
    // Eintrag mit "/" passt auf den Pfad, sonst auf den Namen.
    if (excluded.has(fold(mb.name)) || (mb.path.length > 0 && excluded.has(fold(mb.path.join('/'))))) continue
    mailboxes.set(mb.id, mb)
  }

  const accountsWithMail = new Set([...mailboxes.values()].map((m) => m.accountId))
  return {
    allowedMailboxIds: [...mailboxes.keys()],
    mailboxes,
    accounts: views.filter((v) => accountsWithMail.has(v.id)),
    unmatchedAllowlistEntries: unmatched,
    accountNamesAvailable: namesAvailable,
    fingerprint: fingerprintOf(config),
  }
}
