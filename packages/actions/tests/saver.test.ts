import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HelperError } from '@redpop/apple-mail-mcp/dist/errors.js'
import type { HelperRunner } from '@redpop/apple-mail-mcp/dist/helper.js'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { loadActionsConfig } from '../src/config.js'
import { ActionsError } from '../src/errors.js'
import { saveAttachment, type SaverDeps } from '../src/saver.js'
import { FakeMail, HOME, INBOX, message, WORK } from './fakes/fakeActions.js'

let dir: string
let base: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'saver-'))
  base = join(dir, 'handover')
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

type Bundle = (payload: Record<string, unknown>, slotDir: string) => unknown

const withAtt = (gid: number, name = 'Invoice.pdf') =>
  message(gid, [{ rowid: gid + 1000, mailboxId: INBOX, attachments: [{ partId: '1.2', name }] } as never])

function setup(mail: FakeMail, bundle: Bundle, env: NodeJS.ProcessEnv = {}) {
  const r = loadActionsConfig({ APPLE_MAIL_ACCOUNTS: `${WORK},${HOME}`, APPLE_MAIL_SAVE_ATTACHMENTS: 'true', APPLE_MAIL_ATTACHMENT_DIR: base, HOME: dir, ...env })
  if (!r.ok) throw new Error(r.error)
  const calls: Record<string, unknown>[] = []
  const actions: HelperRunner = {
    run: async (command, payload) => {
      if (command !== 'save-attachment') return mail.actions.run(command, payload)
      calls.push(payload)
      return bundle(payload, join(base, payload.slot as string))
    },
  }
  const deps: SaverDeps = { helper: mail.helper, actions, config: r.config }
  return { deps, calls }
}

const req = { id: '1', attachment: 0 }
const writes = (content: string): Bundle => (p, slot) => {
  writeFileSync(join(slot, p.fileName as string), content)
  return { outcome: 'saved' }
}
const slots = () => (existsSync(base) ? readdirSync(base) : [])

describe('saveAttachment', () => {
  test('happy path', async () => {
    const mail = new FakeMail([withAtt(1)])
    const { deps, calls } = setup(mail, writes('hello'))
    const r = await saveAttachment(deps, req)
    expect(r.status).toBe('saved')
    expect(r.name).toBe('Invoice.pdf')
    expect(r.bytes).toBe(5)
    expect(r.path!.startsWith(base + '/att-')).toBe(true)
    expect(r.path!.endsWith('/Invoice.pdf')).toBe(true)
    expect(existsSync(r.path!)).toBe(true)
    expect(calls[0]).toMatchObject({ account: 'Work', source: 'INBOX', rowid: 1001, expectedMessageId: '<1@example.com>', partId: '1.2', fileName: 'Invoice.pdf', maxBytes: 26214400 })
    expect(mail.order.slice(0, 3)).toEqual(['permission', 'list-mailboxes', 'locate'])
    expect(mail.locateCalls[0]).toMatchObject({ gids: [1], withAttachments: true })
  })

  test('creates base and slot with mode 0700', async () => {
    const mail = new FakeMail([withAtt(1)])
    const modes: number[] = []
    const { deps } = setup(mail, (p, slot) => {
      modes.push(statSync(slot).mode & 0o777)
      return writes('x')(p, slot)
    })
    await saveAttachment(deps, req)
    expect(statSync(base).mode & 0o777).toBe(0o700)
    expect(modes).toEqual([0o700])
  })

  test.each([
    ['too_large', 'skipped_too_large'],
    ['mismatch', 'skipped_mismatch'],
    ['not_found', 'skipped_not_found'],
    ['folder_not_found', 'skipped_unsupported_folder'],
    ['attachment_not_found', 'skipped_attachment_not_found'],
  ])('outcome %s maps to %s and removes the slot', async (outcome, status) => {
    const mail = new FakeMail([withAtt(1)])
    const { deps } = setup(mail, () => ({ outcome }))
    const r = await saveAttachment(deps, req)
    expect(r.status).toBe(status)
    expect(r.path).toBeUndefined()
    expect(slots()).toEqual([])
  })

  test('unknown outcome is failed', async () => {
    const { deps } = setup(new FakeMail([withAtt(1)]), () => ({ outcome: 'weird' }))
    expect((await saveAttachment(deps, req)).status).toBe('failed')
    expect(slots()).toEqual([])
  })

  test('symlink is failed and removed, target untouched', async () => {
    const outside = join(dir, 'secret.txt')
    writeFileSync(outside, 'secret')
    const { deps } = setup(new FakeMail([withAtt(1)]), (p, slot) => {
      symlinkSync(outside, join(slot, p.fileName as string))
      return { outcome: 'saved' }
    })
    const r = await saveAttachment(deps, req)
    expect(r.status).toBe('failed')
    expect(existsSync(outside)).toBe(true)
    expect(slots()).toEqual([])
  })

  test('file over the limit is failed and removed', async () => {
    const { deps } = setup(new FakeMail([withAtt(1)]), writes('x'.repeat(11)), { APPLE_MAIL_MAX_ATTACHMENT_BYTES: '10' })
    const r = await saveAttachment(deps, req)
    expect(r.status).toBe('failed')
    expect(slots()).toEqual([])
  })

  test('saved but no file is failed', async () => {
    const { deps } = setup(new FakeMail([withAtt(1)]), () => ({ outcome: 'saved' }))
    expect((await saveAttachment(deps, req)).status).toBe('failed')
    expect(slots()).toEqual([])
  })

  test('bundle throwing a plain error is failed', async () => {
    const { deps } = setup(new FakeMail([withAtt(1)]), () => {
      throw new HelperError('SAVE_FAILED', 'boom')
    })
    expect((await saveAttachment(deps, req)).status).toBe('failed')
    expect(slots()).toEqual([])
  })

  test('Mail not running passes through and leaves no slot', async () => {
    const { deps } = setup(new FakeMail([withAtt(1)]), () => {
      throw new HelperError('MAIL_NOT_RUNNING', 'x')
    })
    await expect(saveAttachment(deps, req)).rejects.toMatchObject({ code: 'MAIL_NOT_RUNNING' })
    expect(slots()).toEqual([])
  })

  test('permission failure passes through before touching the folder', async () => {
    const mail = new FakeMail([withAtt(1)])
    mail.permission = { status: 'denied' }
    const { deps, calls } = setup(mail, writes('x'))
    await expect(saveAttachment(deps, req)).rejects.toMatchObject({ code: 'AUTOMATION_NOT_GRANTED' })
    expect(calls).toEqual([])
    expect(existsSync(base)).toBe(false)
  })

  test('rule skip does not create a folder', async () => {
    const mail = new FakeMail([withAtt(1, 'tool.sh')])
    const { deps, calls } = setup(mail, writes('x'))
    expect((await saveAttachment(deps, req)).status).toBe('skipped_type_not_allowed')
    expect(calls).toEqual([])
    expect(existsSync(base)).toBe(false)
  })

  test('unknown message is skipped', async () => {
    const { deps } = setup(new FakeMail([]), writes('x'))
    expect((await saveAttachment(deps, req)).status).toBe('skipped_source_not_visible')
  })

  test('base not creatable throws ATTACHMENT_DIR_UNAVAILABLE', async () => {
    writeFileSync(base, 'a file, not a folder')
    const { deps, calls } = setup(new FakeMail([withAtt(1)]), writes('x'))
    const err = await saveAttachment(deps, req).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ActionsError)
    expect((err as ActionsError).code).toBe('ATTACHMENT_DIR_UNAVAILABLE')
    expect(calls).toEqual([])
  })

  test('saving off (empty dir) throws ATTACHMENT_DIR_UNAVAILABLE', async () => {
    const { deps } = setup(new FakeMail([withAtt(1)]), writes('x'), { APPLE_MAIL_SAVE_ATTACHMENTS: 'false' })
    await expect(saveAttachment(deps, req)).rejects.toMatchObject({ code: 'ATTACHMENT_DIR_UNAVAILABLE' })
  })

  test('never removes a non-empty slot', async () => {
    const { deps } = setup(new FakeMail([withAtt(1)]), (_p, slot) => {
      writeFileSync(join(slot, 'other.bin'), 'x')
      return { outcome: 'mismatch' }
    })
    await saveAttachment(deps, req)
    const [s] = slots()
    expect(readdirSync(join(base, s!))).toEqual(['other.bin'])
  })
})
