import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { loadConfig } from '../../src/config.js'
import { createLease } from '../../src/bodyIndex/lease.js'
import { bodyIndexEnabled, cleanupOnStartup } from '../../src/bodyIndex/lifecycle.js'

function withIndex(): string {
  const dir = join(mkdtempSync(join(tmpdir(), 'mailmcp-life-')), 'body-index')
  mkdirSync(dir, { mode: 0o700 })
  writeFileSync(join(dir, 'index.sqlite'), 'x')
  return dir
}

test('enabled only with body search', () => {
  const cfg = (env: Record<string, string>) => (loadConfig(env) as { ok: true; config: never }).config
  expect(bodyIndexEnabled(cfg({}))).toBe(false)
  expect(bodyIndexEnabled(cfg({ APPLE_MAIL_BODY_INDEX: 'true' }))).toBe(true)
  expect(bodyIndexEnabled(cfg({ APPLE_MAIL_BODY_INDEX: 'true', APPLE_MAIL_BODY_SEARCH: 'false' }))).toBe(false)
})

test('disabled: deletes the directory with one stderr line', () => {
  const dir = withIndex()
  const logs: string[] = []
  expect(cleanupOnStartup(loadConfig({}), { dir, log: (l) => logs.push(l) })).toBe('deleted')
  expect(existsSync(dir)).toBe(false)
  expect(logs).toEqual(['body index is off; deleted the index'])
})

test('body index without body search counts as disabled and deletes', () => {
  const dir = withIndex()
  expect(cleanupOnStartup(loadConfig({ APPLE_MAIL_BODY_INDEX: 'true', APPLE_MAIL_BODY_SEARCH: 'false' }), { dir, log: () => {} })).toBe('deleted')
  expect(existsSync(dir)).toBe(false)
})

test('disabled but another server holds a valid lease: keeps it', () => {
  const dir = withIndex()
  createLease(dir).acquire()
  expect(cleanupOnStartup(loadConfig({}), { dir, log: () => {} })).toBe('kept')
  expect(existsSync(join(dir, 'index.sqlite'))).toBe(true)
})

test('disabled and the lease expired: deletes', () => {
  const dir = withIndex()
  createLease(dir, { now: () => Date.now() - 61_000 }).acquire()
  expect(cleanupOnStartup(loadConfig({}), { dir, log: () => {} })).toBe('deleted')
  expect(existsSync(dir)).toBe(false)
})

test('CONFIG_INVALID never deletes', () => {
  const dir = withIndex()
  expect(cleanupOnStartup(loadConfig({ APPLE_MAIL_INCLUDE_JUNK: 'maybe' }), { dir, log: () => {} })).toBe('invalid')
  expect(existsSync(join(dir, 'index.sqlite'))).toBe(true)
})

test('enabled never deletes, also when node:sqlite would be missing', () => {
  const dir = withIndex()
  expect(cleanupOnStartup(loadConfig({ APPLE_MAIL_BODY_INDEX: 'true' }), { dir, log: () => {} })).toBe('enabled')
  expect(existsSync(join(dir, 'index.sqlite'))).toBe(true)
})

test('disabled and no directory: nothing to do', () => {
  const dir = join(mkdtempSync(join(tmpdir(), 'mailmcp-life-')), 'body-index')
  expect(cleanupOnStartup(loadConfig({}), { dir, log: () => {} })).toBe('absent')
})
