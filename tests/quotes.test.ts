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

test('an intro wrapped before wrote: or inside the address cuts', () => {
  expect(stripQuotes('Thanks\n\nOn Mon, 20 Oct 2025 at 10:00, Anna Beispiel <anna@example.com>\nwrote:\n\nold')).toEqual({ text: 'Thanks', removed: true })
  expect(stripQuotes('Thanks\nOn Mon, Oct 20, 2025 at 10:00 AM Anna Beispiel <\nanna@example.com> wrote:\nold')).toEqual({ text: 'Thanks', removed: true })
  expect(stripQuotes('Danke\nAm 20.10.2025 um 10:00 schrieb Anna Beispiel\n<anna@example.com>:\nalt')).toEqual({ text: 'Danke', removed: true })
})

test('two ordinary lines that happen to join into an intro stay', () => {
  const t = 'On Monday we met at the station.\nShe wrote: see you soon'
  expect(stripQuotes(t)).toEqual({ text: t, removed: false })
  const u = 'On the train home\nI wrote:'
  expect(stripQuotes(u)).toEqual({ text: u, removed: false })
})

test('Apple Mail forward headers cut, in English and German', () => {
  const en = 'FYI\n\nBegin forwarded message:\n\nFrom: Anna Beispiel <anna@example.com>\nSubject: Termin\nDate: 20 October 2025 at 10:00:00 CEST\nTo: Bob <bob@example.org>\n\nold'
  expect(stripQuotes(en)).toEqual({ text: 'FYI', removed: true })
  const de = 'Zur Info\n\nAnfang der weitergeleiteten Nachricht:\n\nVon: Anna Beispiel <anna@example.com>\nBetreff: Termin\nDatum: 20. Oktober 2025 um 10:00:00 MESZ\nAn: Bob <bob@example.org>\n\nalt'
  expect(stripQuotes(de)).toEqual({ text: 'Zur Info', removed: true })
  // Ohne Einleitungszeile reicht der Kopfblock aus From:, Subject: und Date:.
  expect(stripQuotes('Ok\nFrom: Anna <anna@example.com>\nSubject: Termin\nDate: 20 October 2025\n\nold')).toEqual({ text: 'Ok', removed: true })
  // From: mit nur einer Kopfzeile danach ist kein Block.
  const lone = 'From: the team\nTo: everyone\nthanks'
  expect(stripQuotes(lone)).toEqual({ text: lone, removed: false })
})
