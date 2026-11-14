import { safeFileName, typeAllowed } from './attachmentFiles.js'
import { fold } from '@redpop/apple-mail-mcp/dist/fold.js'
import { parseMailbox, type ParsedMailbox } from '@redpop/apple-mail-mcp/dist/mailboxes.js'
import type { Policy } from '@redpop/apple-mail-mcp/dist/policy.js'
import type { ListMailboxesResult, LocateResult } from '@redpop/apple-mail-mcp/dist/schemas.js'
import { classify } from '@redpop/apple-mail-mcp/dist/securityMail.js'

export type MoveStatus =
  | 'moved'
  | 'moved_unverified'
  | 'failed'
  | 'skipped_ambiguous'
  | 'skipped_target_not_allowed'
  | 'skipped_source_not_visible'
  | 'skipped_other_account'
  | 'skipped_same_folder'
  | 'skipped_unsupported_account'
  | 'skipped_unsupported_folder'
  | 'skipped_security_mail'
  | 'skipped_locked'
  | 'skipped_no_message_id'
  | 'skipped_not_found'
  | 'skipped_mismatch'
  | 'skipped_aborted'

export interface MoveRequest {
  id: string
  targetMailboxId: string
  sourceMailboxId?: string
}

export type LocatedMessage = LocateResult['messages'][number]

export interface CheckMoveInput {
  move: MoveRequest
  /** Ergebnis von locate fuer diese Mail; undefined, wenn locate sie nicht kennt. */
  located: LocatedMessage | undefined
  policy: Policy
  /** Rohdaten aus list-mailboxes: Kontoregeln sehen auch, was die Policy ausblendet. */
  raw: ListMailboxesResult
  excludeTargets: readonly string[]
}

export type CheckMoveResult =
  | { ok: true; rowid: number; source: string; target: string; account: string; messageId: string; sourceMailboxId: number; targetMailboxId: number }
  | { ok: false; status: MoveStatus }

export type SaveStatus =
  | 'saved'
  | 'failed'
  | 'skipped_security_mail'
  | 'skipped_type_not_allowed'
  | 'skipped_too_large'
  | 'skipped_not_found'
  | 'skipped_attachment_not_found'
  | 'skipped_mismatch'
  | 'skipped_source_not_visible'
  | 'skipped_ambiguous'
  | 'skipped_unsupported_account'
  | 'skipped_unsupported_folder'
  | 'skipped_no_message_id'

export interface CheckSaveInput {
  request: { id: string; attachment: number; sourceMailboxId?: string }
  /** Ergebnis von locate (withAttachments) fuer diese Mail; undefined, wenn locate sie nicht kennt. */
  located: LocatedMessage | undefined
  policy: Policy
  raw: ListMailboxesResult
  attachmentTypes: readonly string[]
}

export type CheckSaveResult =
  | { ok: true; account: string; source: string; rowid: number; messageId: string; partId: string; fileName: string }
  | { ok: false; status: SaveStatus }

export type UnsupportedAccountReason = 'type' | 'allmail' | 'gmail' | 'name_missing' | 'name_duplicate'

const FORBIDDEN_TARGET_ROLES: ReadonlySet<ParsedMailbox['role']> = new Set(['junk', 'trash', 'drafts', 'sent', 'allmail'])
const GMAIL_SUFFIXES = ['@gmail.com', '@googlemail.com']
// Dieselbe Grenze wie validate() im Actions-Bundle: ein Treffer dort waere ein Abbruch des ganzen Laufs.
const CONTROL_CHAR = /[\u0000-\u001f\u007f]/

/** Strikte Zahl aus einer ID; alles andere (auch eine gerundete grosse Zahl) ist null, nie eine andere Mail. */
export function parseId(s: string): number | null {
  if (!/^\d+$/.test(s)) return null
  const n = Number(s)
  return Number.isSafeInteger(n) ? n : null
}

/**
 * Warum ein Konto nicht unterstuetzt ist, oder null. Bewusst aus den Rohdaten, nicht aus der Policy: Ein per
 * Ausschluss verstecktes "Alle Nachrichten" macht ein Konto nicht unterstuetzt, und Mail adressiert Konten
 * ueber den Namen, also zaehlt auch ein gleichnamiges Konto ausserhalb der Allowlist. AppleScript vergleicht
 * Namen ohne Gross- und Kleinschreibung, darum fold().
 */
export function unsupportedAccountReason(raw: ListMailboxesResult, accountId: string): UnsupportedAccountReason | null {
  const mailboxes = raw.mailboxes.map(parseMailbox).filter((m) => m.accountId === accountId)
  if (mailboxes.length === 0 || mailboxes.some((m) => m.type !== 'imap')) return 'type'
  if (mailboxes.some((m) => m.role === 'allmail')) return 'allmail'
  const account = raw.accounts.find((a) => a.uuid === accountId)
  const username = account?.username?.trim().toLowerCase()
  if (username !== undefined && GMAIL_SUFFIXES.some((s) => username.endsWith(s))) return 'gmail'
  return accountNameProblem(raw, accountId)
}

/** Nur die Namensregeln: Mail adressiert Konten ueber den Namen, er muss vorhanden und eindeutig sein. */
export function accountNameProblem(raw: ListMailboxesResult, accountId: string): 'name_missing' | 'name_duplicate' | null {
  const name = accountName(raw, accountId)
  if (name === null) return 'name_missing'
  if (raw.accounts.filter((a) => a.description !== null && fold(a.description.trim()) === fold(name)).length > 1) return 'name_duplicate'
  return null
}

function accountName(raw: ListMailboxesResult, accountId: string): string | null {
  if (raw.accountNames !== 'available') return null
  const name = raw.accounts.find((a) => a.uuid === accountId)?.description?.trim()
  return name === undefined || name === '' || CONTROL_CHAR.test(name) ? null : name
}

// Der Ordner, wie Mail ihn adressiert; null, wenn sein Pfad sich so nicht ausdruecken laesst.
function folderPath(mb: ParsedMailbox): string | null {
  if (mb.path.length === 0 || mb.path.some((s) => CONTROL_CHAR.test(s))) return null
  return mb.path.join('/')
}

// AppleScript vergleicht Namen ohne Gross- und Kleinschreibung: Bei "Archive" und "archive" koennte der Zug im
// falschen Ordner landen. Aus den Rohdaten, denn auch ein ausgeblendeter Zwilling kann der Treffer sein.
function hasCaseTwin(raw: ListMailboxesResult, mb: ParsedMailbox): boolean {
  const path = fold(mb.path.join('/'))
  return raw.mailboxes.map(parseMailbox).some((m) => m.accountId === mb.accountId && m.id !== mb.id && m.path.length > 0 && fold(m.path.join('/')) === path)
}

// Der Kopf aus der Mail ist fremder Inhalt: Was das Bundle ablehnen wuerde, gilt als nicht vorhanden.
function usableMessageId(header: string | null): string | null {
  if (header === null || CONTROL_CHAR.test(header)) return null
  return header.replace(/[<>\s]/g, '') === '' ? null : header
}

function targetAllowed(mb: ParsedMailbox, excludeTargets: readonly string[]): boolean {
  if (FORBIDDEN_TARGET_ROLES.has(mb.role)) return false
  const excluded = new Set(excludeTargets.map(fold))
  return !excluded.has(fold(mb.name)) && !(mb.path.length > 0 && excluded.has(fold(mb.path.join('/'))))
}

/** Prueft eine Verschiebung ohne Nebenwirkung. Sperren prueft mover.ts direkt vor dem Zug. */
export function checkMove(input: CheckMoveInput): CheckMoveResult {
  const { move, located, policy, raw, excludeTargets } = input
  const skip = (status: MoveStatus): CheckMoveResult => ({ ok: false, status })

  const targetId = parseId(move.targetMailboxId)
  const target = targetId === null ? undefined : policy.mailboxes.get(targetId)
  if (target === undefined || !targetAllowed(target, excludeTargets)) return skip('skipped_target_not_allowed')

  const visible = (located?.copies ?? []).filter((c) => policy.mailboxes.has(c.mailboxId))
  let candidates = visible
  if (move.sourceMailboxId !== undefined) {
    const sourceId = parseId(move.sourceMailboxId)
    if (sourceId === null || !policy.mailboxes.has(sourceId)) return skip('skipped_source_not_visible')
    candidates = visible.filter((c) => c.mailboxId === sourceId)
  }
  const copy = candidates[0]
  if (located === undefined || copy === undefined) return skip('skipped_source_not_visible')
  if (candidates.length > 1) return skip('skipped_ambiguous')
  const source = policy.mailboxes.get(copy.mailboxId)!

  if (source.accountId !== target.accountId) return skip('skipped_other_account')
  if (unsupportedAccountReason(raw, target.accountId) !== null) return skip('skipped_unsupported_account')
  const account = accountName(raw, target.accountId)
  if (account === null) return skip('skipped_unsupported_account')

  const sourcePath = folderPath(source)
  const targetPath = folderPath(target)
  if (sourcePath === null || targetPath === null) return skip('skipped_unsupported_folder')
  if (hasCaseTwin(raw, source) || hasCaseTwin(raw, target)) return skip('skipped_unsupported_folder')

  // Betreff-Modus ohne Rueckgriff auf showSecurityMails: Sicherheitsmails werden nie verschoben.
  if (classify({ subject: located.subject, fromAddress: located.fromAddress }).security) return skip('skipped_security_mail')

  const messageId = usableMessageId(located.messageIdHeader)
  if (messageId === null) return skip('skipped_no_message_id')

  if (source.id === target.id) return skip('skipped_same_folder')

  return { ok: true, rowid: copy.rowid, source: sourcePath, target: targetPath, account, messageId, sourceMailboxId: source.id, targetMailboxId: target.id }
}

// Die Teil-ID geht an das Bundle; was es ablehnen wuerde (leer, keine Punktzahlen), gilt als nicht vorhanden.
const PART_ID = /^[0-9]+(\.[0-9]+)*$/

/**
 * Prueft das Speichern eines Anhangs ohne Nebenwirkung. Gmail und Nicht-IMAP-Konten sind erlaubt: Gespeichert wird
 * nur gelesen, es entsteht keine Kopie auf dem Server.
 */
export function checkSave(input: CheckSaveInput): CheckSaveResult {
  const { request, located, policy, raw, attachmentTypes } = input
  const skip = (status: SaveStatus): CheckSaveResult => ({ ok: false, status })

  const visible = (located?.copies ?? []).filter((c) => policy.mailboxes.has(c.mailboxId))
  let candidates = visible
  if (request.sourceMailboxId !== undefined) {
    const sourceId = parseId(request.sourceMailboxId)
    if (sourceId === null || !policy.mailboxes.has(sourceId)) return skip('skipped_source_not_visible')
    candidates = visible.filter((c) => c.mailboxId === sourceId)
  }
  const copy = candidates[0]
  if (located === undefined || copy === undefined) return skip('skipped_source_not_visible')
  if (candidates.length > 1) return skip('skipped_ambiguous')
  const source = policy.mailboxes.get(copy.mailboxId)!

  if (accountNameProblem(raw, source.accountId) !== null) return skip('skipped_unsupported_account')
  const account = accountName(raw, source.accountId)
  if (account === null) return skip('skipped_unsupported_account')

  const sourcePath = folderPath(source)
  if (sourcePath === null || hasCaseTwin(raw, source)) return skip('skipped_unsupported_folder')

  if (classify({ subject: located.subject, fromAddress: located.fromAddress }).security) return skip('skipped_security_mail')

  const messageId = usableMessageId(located.messageIdHeader)
  if (messageId === null) return skip('skipped_no_message_id')

  const attachment = Number.isInteger(request.attachment) && request.attachment >= 0 ? copy.attachments?.[request.attachment] : undefined
  if (attachment === undefined || !PART_ID.test(attachment.partId)) return skip('skipped_attachment_not_found')

  const fileName = safeFileName(attachment.name, `attachment-${request.id}-${attachment.partId}`)
  if (!typeAllowed(fileName, attachmentTypes)) return skip('skipped_type_not_allowed')

  return { ok: true, account, source: sourcePath, rowid: copy.rowid, messageId, partId: attachment.partId, fileName }
}
