import { expect, test } from 'vitest'
import { messageLink } from '../src/links.js'

test('message link encodes brackets', () => {
  expect(messageLink('<abc@example.com>')).toBe('message://%3Cabc%40example.com%3E')
  expect(messageLink('abc@example.com')).toBe('message://%3Cabc%40example.com%3E')
  expect(messageLink(null)).toBeNull()
})
test('empty header gives no link', () => {
  expect(messageLink('')).toBeNull()
  expect(messageLink('  ')).toBeNull()
})
