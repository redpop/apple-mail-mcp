import { expect, test } from 'vitest'
import { loadActionsConfig } from '../src/config.js'

const base = { APPLE_MAIL_ACCOUNTS: 'Work' }

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
