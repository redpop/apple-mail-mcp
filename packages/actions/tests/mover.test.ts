import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HelperError } from '@redpop/apple-mail-mcp/dist/errors.js'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { loadActionsConfig } from '../src/config.js'
import { ActionsError, describeActionsError } from '../src/errors.js'
import { MoveLocks } from '../src/locks.js'
import { moveMessages, type MoverDeps } from '../src/mover.js'
import { ARCHIVE, FakeMail, HOME, INBOX, message, NESTED, WORK } from './fakes/fakeActions.js'

let dir: string
let lockFile: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'mover-'))
  lockFile = join(dir, 'move-locks.json')
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

function deps(mail: FakeMail, over: Partial<MoverDeps> & { env?: NodeJS.ProcessEnv } = {}): MoverDeps & { clock: { t: number }; sleeps: number[] } {
  const r = loadActionsConfig({ APPLE_MAIL_ACCOUNTS: `${WORK},${HOME}`, ...over.env })
  if (!r.ok) throw new Error(r.error)
  const clock = { t: 1_000_000 }
  const sleeps: number[] = []
  return {
    helper: mail.helper,
    actions: mail.actions,
    locks: new MoveLocks(lockFile, () => clock.t),
    config: r.config,
    now: () => clock.t,
    sleep: async (ms) => {
      sleeps.push(ms)
      clock.t += ms
    },
    ...over,
    clock,
    sleeps,
  }
}

const mv = (gid: number, target = ARCHIVE, source?: number) => ({
  id: String(gid),
  targetMailboxId: String(target),
  ...(source !== undefined ? { sourceMailboxId: String(source) } : {}),
})

const rowidOf = (gid: number) => gid + 1000
const statuses = (r: { results: { status: string }[] }) => r.results.map((x) => x.status)

test('movesInOrderOneAtATime', async () => {
  const mail = new FakeMail([message(1), message(2), message(3)])
  const r = await moveMessages(deps(mail), [mv(3), mv(1), mv(2)])
  expect(mail.moveCalls.map((p) => p.rowid)).toEqual([rowidOf(3), rowidOf(1), rowidOf(2)])
  expect(mail.maxActive).toBe(1)
  expect(r.results.map((x) => x.id)).toEqual(['3', '1', '2'])
  expect(statuses(r)).toEqual(['moved', 'moved', 'moved'])
})

test('sendsTheBundleOnlyTheFixedFields', async () => {
  const mail = new FakeMail([message(1)])
  await moveMessages(deps(mail), [mv(1, NESTED)])
  expect(mail.moveCalls).toEqual([{ account: 'Work', source: 'INBOX', target: 'Projects/Alpha', rowid: rowidOf(1), expectedMessageId: '<1@example.com>' }])
})

test('runsPermissionThenPolicyThenLocateThenMove', async () => {
  const mail = new FakeMail([message(1)])
  await moveMessages(deps(mail), [mv(1)])
  expect(mail.order.slice(0, 4)).toEqual(['permission', 'list-mailboxes', 'locate', 'move'])
})

test('rejectsMoreThanMaxMoves', async () => {
  const mail = new FakeMail([message(1), message(2)])
  const err = await moveMessages(deps(mail, { env: { APPLE_MAIL_MAX_MOVES: '1' } }), [mv(1), mv(2)]).catch((e: unknown) => e)
  expect(err).toBeInstanceOf(HelperError)
  expect((err as HelperError).code).toBe('INVALID_INPUT')
  expect(mail.actionCalls).toEqual([])
  expect(mail.helperCalls).toEqual([])
})

test('noMovesAsksNoOne', async () => {
  const mail = new FakeMail()
  const r = await moveMessages(deps(mail), [])
  expect(r.results).toEqual([])
  expect(mail.order).toEqual([])
})

test('sameIdTwiceSecondIsLocked', async () => {
  const mail = new FakeMail([message(1)])
  const r = await moveMessages(deps(mail), [mv(1), mv(1, NESTED)])
  expect(statuses(r)).toEqual(['moved', 'skipped_locked'])
  expect(mail.moveCalls).toHaveLength(1)
})

test('lockedFromEarlierCallIsSkipped', async () => {
  const mail = new FakeMail([message(1)])
  const d = deps(mail)
  d.locks.lock(1)
  const r = await moveMessages(d, [mv(1)])
  expect(statuses(r)).toEqual(['skipped_locked'])
  expect(mail.moveCalls).toEqual([])
})

test('lockIsSetBeforeTheMoveAttempt', async () => {
  const mail = new FakeMail([message(1)])
  const locks = new MoveLocks(lockFile)
  let lockedDuringMove = false
  const inner = mail.actions.run
  mail.actions.run = async (command, payload) => {
    if (command === 'move') {
      lockedDuringMove = locks.isLocked(1)
      throw new HelperError('MOVE_FAILED', 'Apple Event error -1.')
    }
    return inner(command, payload)
  }
  const d = deps(mail)
  d.clock.t = Date.now()
  await moveMessages(d, [mv(1)])
  expect(lockedDuringMove).toBe(true)
  expect(d.locks.isLocked(1)).toBe(true)
})

test('aLockedEntryDoesNotReachTheBundleEvenWithOtherEntries', async () => {
  const mail = new FakeMail([message(1), message(2)])
  const d = deps(mail)
  d.locks.lock(1)
  const r = await moveMessages(d, [mv(1), mv(2)])
  expect(statuses(r)).toEqual(['skipped_locked', 'moved'])
  expect(mail.moveCalls.map((p) => p.rowid)).toEqual([rowidOf(2)])
})

test('mismatchMapsToSkippedMismatch', async () => {
  const mail = new FakeMail([message(1), message(2)])
  mail.outcomes.set(rowidOf(1), { outcome: 'mismatch' })
  const d = deps(mail)
  const r = await moveMessages(d, [mv(1), mv(2)])
  expect(statuses(r)).toEqual(['skipped_mismatch', 'moved'])
  expect(d.locks.isLocked(1)).toBe(true)
})

test('notFoundMapsToSkippedNotFound', async () => {
  const mail = new FakeMail([message(1), message(2)])
  mail.outcomes.set(rowidOf(1), { outcome: 'not_found', code: -1728 })
  const d = deps(mail)
  const r = await moveMessages(d, [mv(1), mv(2)])
  expect(statuses(r)).toEqual(['skipped_not_found', 'moved'])
  expect(d.locks.isLocked(1)).toBe(true)
})

test('folderNotFoundMapsToSkippedUnsupportedFolder', async () => {
  const mail = new FakeMail([message(1), message(2)])
  mail.outcomes.set(rowidOf(1), { outcome: 'folder_not_found' })
  const r = await moveMessages(deps(mail), [mv(1), mv(2)])
  expect(statuses(r)).toEqual(['skipped_unsupported_folder', 'moved'])
})

describe('errors during a move', () => {
  test('timeoutMarksFailedAndAbortsTheRest', async () => {
    const mail = new FakeMail([message(1), message(2), message(3), message(4)])
    mail.outcomes.set(rowidOf(2), { error: new HelperError('HELPER_TIMEOUT', 'The helper did not answer in time.') })
    const r = await moveMessages(deps(mail), [mv(1), mv(2), mv(3), mv(4)])
    expect(statuses(r)).toEqual(['moved', 'failed', 'skipped_aborted', 'skipped_aborted'])
    expect(mail.moveCalls.map((p) => p.rowid)).toEqual([rowidOf(1), rowidOf(2)])
  })

  test.each(['MOVE_FAILED', 'HELPER_CRASHED', 'MAIL_NOT_RUNNING', 'AUTOMATION_NOT_GRANTED'])('%s mid-batch keeps the results and aborts', async (code) => {
    const mail = new FakeMail([message(1), message(2), message(3)])
    mail.outcomes.set(rowidOf(2), { error: new HelperError(code, 'x') })
    const r = await moveMessages(deps(mail), [mv(1), mv(2), mv(3)])
    expect(statuses(r)).toEqual(['moved', 'failed', 'skipped_aborted'])
    expect(mail.moveCalls).toHaveLength(2)
  })

  test('an error on the very first move call is failed, not thrown, because it may be half done', async () => {
    const mail = new FakeMail([message(1), message(2)])
    mail.outcomes.set(rowidOf(1), { error: new HelperError('MOVE_FAILED', 'x') })
    const r = await moveMessages(deps(mail), [mv(1), mv(2)])
    expect(statuses(r)).toEqual(['failed', 'skipped_aborted'])
  })

  test('an entry a rule would skip after the abort still reads aborted', async () => {
    const mail = new FakeMail([message(1), message(2)])
    mail.outcomes.set(rowidOf(1), { error: new HelperError('MOVE_FAILED', 'x') })
    const r = await moveMessages(deps(mail), [mv(1), mv(2, INBOX)])
    expect(statuses(r)).toEqual(['failed', 'skipped_aborted'])
  })

  test('an unknown outcome is failed and never moved', async () => {
    const mail = new FakeMail([message(1), message(2)])
    mail.outcomes.set(rowidOf(1), { outcome: 'surprise' })
    const r = await moveMessages(deps(mail), [mv(1), mv(2)])
    expect(statuses(r)).toEqual(['failed', 'skipped_aborted'])
  })

  test('a malformed move answer is failed', async () => {
    const mail = new FakeMail([message(1)])
    const inner = mail.actions.run
    mail.actions.run = async (command, payload) => (command === 'move' ? null : inner(command, payload))
    const r = await moveMessages(deps(mail), [mv(1)])
    expect(statuses(r)).toEqual(['failed'])
  })
})

describe('before the first move', () => {
  test('mailNotRunningThrowsBeforeAnyMove', async () => {
    const mail = new FakeMail([message(1)])
    mail.permission = { status: 'mail_not_running' }
    const err = await moveMessages(deps(mail), [mv(1)]).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ActionsError)
    expect((err as ActionsError).code).toBe('MAIL_NOT_RUNNING')
    expect(mail.moveCalls).toEqual([])
    expect(mail.helperCalls).toEqual([])
  })

  test.each(['denied', 'undetermined'])('permission %s throws AUTOMATION_NOT_GRANTED', async (status) => {
    const mail = new FakeMail([message(1)])
    mail.permission = { status }
    const err = await moveMessages(deps(mail), [mv(1)]).catch((e: unknown) => e)
    expect((err as ActionsError).code).toBe('AUTOMATION_NOT_GRANTED')
    expect(mail.moveCalls).toEqual([])
  })

  test.each(['MAIL_NOT_RUNNING', 'AUTOMATION_NOT_GRANTED'])('a %s error from the permission command becomes an ActionsError', async (code) => {
    const mail = new FakeMail([message(1)])
    mail.permissionError = new HelperError(code, 'x')
    const err = await moveMessages(deps(mail), [mv(1)]).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ActionsError)
    expect((err as ActionsError).code).toBe(code)
  })

  test.each(['HELPER_MISSING', 'HELPER_CRASHED', 'HELPER_TIMEOUT', 'HELPER_VERSION_MISMATCH'])('a %s error from the actions bundle becomes ACTIONS_UNAVAILABLE', async (code) => {
    const mail = new FakeMail([message(1)])
    mail.permissionError = new HelperError(code, 'x')
    const err = await moveMessages(deps(mail), [mv(1)]).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ActionsError)
    expect((err as ActionsError).code).toBe('ACTIONS_UNAVAILABLE')
    expect(mail.moveCalls).toEqual([])
  })

  test('an unknown permission status stops everything', async () => {
    const mail = new FakeMail([message(1)])
    mail.permission = { status: 'maybe' }
    await expect(moveMessages(deps(mail), [mv(1)])).rejects.toMatchObject({ code: 'ACTIONS_UNEXPECTED_ANSWER' })
    expect(mail.moveCalls).toEqual([])
    expect(describeActionsError('ACTIONS_UNEXPECTED_ANSWER')).toMatch(/no move was attempted/)
  })

  test('an unreadable lock file before any move throws and moves nothing', async () => {
    writeFileSync(lockFile, 'not json')
    const mail = new FakeMail([message(1)])
    const err = await moveMessages(deps(mail), [mv(1)]).catch((e: unknown) => e)
    expect((err as ActionsError).code).toBe('LOCK_UNAVAILABLE')
    expect(mail.moveCalls).toEqual([])
  })
})

test('a lock failure after a move keeps the results and aborts', async () => {
  const mail = new FakeMail([message(1), message(2), message(3)])
  const d = deps(mail)
  d.locks = {
    isLocked: () => false,
    lock: () => undefined,
    tryLock: (gid) => {
      if (gid === 2) throw new ActionsError('LOCK_UNAVAILABLE')
      return true
    },
  }
  const r = await moveMessages(d, [mv(1), mv(2), mv(3)])
  expect(statuses(r)).toEqual(['moved', 'failed', 'skipped_aborted'])
  expect(mail.moveCalls).toHaveLength(1)
})

describe('locate input', () => {
  test('sends the allowed mailboxes and each gid once', async () => {
    const mail = new FakeMail([message(1)])
    await moveMessages(deps(mail, { env: { APPLE_MAIL_ACCOUNTS: 'Work' } }), [mv(1), mv(1)])
    const first = mail.locateCalls[0]!
    expect(first.gids).toEqual([1])
    expect(first.allowedMailboxIds).toContain(INBOX)
    expect(first.allowedMailboxIds).not.toContain(20)
  })

  test('a malformed or oversized id never reaches locate or the bundle', async () => {
    const mail = new FakeMail([message(1)])
    const r = await moveMessages(deps(mail), [
      { id: 'abc', targetMailboxId: String(ARCHIVE) },
      { id: '9007199254740993', targetMailboxId: String(ARCHIVE) },
      mv(1),
    ])
    expect(statuses(r)).toEqual(['skipped_source_not_visible', 'skipped_source_not_visible', 'moved'])
    expect(mail.locateCalls[0]!.gids).toEqual([1])
    expect(mail.moveCalls).toHaveLength(1)
  })

  test('no valid id means no locate at all', async () => {
    const mail = new FakeMail()
    const r = await moveMessages(deps(mail), [{ id: 'abc', targetMailboxId: String(ARCHIVE) }])
    expect(statuses(r)).toEqual(['skipped_source_not_visible'])
    expect(mail.locateCalls).toEqual([])
  })

  test('no visible mailbox means no locate at all', async () => {
    const mail = new FakeMail([message(1)])
    mail.raw.mailboxes = []
    const r = await moveMessages(deps(mail), [mv(1)])
    expect(statuses(r)).toEqual(['skipped_target_not_allowed'])
    expect(mail.locateCalls).toEqual([])
  })

  test('the policy is read fresh on every call', async () => {
    const mail = new FakeMail([message(1), message(2)])
    const d = deps(mail)
    await moveMessages(d, [mv(1)])
    await moveMessages(d, [mv(2)])
    expect(mail.helperCalls.filter((c) => c.command === 'list-mailboxes')).toHaveLength(2)
  })
})

describe('verification', () => {
  test('verifiedWhenLocateShowsTargetCopyOnly', async () => {
    const mail = new FakeMail([message(1)])
    const d = deps(mail)
    const r = await moveMessages(d, [mv(1)])
    expect(statuses(r)).toEqual(['moved'])
    expect(d.sleeps).toEqual([])
  })

  test('unverifiedAfter10s', async () => {
    const mail = new FakeMail([message(1)])
    mail.applyMoves = false
    const d = deps(mail)
    const start = d.clock.t
    const r = await moveMessages(d, [mv(1)])
    expect(statuses(r)).toEqual(['moved_unverified'])
    expect(d.clock.t - start).toBe(10_000)
    expect(new Set(d.sleeps)).toEqual(new Set([500]))
  })

  test('a copy in the target plus a copy still in the source stays unverified', async () => {
    const mail = new FakeMail([message(1, [{ rowid: rowidOf(1), mailboxId: INBOX }])])
    mail.applyMoves = false
    const inner = mail.actions.run
    mail.actions.run = async (command, payload) => {
      const out = await inner(command, payload)
      if (command === 'move') mail.messages.get(1)!.copies.push({ rowid: 5, mailboxId: ARCHIVE })
      return out
    }
    const r = await moveMessages(deps(mail), [mv(1)])
    expect(statuses(r)).toEqual(['moved_unverified'])
  })

  test('gone from the source without a copy in the target stays unverified', async () => {
    const mail = new FakeMail([message(1)])
    mail.applyMoves = false
    const inner = mail.actions.run
    mail.actions.run = async (command, payload) => {
      const out = await inner(command, payload)
      if (command === 'move') mail.messages.get(1)!.copies = []
      return out
    }
    const r = await moveMessages(deps(mail), [mv(1)])
    expect(statuses(r)).toEqual(['moved_unverified'])
  })

  test('confirms late when the index catches up within the window', async () => {
    const mail = new FakeMail([message(1)])
    mail.applyMoves = false
    const d = deps(mail)
    const start = d.clock.t
    const sleep = d.sleep!
    d.sleep = async (ms) => {
      await sleep(ms)
      if (d.clock.t - start >= 3_000) mail.messages.get(1)!.copies = [{ rowid: 5, mailboxId: ARCHIVE }]
    }
    const r = await moveMessages(d, [mv(1)])
    expect(statuses(r)).toEqual(['moved'])
    expect(d.clock.t - start).toBe(3_000)
  })

  test('another visible copy elsewhere does not block verification', async () => {
    const mail = new FakeMail([message(1, [{ rowid: rowidOf(1), mailboxId: INBOX }, { rowid: 9, mailboxId: NESTED }])])
    const r = await moveMessages(deps(mail), [mv(1, ARCHIVE, INBOX)])
    expect(statuses(r)).toEqual(['moved'])
  })

  test('only moved entries are polled', async () => {
    const mail = new FakeMail([message(1), message(2)])
    mail.outcomes.set(rowidOf(1), { outcome: 'mismatch' })
    await moveMessages(deps(mail), [mv(1), mv(2)])
    expect(mail.locateCalls[1]!.gids).toEqual([2])
  })

  test('nothing moved means no polling', async () => {
    const mail = new FakeMail([message(1)])
    mail.outcomes.set(rowidOf(1), { outcome: 'mismatch' })
    await moveMessages(deps(mail), [mv(1)])
    expect(mail.locateCalls).toHaveLength(1)
  })

  test('a locate error while verifying leaves moved_unverified and does not throw', async () => {
    const mail = new FakeMail([message(1)])
    mail.locateErrorFrom = 2
    const r = await moveMessages(deps(mail), [mv(1)])
    expect(statuses(r)).toEqual(['moved_unverified'])
  })

  test('entries that moved before an abort are still verified', async () => {
    const mail = new FakeMail([message(1), message(2)])
    mail.outcomes.set(rowidOf(2), { error: new HelperError('MOVE_FAILED', 'x') })
    const r = await moveMessages(deps(mail), [mv(1), mv(2)])
    expect(statuses(r)).toEqual(['moved', 'failed'])
  })
})

test('noteSaysStatusIsLocalNotServer', async () => {
  const mail = new FakeMail([message(1)])
  const r = await moveMessages(deps(mail), [mv(1)])
  expect(r.note).toMatch(/local/i)
  expect(r.note).toMatch(/not the mail server/i)
})

test('results and note hold no mail data', async () => {
  const mail = new FakeMail([
    message(1, undefined, { subject: 'Private subject line', fromAddress: 'someone@example.net' }),
    message(2, undefined, { subject: 'Your verification code' }),
  ])
  const r = await moveMessages(deps(mail), [mv(1), mv(2)])
  for (const e of r.results) expect(Object.keys(e).sort()).toEqual(['id', 'status'])
  const text = JSON.stringify(r)
  for (const leak of ['Private subject', 'someone@', 'verification', 'Archive', 'INBOX', 'Work']) expect(text).not.toContain(leak)
})

test('thrown errors hold no mail data', async () => {
  const mail = new FakeMail([message(1, undefined, { subject: 'Private subject line' })])
  mail.permission = { status: 'denied' }
  const err = (await moveMessages(deps(mail), [mv(1)]).catch((e: unknown) => e)) as Error
  expect(err.message).toBe('AUTOMATION_NOT_GRANTED')
})
