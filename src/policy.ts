import { createHash } from 'node:crypto'
import type { Config } from './config.js'
import { fold } from './fold.js'
import { parseMailbox, type ParsedMailbox } from './mailboxes.js'
import type { ListMailboxesResult } from './schemas.js'

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
  /** Aus Mail entfernte Konten (ohne Store-Verzeichnis) und ihre Mailboxen, immer ausgeblendet. */
  removedAccounts: number
  removedMailboxes: number
  /** Konten, fuer die Mail abgeschaltet ist (AMM-22), und ihre Mailboxen, immer ausgeblendet. */
  mailDisabledAccounts: number
  mailDisabledMailboxes: number
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

const hash16 = (v: unknown): string => createHash('sha256').update(stableJson(v)).digest('hex').slice(0, 16)

// bodyIndex aendert die Treffermenge nicht (Index und Live-Scan finden dasselbe), Cursor bleiben gueltig.
export function fingerprintOf(config: Config): string {
  const { helperPath: _h, debug: _d, bodyIndex: _b, ...effective } = config
  return hash16(effective)
}

// Erhoehen, wenn der Code die Sichtbarkeit aendert: Ein neuer Fingerprint loest beim naechsten Start
// den Abgleich aus, der nicht mehr sichtbare Mails aus dem Body-Index entfernt.
const MAILBOX_RULES = 2

/** Nur was bestimmt, welche Mails in den Body-Index duerfen (Spec AMM-12 5.1). */
export function indexFingerprintOf(config: Config): string {
  return hash16({ rules: MAILBOX_RULES, accounts: config.accounts, includeJunk: config.includeJunk, includeTrash: config.includeTrash, excludeMailboxes: config.excludeMailboxes })
}

/**
 * Konten, die im Envelope Index stehen, deren Verzeichnis V<n>/<uuid>/ aber fehlt (AMM-21): aus Mail entfernt,
 * ohne Dateien. Ein Konto ohne Eintrag in accountStores (anderes Schema) gilt nicht als entfernt.
 */
export function removedAccountIds(raw: ListMailboxesResult): Set<string> {
  return new Set(raw.accountStores.filter((s) => !s.hasStore).map((s) => s.uuid))
}

/**
 * Konten, fuer die Mail in Accounts4 abgeschaltet ist (AMM-22), etwa iCloud-Mail mit "Diesen Mac synchronisieren"
 * aus. Nur ein eindeutiges false zaehlt; ein entferntes Konto zaehlt als entfernt, nicht hier.
 */
export function mailDisabledAccountIds(raw: ListMailboxesResult): Set<string> {
  const removed = removedAccountIds(raw)
  return new Set(raw.accounts.filter((a) => a.mailEnabled === false && !removed.has(a.uuid)).map((a) => a.uuid))
}

/** Der Eingang je Konto (Rolle inbox), unter den erlaubten Mailboxen. */
function inboxByAccount(mailboxes: Map<number, ParsedMailbox>): Map<string, ParsedMailbox> {
  const out = new Map<string, ParsedMailbox>()
  for (const mb of mailboxes.values()) if (mb.role === 'inbox' && !out.has(mb.accountId)) out.set(mb.accountId, mb)
  return out
}

/**
 * Faellige Erinnerungen (AMM-20): Mail zeigt sie zusaetzlich im Eingang ihres Kontos, zaehlt sie aber nicht in
 * dessen total_count. Gezaehlt wird je Mail (gid) mit einer Kopie in einer erlaubten Mailbox des Kontos, nicht
 * schon im Eingang; ungelesen, wenn keine dieser Kopien gelesen ist (wie `read` in der Suche).
 */
function addDueReminders(mailboxes: Map<number, ParsedMailbox>, due: ListMailboxesResult['dueReminders']): void {
  const inboxes = inboxByAccount(mailboxes)
  const byGid = new Map<string, { inbox: ParsedMailbox; inInbox: boolean; read: boolean }>()
  for (const r of due) {
    const mb = mailboxes.get(r.mailbox)
    const inbox = mb && inboxes.get(mb.accountId)
    if (!mb || !inbox) continue
    const key = `${mb.accountId}/${r.gid}`
    const e = byGid.get(key) ?? { inbox, inInbox: false, read: false }
    e.inInbox ||= mb.id === inbox.id
    e.read ||= r.read
    byGid.set(key, e)
  }
  for (const e of byGid.values()) {
    if (e.inInbox) continue
    const cur = mailboxes.get(e.inbox.id)!
    mailboxes.set(cur.id, { ...cur, total: cur.total + 1, unread: cur.unread + (e.read ? 0 : 1) })
  }
}

/**
 * Fuer eine Suche in `mailboxIds` (AMM-20): die erlaubten Mailboxen der Konten, deren Eingang gesucht wird. Der
 * Helper nimmt faellige Erinnerungen mit einer Kopie dort dazu. Leer, wenn kein Eingang gesucht wird.
 */
export function reminderMailboxIds(policy: Policy, mailboxIds: readonly number[]): number[] {
  const accounts = new Set(mailboxIds.flatMap((id) => {
    const mb = policy.mailboxes.get(id)
    return mb?.role === 'inbox' ? [mb.accountId] : []
  }))
  return policy.allowedMailboxIds.filter((id) => accounts.has(policy.mailboxes.get(id)!.accountId)).sort((a, b) => a - b)
}

export function computePolicy(config: Config, raw: ListMailboxesResult): Policy {
  const namesAvailable = raw.accountNames === 'available'
  // Entfernte und fuer Mail abgeschaltete Konten fallen vor allem anderen heraus, auch vor der Allowlist:
  // Mail zeigt sie nicht.
  const removed = removedAccountIds(raw)
  const disabled = mailDisabledAccountIds(raw)
  const all = raw.mailboxes.map(parseMailbox)
  const parsed = all.filter((mb) => !removed.has(mb.accountId) && !disabled.has(mb.accountId))

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

  addDueReminders(mailboxes, raw.dueReminders)

  const accountsWithMail = new Set([...mailboxes.values()].map((m) => m.accountId))
  return {
    allowedMailboxIds: [...mailboxes.keys()],
    mailboxes,
    accounts: views.filter((v) => accountsWithMail.has(v.id)),
    unmatchedAllowlistEntries: unmatched,
    removedAccounts: new Set(all.filter((mb) => removed.has(mb.accountId)).map((mb) => mb.accountId)).size,
    removedMailboxes: all.filter((mb) => removed.has(mb.accountId)).length,
    mailDisabledAccounts: new Set(all.filter((mb) => disabled.has(mb.accountId)).map((mb) => mb.accountId)).size,
    mailDisabledMailboxes: all.filter((mb) => disabled.has(mb.accountId)).length,
    accountNamesAvailable: namesAvailable,
    fingerprint: fingerprintOf(config),
  }
}
