import { expect, test } from 'vitest'
import {
  DEFAULT_ATTACHMENT_TYPES,
  NEVER_ALLOWED,
  extensionOf,
  isSafeFileName,
  isSlot,
  resolveAttachmentDir,
  safeFileName,
  typeAllowed,
} from '../src/attachmentFiles.js'

// Gleiche Faelle spiegelt spaeter der Swift-Test des Bundles.
export const NAME_CASES: Array<[string, string]> = [
  ['Rechnung.pdf', 'Rechnung.pdf'],
  ['../../x.pdf', '_.._x.pdf'],
  ['.hidden', 'hidden'],
  ['a:b.pdf', 'a_b.pdf'],
  ['\u0007.pdf', '_.pdf'],
  ['', 'fallback.bin'],
  ['Bild \u{1F600}.png', 'Bild \u{1F600}.png'],
]

test('safeFileName table', () => {
  for (const [input, expected] of NAME_CASES) expect(safeFileName(input, 'fallback.bin')).toBe(expected)
})

test('safeFileName trims long names to 200 bytes and keeps the extension', () => {
  const out = safeFileName('…'.repeat(300) + '.pdf', 'fallback.bin')
  expect(Buffer.byteLength(out, 'utf8')).toBeLessThanOrEqual(200)
  expect(out.endsWith('.pdf')).toBe(true)
  expect(isSafeFileName(out)).toBe(true)
})

test('safeFileName falls back when nothing is left', () => {
  expect(safeFileName('...', 'fallback.bin')).toBe('fallback.bin')
})

test('isSafeFileName', () => {
  expect(isSafeFileName('Rechnung.pdf')).toBe(true)
  for (const bad of ['', '.x', 'a/b', 'a:b', 'a\u0000b', 'a\u007fb', 'a\u001fb', 'x'.repeat(201)]) {
    expect(isSafeFileName(bad)).toBe(false)
  }
  expect(isSafeFileName('x'.repeat(200))).toBe(true)
})

test('isSlot', () => {
  expect(isSlot('att-a1B2c3')).toBe(true)
  expect(isSlot('att-../x')).toBe(false)
  expect(isSlot('att-a1B2c')).toBe(false)
  expect(isSlot('att-a1B2c3d')).toBe(false)
})

test('extensionOf', () => {
  expect(extensionOf('X.PDF')).toBe('pdf')
  expect(extensionOf('invoice.pdf.app')).toBe('app')
  expect(extensionOf('README')).toBeNull()
  expect(extensionOf('end.')).toBeNull()
})

test('typeAllowed', () => {
  expect(typeAllowed('X.PDF', DEFAULT_ATTACHMENT_TYPES)).toBe(true)
  expect(typeAllowed('invoice.pdf.app', DEFAULT_ATTACHMENT_TYPES)).toBe(false)
  expect(typeAllowed('README', DEFAULT_ATTACHMENT_TYPES)).toBe(false)
  expect(typeAllowed('x.app', ['app', 'pdf'])).toBe(false)
  expect(typeAllowed('x.exe', ['exe'])).toBe(false)
  expect(NEVER_ALLOWED).toContain('fileloc')
})

test('resolveAttachmentDir', () => {
  const home = '/Users/test'
  expect(resolveAttachmentDir(undefined, home)).toBe('/Users/test/Library/Caches/apple-mail-mcp/attachments')
  expect(resolveAttachmentDir('~/Downloads/x', home)).toBe('/Users/test/Downloads/x')
  expect(resolveAttachmentDir('/tmp/x', home)).toBe('/tmp/x')
  expect(resolveAttachmentDir('rel/x', home)).toBeNull()
  expect(resolveAttachmentDir('~user/x', home)).toBeNull()
  // Ohne HOME braucht Default und ~/ ein Home und ist ungueltig; absolut geht weiter.
  expect(resolveAttachmentDir(undefined, '')).toBeNull()
  expect(resolveAttachmentDir('~/x', '')).toBeNull()
  expect(resolveAttachmentDir('/tmp/x', '')).toBe('/tmp/x')
})
