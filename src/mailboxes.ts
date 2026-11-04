import { fold } from './fold.js'

export type MailboxRole = 'inbox' | 'sent' | 'drafts' | 'archive' | 'junk' | 'trash' | 'allmail' | 'other'

export interface ParsedMailbox {
  id: number
  url: string
  accountId: string
  type: 'imap' | 'local' | 'exchange' | 'other'
  path: string[]
  name: string
  role: MailboxRole
  total: number
  unread: number
}

// Namenslisten je Rolle (Deutsch, Englisch, Franzoesisch, Spanisch, Italienisch,
// Niederlaendisch, Gmail). Verglichen wird nach fold() gegen das letzte Pfadsegment, bei Junk und Trash gegen alle.
export const SENT_NAMES: readonly string[] = [
  'Sent', 'Sent Messages', 'Sent Items', 'Sent Mail',
  'Gesendet', 'Gesendete Objekte', 'Gesendete Elemente', 'Gesendete Nachrichten',
  'Envoyés', 'Éléments envoyés', 'Messages envoyés',
  'Enviados', 'Elementos enviados', 'Mensajes enviados', 'Enviado',
  'Posta inviata', 'Inviati', 'Elementi inviati', 'Inviata',
  'Verzonden', 'Verzonden items', 'Verzonden berichten',
]
export const DRAFTS_NAMES: readonly string[] = [
  'Drafts', 'Draft', 'Entwürfe', 'Entwurf', 'Brouillons', 'Borradores', 'Bozze', 'Concepten', 'Concept',
]
export const ARCHIVE_NAMES: readonly string[] = [
  'Archive', 'Archives', 'Archiv', 'Archivo', 'Archivio', 'Archief', 'Archivés', 'Archivierte Nachrichten',
]
export const JUNK_NAMES: readonly string[] = [
  'Junk', 'Junk E-mail', 'Junk Email', 'Junk Mail', 'Spam', 'Bulk Mail',
  'Junk-E-Mail', 'Werbung',
  'Courrier indésirable', 'Indésirables', 'Pourriel',
  'Correo no deseado', 'No deseado', 'Correo basura',
  'Posta indesiderata', 'Indesiderata', 'Posta indesiderati',
  'Ongewenst', 'Ongewenste e-mail', 'Ongewenste post',
]
export const TRASH_NAMES: readonly string[] = [
  'Trash', 'Deleted Messages', 'Deleted Items', 'Bin', 'Deleted',
  'Papierkorb', 'Gelöschte Objekte', 'Gelöschte Elemente', 'Gelöschte Nachrichten',
  'Corbeille', 'Éléments supprimés', 'Messages supprimés',
  'Papelera', 'Elementos eliminados', 'Elementos borrados', 'Eliminados',
  'Cestino', 'Posta eliminata', 'Elementi eliminati',
  'Prullenbak', 'Verwijderde items', 'Verwijderd',
]
export const ALLMAIL_NAMES: readonly string[] = [
  'All Mail', 'Alle Nachrichten', 'Tous les messages', 'Todos los mensajes',
  'Tutti i messaggi', 'Alle berichten',
]
export const INBOX_NAME = 'INBOX'

const JUNK_SET: ReadonlySet<string> = new Set(JUNK_NAMES.map(fold))
const TRASH_SET: ReadonlySet<string> = new Set(TRASH_NAMES.map(fold))

const ROLE_LISTS: readonly [MailboxRole, ReadonlySet<string>][] = [
  ['sent', new Set(SENT_NAMES.map(fold))],
  ['drafts', new Set(DRAFTS_NAMES.map(fold))],
  ['archive', new Set(ARCHIVE_NAMES.map(fold))],
  ['junk', JUNK_SET],
  ['trash', TRASH_SET],
  ['allmail', new Set(ALLMAIL_NAMES.map(fold))],
]

function typeOf(scheme: string): ParsedMailbox['type'] {
  switch (scheme.toLowerCase()) {
    case 'imap': return 'imap'
    case 'local': return 'local'
    case 'ews': return 'exchange'
    default: return 'other'
  }
}

// Dekodiert Pfadsegmente; null bei jedem unzulaessigen Segment.
function decodePath(tail: string): string[] | null {
  if (tail === '') return null
  const out: string[] = []
  for (const seg of tail.split('/')) {
    let d: string
    try {
      d = decodeURIComponent(seg)
    } catch {
      return null
    }
    if (d === '' || d === '.' || d === '..' || d.includes('/') || d.includes('\0')) return null
    out.push(d)
  }
  return out
}

function roleOf(path: string[]): MailboxRole {
  if (path.length === 0) return 'other'
  // Unterordner von Junk und Trash erben die Rolle, sonst waeren sie trotz Ausschluss sichtbar.
  // Das naechste Segment von unten gewinnt. Andere Rollen vererben sich nicht (Archive/2024).
  for (let i = path.length - 1; i >= 0; i--) {
    const seg = fold(path[i]!)
    if (JUNK_SET.has(seg)) return 'junk'
    if (TRASH_SET.has(seg)) return 'trash'
  }
  const last = fold(path[path.length - 1]!)
  if (path.length === 1 && last === fold(INBOX_NAME)) return 'inbox'
  for (const [role, names] of ROLE_LISTS) if (names.has(last)) return role
  return 'other'
}

// Rolle bei unzulaessigem Pfad: alle nicht leeren Roh-Segmente, nach Moeglichkeit dekodiert,
// sonst roh. Nie inbox. So bleiben Junk/Trash und ihre Unterordner trotzdem ausgeschlossen.
function bestEffortRole(tail: string): MailboxRole {
  const path = tail.split('/').flatMap((seg) => {
    let t = seg
    try {
      t = decodeURIComponent(seg)
    } catch {
      // roher Text
    }
    return t.split('/').filter((x) => x !== '')
  })
  const r = roleOf(path)
  return r === 'inbox' ? 'other' : r
}

export function parseMailbox(raw: { id: number; url: string; total: number; unread: number }): ParsedMailbox {
  const m = /^([A-Za-z][A-Za-z0-9+.-]*):\/\/([^/]*)(?:\/(.*))?$/s.exec(raw.url)
  const scheme = m?.[1] ?? ''
  const accountId = m?.[2] ?? ''
  const tail = m ? (m[3] ?? '') : raw.url
  const decoded = m ? decodePath(tail) : null
  const path = decoded ?? []
  return {
    id: raw.id,
    url: raw.url,
    accountId,
    type: m ? typeOf(scheme) : 'other',
    path,
    name: path.length > 0 ? path[path.length - 1]! : tail,
    role: decoded ? roleOf(path) : m ? bestEffortRole(tail) : 'other',
    total: raw.total,
    unread: raw.unread,
  }
}
