import { expect, test } from 'vitest'
import { loadActionsConfig } from '../src/config.js'

const base = { APPLE_MAIL_ACCOUNTS: 'Work' }
const noHome = base

test('emptyAccountsIsConfigInvalid', () => {
  const r = loadActionsConfig({})
  expect(r.ok).toBe(false)
  if (!r.ok) expect(r.key).toBe('APPLE_MAIL_ACCOUNTS')
})

test('invalid base config passes through unchanged', () => {
  const r = loadActionsConfig({ ...base, APPLE_MAIL_MAX_RESULTS: '0' })
  expect(r).toMatchObject({ ok: false, key: 'APPLE_MAIL_MAX_RESULTS' })
})

test('maxMovesDefaults25', () => {
  const r = loadActionsConfig(base)
  expect(r.ok && r.config.maxMoves).toBe(25)
  expect(r.ok && r.config.excludeTargets).toEqual([])
  expect(r.ok && r.config.actionsPath).toBeNull()
})

test('maxMovesRejects0And101', () => {
  for (const v of ['0', '101', 'x']) {
    expect(loadActionsConfig({ ...base, APPLE_MAIL_MAX_MOVES: v })).toMatchObject({ ok: false, key: 'APPLE_MAIL_MAX_MOVES' })
  }
  expect(loadActionsConfig({ ...base, APPLE_MAIL_MAX_MOVES: '100' })).toMatchObject({ ok: true })
})

test('excludeTargetsAreParsed', () => {
  const r = loadActionsConfig({ ...base, APPLE_MAIL_MOVE_EXCLUDE_TARGETS: 'Archive, Junk', APPLE_MAIL_ACTIONS_PATH: '/x/y.app' })
  expect(r.ok && r.config.excludeTargets).toEqual(['Archive', 'Junk'])
  expect(r.ok && r.config.actionsPath).toBe('/x/y.app')
})

const withHome = { ...base, HOME: '/Users/test' }

test('attachment settings default', () => {
  const r = loadActionsConfig({ ...withHome, APPLE_MAIL_SAVE_ATTACHMENTS: 'false' })
  expect(r.ok && r.config.saveAttachments).toBe(false)
  expect(r.ok && r.config.attachmentDir).toBe('')
  const on = loadActionsConfig({ ...withHome, APPLE_MAIL_SAVE_ATTACHMENTS: 'true' })
  expect(on.ok && on.config.attachmentDir).toBe('/Users/test/Library/Caches/apple-mail-mcp/attachments')
  expect(r.ok && r.config.maxAttachmentBytes).toBe(26214400)
  expect(r.ok && r.config.attachmentTypes).toEqual('pdf,png,jpg,jpeg,heic,gif,txt,csv,ics,vcf,docx,xlsx,pptx,odt,ods,zip'.split(','))
})

test('attachment settings are validated', () => {
  expect(loadActionsConfig({ ...withHome, APPLE_MAIL_SAVE_ATTACHMENTS: 'yes' })).toMatchObject({ ok: false, key: 'APPLE_MAIL_SAVE_ATTACHMENTS' })
  const on = loadActionsConfig({ ...withHome, APPLE_MAIL_SAVE_ATTACHMENTS: 'true' })
  expect(on.ok && on.config.saveAttachments).toBe(true)
  for (const v of ['0', '104857601', 'x']) {
    expect(loadActionsConfig({ ...withHome, APPLE_MAIL_SAVE_ATTACHMENTS: 'true', APPLE_MAIL_MAX_ATTACHMENT_BYTES: v })).toMatchObject({ ok: false, key: 'APPLE_MAIL_MAX_ATTACHMENT_BYTES' })
  }
  expect(loadActionsConfig({ ...withHome, APPLE_MAIL_SAVE_ATTACHMENTS: 'true', APPLE_MAIL_MAX_ATTACHMENT_BYTES: '104857600' })).toMatchObject({ ok: true })
  expect(loadActionsConfig({ ...withHome, APPLE_MAIL_SAVE_ATTACHMENTS: 'true', APPLE_MAIL_ATTACHMENT_DIR: 'rel' })).toMatchObject({ ok: false, key: 'APPLE_MAIL_ATTACHMENT_DIR' })
  const d = loadActionsConfig({ ...withHome, APPLE_MAIL_SAVE_ATTACHMENTS: 'true', APPLE_MAIL_ATTACHMENT_DIR: '~/Downloads/mail' })
  expect(d.ok && d.config.attachmentDir).toBe('/Users/test/Downloads/mail')
})

test('the attachment folder is validated only when saving is on', () => {
  const on = { ...noHome, APPLE_MAIL_SAVE_ATTACHMENTS: 'true' }
  expect(loadActionsConfig(noHome)).toMatchObject({ ok: true })
  expect(loadActionsConfig({ ...noHome, HOME: '' })).toMatchObject({ ok: true })
  expect(loadActionsConfig({ ...noHome, APPLE_MAIL_ATTACHMENT_DIR: 'rel' })).toMatchObject({ ok: true })
  const off = loadActionsConfig(noHome)
  expect(off.ok && off.config.attachmentDir).toBe('')
  expect(loadActionsConfig(on)).toMatchObject({ ok: false, key: 'APPLE_MAIL_ATTACHMENT_DIR' })
  expect(loadActionsConfig({ ...on, HOME: '' })).toMatchObject({ ok: false, key: 'APPLE_MAIL_ATTACHMENT_DIR' })
  expect(loadActionsConfig({ ...on, APPLE_MAIL_ATTACHMENT_DIR: 'rel', HOME: '/Users/test' })).toMatchObject({ ok: false, key: 'APPLE_MAIL_ATTACHMENT_DIR' })
  expect(loadActionsConfig({ ...on, APPLE_MAIL_ATTACHMENT_DIR: '/tmp/x' })).toMatchObject({ ok: true })
})

test('attachment types are normalised and never allow executables', () => {
  const r = loadActionsConfig({ ...withHome, APPLE_MAIL_SAVE_ATTACHMENTS: 'true', APPLE_MAIL_ATTACHMENT_TYPES: ' PDF, .png ' })
  expect(r.ok && r.config.attachmentTypes).toEqual(['pdf', 'png'])
  const bad = loadActionsConfig({ ...withHome, APPLE_MAIL_SAVE_ATTACHMENTS: 'true', APPLE_MAIL_ATTACHMENT_TYPES: 'pdf,app' })
  expect(bad).toMatchObject({ ok: false, key: 'APPLE_MAIL_ATTACHMENT_TYPES' })
  expect(!bad.ok && bad.error).toContain('app')
})

test('attachment size and types are validated only when saving is on', () => {
  const bad = { ...withHome, APPLE_MAIL_MAX_ATTACHMENT_BYTES: 'x', APPLE_MAIL_ATTACHMENT_TYPES: 'pdf,app' }
  const off = loadActionsConfig(bad)
  expect(off.ok && off.config.maxAttachmentBytes).toBe(26214400)
  expect(off.ok && off.config.attachmentTypes).toContain('pdf')
  expect(loadActionsConfig({ ...bad, APPLE_MAIL_SAVE_ATTACHMENTS: 'true' })).toMatchObject({ ok: false, key: 'APPLE_MAIL_MAX_ATTACHMENT_BYTES' })
  expect(loadActionsConfig({ ...withHome, APPLE_MAIL_SAVE_ATTACHMENTS: 'true', APPLE_MAIL_ATTACHMENT_TYPES: 'pdf,app' })).toMatchObject({ ok: false, key: 'APPLE_MAIL_ATTACHMENT_TYPES' })
})
