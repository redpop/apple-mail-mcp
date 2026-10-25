import { expect, test } from 'vitest'
import { decodeCursor, encodeCursor, queryHash } from '../src/cursor.js'

test('cursor roundtrip and foreign hash', () => {
  const c = encodeCursor({ d: 1, g: 2 }, 'h')
  expect(decodeCursor(c, 'h')).toEqual({ d: 1, g: 2 })
  expect(() => decodeCursor(c, 'x')).toThrow(/INVALID_CURSOR/)
  expect(() => decodeCursor('###', 'h')).toThrow(/INVALID_CURSOR/)
})
test('cursor is base64url of the documented JSON', () => {
  const c = encodeCursor({ d: 1, g: 2 }, 'h')
  expect(c).toMatch(/^[A-Za-z0-9_-]+$/)
  expect(JSON.parse(Buffer.from(c, 'base64url').toString())).toEqual({ v: 1, d: 1, g: 2, h: 'h' })
})
test('decode rejects wrong version, non-integers, missing hash', () => {
  const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url')
  for (const o of [{ v: 2, d: 1, g: 2, h: 'h' }, { v: 1, d: 1.5, g: 2, h: 'h' }, { v: 1, d: 1, g: '2', h: 'h' }, { v: 1, d: 1, g: 2 }, [], null, 'x'])
    expect(() => decodeCursor(enc(o), 'h')).toThrow(expect.objectContaining({ code: 'INVALID_CURSOR' }))
  expect(() => decodeCursor(Buffer.from('not json').toString('base64url'), 'h')).toThrow(/INVALID_CURSOR/)
})
test('queryHash is key-order independent, 16 hex, depends on params and fingerprint', () => {
  const a = queryHash({ a: 1, b: { x: 1, y: [1, 2] } }, 'fp')
  expect(a).toMatch(/^[0-9a-f]{16}$/)
  expect(queryHash({ b: { y: [1, 2], x: 1 }, a: 1 }, 'fp')).toBe(a)
  expect(queryHash({ a: 2, b: { x: 1, y: [1, 2] } }, 'fp')).not.toBe(a)
  expect(queryHash({ a: 1, b: { x: 1, y: [1, 2] } }, 'other')).not.toBe(a)
})

test('decode rejects unsafe integers', () => {
  const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url')
  expect(() => decodeCursor(enc({ v: 1, d: 1e30, g: 2, h: 'h' }), 'h')).toThrow(/INVALID_CURSOR/)
  expect(() => decodeCursor(enc({ v: 1, d: 1, g: 1e30, h: 'h' }), 'h')).toThrow(/INVALID_CURSOR/)
})
