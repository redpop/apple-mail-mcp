import { readFileSync } from 'node:fs'
import { expect, test } from 'vitest'
import { parseMessage, type ParsedMessage } from '../src/mime.js'
import { stripQuotes } from '../src/quotes.js'

const eml = (n: string) => readFileSync(new URL(`./fixtures/eml/${n}`, import.meta.url))
const text = (m: ParsedMessage) => (m.ok ? m.text : '')

test.each(['reply-de.eml', 'reply-en.eml', 'reply-outlook.eml'])('quotes removed in %s', async (f) => {
  const r = stripQuotes(text(await parseMessage(eml(f))))
  expect(r.removed).toBe(true)
  expect(r.text).not.toMatch(/schrieb|wrote|Original/)
  expect(r.text.length).toBeGreaterThan(0)
})

test('message without quotes unchanged', () => {
  expect(stripQuotes('Hallo\nWelt')).toEqual({ text: 'Hallo\nWelt', removed: false })
})

test('plain > lines are removed without intro', () => {
  expect(stripQuotes('Ja.\n> alt\n> noch alt\nEnde')).toEqual({ text: 'Ja.\nEnde', removed: true })
})

test('French and Spanish intros cut', () => {
  expect(stripQuotes('Merci\nLe 1 oct. 2025, Bob a écrit :\nvieux')).toEqual({ text: 'Merci', removed: true })
  expect(stripQuotes('Gracias\nEl 1 oct 2025, Bob escribió:\nviejo')).toEqual({ text: 'Gracias', removed: true })
})

test('German Outlook header block cuts', () => {
  const t = 'Ok\n\nVon: Bob\nGesendet: Montag\nAn: Anna\nBetreff: X\n\nalt'
  expect(stripQuotes(t)).toEqual({ text: 'Ok', removed: true })
})

test('a lone From: line is not a quote header', () => {
  const t = 'From: here is my idea\nmore'
  expect(stripQuotes(t)).toEqual({ text: t, removed: false })
})

test('Ursprüngliche Nachricht cuts', () => {
  expect(stripQuotes('Ok\n-----Ursprüngliche Nachricht-----\nalt').removed).toBe(true)
})
