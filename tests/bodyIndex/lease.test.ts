import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { createLease, foreignLeaseValid, LEASE_TTL_MS } from '../../src/bodyIndex/lease.js'

const dir = () => mkdtempSync(join(tmpdir(), 'mailmcp-lease-'))

test('only one instance holds the lease; file is 0600', () => {
  const d = dir()
  const a = createLease(d)
  const b = createLease(d)
  expect(a.acquire()).toBe(true)
  expect(b.acquire()).toBe(false)
  expect(a.held()).toBe(true)
  expect(b.held()).toBe(false)
  expect(statSync(join(d, 'writer.lock')).mode & 0o777).toBe(0o600)
  expect(foreignLeaseValid(d)).toBe(true)
  a.release()
  expect(foreignLeaseValid(d)).toBe(false)
  expect(b.acquire()).toBe(true)
})

test('an expired heartbeat can be taken over, and the loser notices', () => {
  const d = dir()
  let t = 1_000_000
  const a = createLease(d, { now: () => t })
  const b = createLease(d, { now: () => t })
  expect(a.acquire()).toBe(true)
  t += LEASE_TTL_MS - 1
  expect(b.acquire()).toBe(false)
  expect(foreignLeaseValid(d, { now: () => t })).toBe(true)
  t += 2
  expect(foreignLeaseValid(d, { now: () => t })).toBe(false)
  expect(b.acquire()).toBe(true)
  expect(a.held()).toBe(false)
  expect(a.renew()).toBe(false)
  expect(b.renew()).toBe(true)
})

test('renew moves the heartbeat forward', () => {
  const d = dir()
  let t = 5000
  const a = createLease(d, { now: () => t })
  a.acquire()
  t += 10_000
  expect(a.renew()).toBe(true)
  expect(JSON.parse(readFileSync(join(d, 'writer.lock'), 'utf8')).heartbeat).toBe(t)
})

test('a dead process frees the lease', () => {
  const d = dir()
  writeFileSync(join(d, 'writer.lock'), JSON.stringify({ pid: 999999, heartbeat: Date.now(), token: 'x' }), { mode: 0o600 })
  const alive = (pid: number) => pid !== 999999
  expect(foreignLeaseValid(d, { alive })).toBe(false)
  expect(createLease(d, { alive }).acquire()).toBe(true)
})

test('a garbled lock file counts as free', () => {
  const d = dir()
  writeFileSync(join(d, 'writer.lock'), 'nonsense')
  expect(foreignLeaseValid(d)).toBe(false)
  expect(createLease(d).acquire()).toBe(true)
})

test('foreignLeaseValid is false without a directory', () => {
  expect(foreignLeaseValid(join(dir(), 'missing'))).toBe(false)
})
