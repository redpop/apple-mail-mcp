import { expect, test } from 'vitest'
import { classifierVersion, parserVersion } from '../../src/bodyIndex/versions.js'

test('versions are stable 16 hex hashes over existing sources', () => {
  expect(classifierVersion()).toMatch(/^[0-9a-f]{16}$/)
  expect(parserVersion()).toMatch(/^[0-9a-f]{16}$/)
  expect(classifierVersion()).not.toBe(parserVersion())
})
