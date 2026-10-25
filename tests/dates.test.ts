import { expect, test } from 'vitest'
import { formatLocal, parseDateInput } from '../src/dates.js'

test('date-only is local midnight', () => expect(formatLocal(parseDateInput('2026-10-01'))).toBe('2026-10-01T00:00:00+02:00'))
test('datetime without offset is rejected', () => expect(() => parseDateInput('2026-10-01T10:00:00')).toThrow(/INVALID_INPUT|offset/))
test('winter offset', () => expect(formatLocal(1767225600)).toBe('2026-01-01T01:00:00+01:00'))
test('datetime with Z and with offset', () => {
  expect(parseDateInput('2026-10-01T10:00:00Z')).toBe(1790848800)
  expect(parseDateInput('2026-10-01T12:00:00+02:00')).toBe(1790848800)
  expect(parseDateInput('2026-10-01T12:00+02:00')).toBe(1790848800)
})
test('garbage and impossible dates are INVALID_INPUT', () => {
  for (const s of ['', 'yesterday', '2026-13-01', '2026-02-30', '01.10.2026', '2026-10-01T10:00:00+0200'])
    expect(() => parseDateInput(s), s).toThrow(expect.objectContaining({ code: 'INVALID_INPUT' }))
})
test('output has no milliseconds', () => expect(formatLocal(1767225600.9)).toBe('2026-01-01T01:00:00+01:00'))
