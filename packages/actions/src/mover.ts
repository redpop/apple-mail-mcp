import { HelperError } from '@redpop/apple-mail-mcp/dist/errors.js'
import type { HelperRunner } from '@redpop/apple-mail-mcp/dist/helper.js'
import { computePolicy } from '@redpop/apple-mail-mcp/dist/policy.js'
import { listMailboxesResult, locateResult, type LocateResult } from '@redpop/apple-mail-mcp/dist/schemas.js'
import type { ActionsConfig } from './config.js'
import { ActionsError } from './errors.js'
import type { MoveLocks } from './locks.js'
import { checkMove, parseId, type MoveRequest, type MoveStatus } from './rules.js'

/** Laeuft als HelperRunner aus createStdioRunner; die Frist liegt ueber dem Apple-Event-Timeout (bundle.ts). */
export type ActionsRunner = HelperRunner

export interface MoverDeps {
  helper: HelperRunner
  actions: ActionsRunner
  locks: Pick<MoveLocks, 'isLocked' | 'lock' | 'tryLock'>
  config: ActionsConfig
  now?: () => number
  sleep?: (ms: number) => Promise<void>
}

export interface MoveResultEntry {
  id: string
  status: MoveStatus
}

export interface MoveMessagesResult {
  results: MoveResultEntry[]
  note: string
}

export const VERIFY_WINDOW_MS = 10_000
export const VERIFY_INTERVAL_MS = 500

export const MOVE_NOTE =
  'Each status describes the local state in Mail on this Mac, not the mail server. moved means the Mail index shows the message in the target and no longer in the source. ' +
  'moved_unverified means Mail accepted the move but the index did not confirm it within 10 seconds. failed may still have taken effect and is not retried; ' +
  'check the message in Mail before moving it again. skipped_aborted entries were not attempted because an earlier entry failed. ' +
  'skipped_target_not_allowed means the target id is not among the visible mailboxes (unknown, deleted, hidden or in another account), ' +
  'is a junk, trash, drafts, sent or all-mail folder, or is excluded by configuration.'

export async function requirePermission(actions: ActionsRunner): Promise<void> {
  let out: unknown
  try {
    out = await actions.run('permission', {})
  } catch (e) {
    if (e instanceof HelperError && (e.code === 'MAIL_NOT_RUNNING' || e.code === 'AUTOMATION_NOT_GRANTED')) throw new ActionsError(e.code)
    // Startfehler des Actions-Bundles (HELPER_*) duerfen nicht als Fehler des Lese-Helpers beim Modell ankommen.
    if (e instanceof HelperError && e.code.startsWith('HELPER_')) throw new ActionsError('ACTIONS_UNAVAILABLE')
    throw e
  }
  const status = (out as { status?: unknown } | null)?.status
  if (status === 'granted') return
  if (status === 'mail_not_running') throw new ActionsError('MAIL_NOT_RUNNING')
  if (status === 'denied' || status === 'undetermined') throw new ActionsError('AUTOMATION_NOT_GRANTED')
  // Unbekannter Status: es wurde noch nichts verschoben.
  throw new ActionsError('ACTIONS_UNEXPECTED_ANSWER')
}

// Nur die vier bekannten Antworten zaehlen; alles andere ist `failed` und beendet den Lauf, nie ein stilles `moved`.
function outcomeStatus(out: unknown): MoveStatus {
  switch ((out as { outcome?: unknown } | null)?.outcome) {
    case 'moved': return 'moved'
    case 'mismatch': return 'skipped_mismatch'
    case 'not_found': return 'skipped_not_found'
    case 'folder_not_found': return 'skipped_unsupported_folder'
    default: return 'failed'
  }
}

interface MovedEntry {
  index: number
  gid: number
  sourceMailboxId: number
  targetMailboxId: number
}

/**
 * Prueft im Index, ob die Mails im Ziel liegen und in der Quelle fehlen. Ein Fehler hier aendert nichts mehr an
 * der Verschiebung, also bleibt es bei moved_unverified statt die bereits vorliegenden Ergebnisse zu verlieren.
 */
async function verify(deps: MoverDeps, allowedMailboxIds: number[], moved: MovedEntry[], results: MoveResultEntry[]): Promise<void> {
  const now = deps.now ?? Date.now
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const deadline = now() + VERIFY_WINDOW_MS
  let open = moved
  for (;;) {
    try {
      const gids = [...new Set(open.map((m) => m.gid))]
      const found: LocateResult = locateResult.parse(await deps.helper.run('locate', { allowedMailboxIds, gids }))
      const byGid = new Map(found.messages.map((m) => [m.gid, m]))
      open = open.filter((m) => {
        const copies = byGid.get(m.gid)?.copies ?? []
        const done = copies.some((c) => c.mailboxId === m.targetMailboxId) && !copies.some((c) => c.mailboxId === m.sourceMailboxId)
        if (done) results[m.index]!.status = 'moved'
        return !done
      })
    } catch {
      // Index gerade nicht lesbar: im naechsten Durchgang wieder versuchen.
    }
    if (open.length === 0 || now() >= deadline) return
    await sleep(VERIFY_INTERVAL_MS)
  }
}

/**
 * Der Ablauf von move_messages. Reihenfolge: Freigabe, Policy, locate, je Eintrag Regeln, Sperre, Zug, zuletzt
 * Pruefung im Index. Der Lauf ist seriell und wiederholt nichts: Ein Fehlschlag kann halb angekommen sein. Die
 * Sperre steht deshalb vor dem Zug, damit auch ein misslungener Versuch gesperrt bleibt.
 */
export async function moveMessages(deps: MoverDeps, moves: MoveRequest[]): Promise<MoveMessagesResult> {
  const { helper, actions, locks, config } = deps
  // Text ohne Mail-Daten: Der Code INVALID_INPUT gibt ihn als Detail an das Modell weiter (respond.ts).
  if (moves.length > config.maxMoves) throw new HelperError('INVALID_INPUT', `At most ${config.maxMoves} messages can be moved in one call; this call asks for ${moves.length}.`)
  if (moves.length === 0) return { results: [], note: MOVE_NOTE }

  await requirePermission(actions)

  // Bewusst ohne den 60-s-Cache des Lesepakets: Regeln fuer einen Schreibzugriff laufen auf frischem Stand.
  const raw = listMailboxesResult.parse(await helper.run('list-mailboxes', {}))
  const policy = computePolicy(config, raw)

  const gids = [...new Set(moves.flatMap((m) => parseId(m.id) ?? []))]
  const located = new Map<number, LocateResult['messages'][number]>()
  if (gids.length > 0 && policy.allowedMailboxIds.length > 0) {
    const found = locateResult.parse(await helper.run('locate', { allowedMailboxIds: policy.allowedMailboxIds, gids }))
    for (const m of found.messages) located.set(m.gid, m)
  }

  const results: MoveResultEntry[] = []
  const moved: MovedEntry[] = []
  let attempted = false
  let aborted = false

  for (const move of moves) {
    const entry: MoveResultEntry = { id: move.id, status: 'skipped_aborted' }
    results.push(entry)
    if (aborted) continue

    const gid = parseId(move.id)
    const check = checkMove({ move, located: gid === null ? undefined : located.get(gid), policy, raw, excludeTargets: config.excludeTargets })
    if (!check.ok) {
      entry.status = check.status
      continue
    }
    // Ohne gueltige gid findet locate nichts, checkMove laesst den Eintrag also nie bis hierher.
    const lockKey = gid!

    try {
      // Pruefen und sperren in einem Schritt; die Sperre steht vor dem Versuch.
      if (!locks.tryLock(lockKey)) {
        entry.status = 'skipped_locked'
        continue
      }
    } catch (e) {
      // Vor dem ersten Zug ist nichts passiert: als Fehler melden. Danach zaehlen die vorliegenden Ergebnisse.
      if (!attempted) throw e
      entry.status = 'failed'
      aborted = true
      continue
    }

    attempted = true
    try {
      entry.status = outcomeStatus(
        await actions.run('move', { account: check.account, source: check.source, target: check.target, rowid: check.rowid, expectedMessageId: check.messageId }),
      )
    } catch {
      entry.status = 'failed'
    }
    if (entry.status === 'failed') {
      aborted = true
    } else if (entry.status === 'moved') {
      entry.status = 'moved_unverified'
      moved.push({ index: results.length - 1, gid: lockKey, sourceMailboxId: check.sourceMailboxId, targetMailboxId: check.targetMailboxId })
    }
  }

  if (moved.length > 0) await verify(deps, policy.allowedMailboxIds, moved, results)
  return { results, note: MOVE_NOTE }
}
