import { chmodSync, lstatSync, mkdirSync, mkdtempSync, realpathSync, rmdirSync, unlinkSync } from 'node:fs'
import { basename, join, sep } from 'node:path'
import { HelperError } from '@redpop/apple-mail-mcp/dist/errors.js'
import type { HelperRunner } from '@redpop/apple-mail-mcp/dist/helper.js'
import { computePolicy } from '@redpop/apple-mail-mcp/dist/policy.js'
import { listMailboxesResult, locateResult } from '@redpop/apple-mail-mcp/dist/schemas.js'
import { isSlot } from './attachmentFiles.js'
import type { ActionsConfig } from './config.js'
import { ActionsError } from './errors.js'
import { requirePermission, type ActionsRunner } from './mover.js'
import { checkSave, parseId, type SaveStatus } from './rules.js'

export interface SaverDeps {
  helper: HelperRunner
  actions: ActionsRunner
  config: ActionsConfig
}

export interface SaveRequest {
  id: string
  attachment: number
  sourceMailboxId?: string
}

export interface SaveResult {
  status: SaveStatus
  path?: string
  name?: string
  bytes?: number
}

// Nur `saved` fuehrt weiter; jede andere bekannte Antwort ist ein Ueberspringen, der Rest `failed`.
function outcomeStatus(out: unknown): SaveStatus {
  switch ((out as { outcome?: unknown } | null)?.outcome) {
    case 'saved': return 'saved'
    case 'not_found': return 'skipped_not_found'
    case 'mismatch': return 'skipped_mismatch'
    case 'folder_not_found': return 'skipped_unsupported_folder'
    case 'attachment_not_found': return 'skipped_attachment_not_found'
    case 'too_large': return 'skipped_too_large'
    default: return 'failed'
  }
}

// Legt Basis und Slot an (je 0700). Jeder Fehler hier ist ein lokales Problem, noch bevor Mail etwas tut.
function createSlot(base: string): string {
  if (base === '') throw new ActionsError('ATTACHMENT_DIR_UNAVAILABLE')
  try {
    mkdirSync(base, { recursive: true, mode: 0o700 })
    const slot = mkdtempSync(join(base, 'att-'))
    chmodSync(slot, 0o700)
    if (!isSlot(basename(slot))) throw new Error('slot name')
    return slot
  } catch {
    throw new ActionsError('ATTACHMENT_DIR_UNAVAILABLE')
  }
}

// Entfernt genau den erwarteten Eintrag (nie rekursiv) und den Slot nur, wenn er danach leer ist.
function discard(slot: string, file: string): void {
  try {
    unlinkSync(file)
  } catch {
    // Fehlt oder ist ein Ordner: dann bleibt er stehen.
  }
  try {
    rmdirSync(slot)
  } catch {
    // Nicht leer oder schon weg: nichts weiter loeschen.
  }
}

// Groesse der Datei, die das Bundle abgelegt hat, oder null, wenn sie den Regeln nicht entspricht.
function verifyFile(slot: string, file: string, maxBytes: number): number | null {
  try {
    const st = lstatSync(file)
    if (!st.isFile() || st.size > maxBytes) return null
    if (!realpathSync(file).startsWith(realpathSync(slot) + sep)) return null
    return st.size
  } catch {
    return null
  }
}

/**
 * Der Ablauf von save_attachment: Freigabe, frische Policy, locate mit Anhaengen, Regeln, Slot, Bundle, Pruefung
 * der Datei. Es wird nie etwas ueberschrieben und nur entfernt, was dieser Aufruf selbst angelegt hat.
 */
export async function saveAttachment(deps: SaverDeps, request: SaveRequest): Promise<SaveResult> {
  const { helper, actions, config } = deps
  if (config.attachmentDir === '') throw new ActionsError('ATTACHMENT_DIR_UNAVAILABLE')

  await requirePermission(actions)

  // Bewusst ohne Cache: Regeln fuer einen Zugriff laufen auf frischem Stand.
  const raw = listMailboxesResult.parse(await helper.run('list-mailboxes', {}))
  const policy = computePolicy(config, raw)

  const gid = parseId(request.id)
  let located
  if (gid !== null && policy.allowedMailboxIds.length > 0) {
    const found = locateResult.parse(await helper.run('locate', { allowedMailboxIds: policy.allowedMailboxIds, gids: [gid], withAttachments: true }))
    located = found.messages.find((m) => m.gid === gid)
  }

  const check = checkSave({ request, located, policy, raw, attachmentTypes: config.attachmentTypes })
  if (!check.ok) return { status: check.status }

  const slot = createSlot(config.attachmentDir)
  const file = join(slot, check.fileName)

  let status: SaveStatus
  try {
    status = outcomeStatus(
      await actions.run('save-attachment', {
        account: check.account,
        source: check.source,
        rowid: check.rowid,
        expectedMessageId: check.messageId,
        partId: check.partId,
        slot: basename(slot),
        fileName: check.fileName,
        maxBytes: config.maxAttachmentBytes,
      }),
    )
  } catch (e) {
    discard(slot, file)
    if (e instanceof HelperError && (e.code === 'MAIL_NOT_RUNNING' || e.code === 'AUTOMATION_NOT_GRANTED')) throw new ActionsError(e.code)
    return { status: 'failed' }
  }

  if (status !== 'saved') {
    // Auch ein Fehlschlag kann eine Datei hinterlassen haben: genau diese entfernen.
    discard(slot, file)
    return { status }
  }

  const bytes = verifyFile(slot, file, config.maxAttachmentBytes)
  if (bytes === null) {
    discard(slot, file)
    return { status: 'failed' }
  }
  return { status: 'saved', path: file, name: check.fileName, bytes }
}
