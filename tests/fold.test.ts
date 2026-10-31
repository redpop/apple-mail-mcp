import { expect, test } from 'vitest'
import { fold } from '../src/fold.js'

test('fold matches swift', () => {
  expect(fold('Ärger')).toBe(fold('ärger'))
  expect(fold('STRASSE')).toBe(fold('straße'))
})

test('fold normalises to NFC', () => {
  // A plus kombinierendes Trema, als Escape, damit kein Editor es zusammensetzt.
  const decomposed = 'A\u0308'
  expect(decomposed).toHaveLength(2)
  expect(fold(decomposed)).toBe('\u00e4')
})
