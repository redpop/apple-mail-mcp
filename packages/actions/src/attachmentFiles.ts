// Regeln fuer Dateinamen, Slots und Dateitypen gespeicherter Anhaenge.
// Die Namensregeln spiegelt das Swift-Bundle; die Faelle muessen identisch bleiben.

export const DEFAULT_ATTACHMENT_TYPES: readonly string[] = [
  'pdf', 'png', 'jpg', 'jpeg', 'heic', 'gif', 'txt', 'csv', 'ics', 'vcf', 'docx', 'xlsx', 'pptx', 'odt', 'ods', 'zip',
]

// Ausfuehrbare Typen: nie erlaubt, auch nicht ueber die Variable.
export const NEVER_ALLOWED: readonly string[] = [
  'app', 'pkg', 'mpkg', 'dmg', 'command', 'sh', 'bash', 'zsh', 'tool', 'scpt', 'applescript', 'workflow', 'terminal',
  'jar', 'exe', 'bat', 'js', 'py', 'rb', 'pl', 'webloc', 'inetloc', 'fileloc',
]

const MAX_NAME_BYTES = 200
const FORBIDDEN = /[/:\u0000-\u001f\u007f]/
const FORBIDDEN_G = /[/:\u0000-\u001f\u007f]/g

const bytes = (s: string): number => Buffer.byteLength(s, 'utf8')

export function isSafeFileName(name: string): boolean {
  return name !== '' && bytes(name) <= MAX_NAME_BYTES && !FORBIDDEN.test(name) && !name.startsWith('.')
}

export function extensionOf(name: string): string | null {
  const i = name.lastIndexOf('.')
  if (i <= 0 || i === name.length - 1) return null
  return name.slice(i + 1).toLowerCase()
}

export function safeFileName(name: string, fallback: string): string {
  let n = name.replace(FORBIDDEN_G, '_').replace(/^\.+/, '')
  if (bytes(n) > MAX_NAME_BYTES) {
    const i = n.lastIndexOf('.')
    const ext = i > 0 ? n.slice(i) : ''
    // Endung behalten, Stamm zeichenweise (Codepoints) kuerzen.
    const stem = Array.from(i > 0 ? n.slice(0, i) : n)
    while (stem.length > 0 && bytes(stem.join('') + ext) > MAX_NAME_BYTES) stem.pop()
    n = stem.join('') + ext
    if (bytes(n) > MAX_NAME_BYTES) n = Array.from(n).reduce((acc, c) => (bytes(acc + c) <= MAX_NAME_BYTES ? acc + c : acc), '')
    n = n.replace(/^\.+/, '')
  }
  return n === '' ? fallback : n
}

export function isSlot(slot: string): boolean {
  return /^att-[A-Za-z0-9]{6}$/.test(slot)
}

export function typeAllowed(name: string, allowed: readonly string[]): boolean {
  const ext = extensionOf(name)
  if (ext === null || NEVER_ALLOWED.includes(ext)) return false
  return allowed.includes(ext)
}

// null = ungueltig (relativ oder ~user). Sonst keine Normalisierung.
export function resolveAttachmentDir(raw: string | undefined, home: string): string | null {
  if (raw === undefined) return `${home}/Library/Caches/apple-mail-mcp/attachments`
  if (raw.startsWith('~/')) return `${home}${raw.slice(1)}`
  if (raw.startsWith('/')) return raw
  return null
}
