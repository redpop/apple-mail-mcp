import { expect, test } from 'vitest'
import { fold } from '../src/fold.js'

test('fold matches swift', () => {
  expect(fold('Ärger')).toBe(fold('ärger'))
  expect(fold('STRASSE')).toBe(fold('straße'))
})

test('fold normalises to NFC', () => {
  expect(fold('Ä')).toBe('ä')
})
