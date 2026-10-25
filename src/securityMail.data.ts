// Woerterlisten fuer die Sicherheitsmail-Erkennung (Spec 8.3). Eintraege klein geschrieben; Abgleich laeuft ueber fold().
// Ergaenzungen per Pull Request ohne Codeaenderung.

export const SECURITY_KEYWORDS: readonly string[] = [
  // Deutsch
  'bestätigungscode', 'sicherheitscode', 'einmalcode', 'anmeldecode', 'verifizierungscode', 'einmalpasswort', 'einmal-passwort',
  'passwort zurücksetzen', 'kennwort zurücksetzen', 'passwort zurückzusetzen', 'e-mail-adresse bestätigen', 'anmeldelink',
  // Englisch
  'verification code', 'security code', 'one-time code', 'one time code', 'one-time password', 'one time password', 'otp', '2fa',
  'two-factor', 'two factor', 'sign-in code', 'sign in code', 'login code', 'magic link', 'reset your password', 'password reset',
  'confirm your email', 'verify your email',
  // Franzoesisch
  'code de vérification', 'code de verification', 'code de sécurité', 'code de securite', 'code à usage unique', 'code a usage unique',
  'mot de passe à usage unique', 'mot de passe a usage unique', 'code de connexion', 'réinitialiser votre mot de passe',
  'reinitialiser votre mot de passe', 'réinitialisation du mot de passe', 'reinitialisation du mot de passe',
  'confirmez votre adresse e-mail', 'lien de connexion', 'authentification à deux facteurs',
  // Spanisch
  'código de verificación', 'codigo de verificacion', 'código de seguridad', 'codigo de seguridad', 'código de un solo uso',
  'codigo de un solo uso', 'contraseña de un solo uso', 'código de inicio de sesión', 'codigo de inicio de sesion',
  'restablecer tu contraseña', 'restablecer su contraseña', 'restablecer la contraseña', 'confirma tu correo', 'enlace de inicio de sesión',
  'verificación en dos pasos', 'verificacion en dos pasos',
  // Italienisch
  'codice di verifica', 'codice di sicurezza', 'codice monouso', 'password monouso', 'codice di accesso', 'reimposta la password',
  'reimposta la tua password', 'reimpostare la password', 'conferma il tuo indirizzo email', 'link di accesso',
  'verifica in due passaggi',
  // Niederlaendisch
  'verificatiecode', 'beveiligingscode', 'eenmalige code', 'eenmalig wachtwoord', 'inlogcode', 'aanmeldcode', 'wachtwoord opnieuw instellen',
  'wachtwoord resetten', 'bevestig je e-mailadres', 'bevestig uw e-mailadres', 'inloglink', 'tweestapsverificatie',
]

// Kurze Code-Woerter fuer die Betreff-Regel (ganzes Wort, zusammen mit einer 4-8-stelligen Ziffernfolge).
export const SUBJECT_CODE_WORDS: readonly string[] = ['code', 'pin', 'passcode', 'kennung', 'código', 'codice']
