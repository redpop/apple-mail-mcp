import { expect, test } from 'vitest'
import { classify, redactSubject } from '../src/securityMail.js'

test.each([
  '123456 is your code', 'Ihr Bestätigungscode', 'Reset your password', 'Votre code de vérification',
  'Ihr Einmalcode', 'Your OTP', 'Tu código de verificación', 'Il tuo codice di verifica', 'Uw verificatiecode',
  'Passwort zurücksetzen', 'Confirm your email', 'Use 2FA now', 'Your PIN is 4821', 'Ihr Passcode 998877',
])('%s is security mail', (s) => expect(classify({ subject: s, fromAddress: null }).security).toBe(true))

test.each(['Rechnung 2024-0815', 'Meeting 1430', 'Order 55512 shipped', 'Hello', 'Barcode scanner', 'Your code is ready'])(
  '%s is not',
  (s) => expect(classify({ subject: s, fromAddress: null }).security).toBe(false),
)

test('code near keyword in body', () => {
  expect(classify({ subject: 'Hi', fromAddress: null, text: 'Your verification code: 482913' }).security).toBe(true)
})
test('keyword alone in body counts, digits far from keyword are only a keyword hit', () => {
  expect(classify({ subject: 'Hi', fromAddress: null, text: 'Please reset your password soon.' }).security).toBe(true)
  expect(classify({ subject: 'Hi', fromAddress: null, text: 'Order 482913 shipped. Thanks.' }).security).toBe(false)
})
test('reason is set only for security mails', () => {
  expect(classify({ subject: 'Hi', fromAddress: null }).reason).toBeNull()
  expect(classify({ subject: 'Reset your password', fromAddress: null }).reason).toEqual(expect.any(String))
})
test('redaction', () => {
  expect(redactSubject('123456 is your code')).toBe('•••• is your code')
  expect(redactSubject('a 123 b 12345678 c 123456789')).toBe('a 123 b •••• c 123456789')
})
