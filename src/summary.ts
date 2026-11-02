import { z } from 'zod/v4'
import type { Config } from './config.js'
import { formatLocal } from './dates.js'
import { messageLink } from './links.js'
import type { Policy } from './policy.js'
import type { MessageRow } from './schemas.js'
import { classify, redactSubject } from './securityMail.js'

const Address = z.object({ address: z.string(), name: z.string().nullable() })
const MailboxRef = z.object({ id: z.string(), name: z.string(), account: z.string() })

/** Kategorien von Mail (AMM-19); der Index ist der Wert in der Datenbank. */
export const CATEGORIES = ['primary', 'transactions', 'updates', 'promotions'] as const
export type Category = (typeof CATEGORIES)[number]

/** Unbekannte Zahlen ergeben null. */
export function categoryName(value: number | null): Category | null {
  return value === null ? null : (CATEGORIES[value] ?? null)
}

export const MessageSummary = z.object({
  id: z.string(),
  link: z.string().nullable(),
  subject: z.string(),
  subjectRedacted: z.boolean().optional(),
  from: Address.nullable(),
  to: z.array(Address),
  cc: z.array(Address),
  recipientCount: z.number().int(),
  date: z.string(),
  mailboxes: z.array(MailboxRef),
  unread: z.boolean(),
  flagged: z.boolean(),
  attachmentNames: z.array(z.string()),
  attachmentCount: z.number().int(),
  threadId: z.string().nullable(),
  bodyLocal: z.enum(['full', 'partial', 'none']),
  category: z.enum(CATEGORIES).nullable(),
  important: z.boolean(),
  reminder: z.string().nullable(),
  matchContext: z.string().optional(),
})
export type MessageSummary = z.infer<typeof MessageSummary>

/** Standard fuer die Empfaengerzahl je Feld (entspricht dem Helper-Payload, Spec 7.3). */
export const DEFAULT_MAX_RECIPIENTS = 5

export function toSummary(row: MessageRow, policy: Policy, config: Config, maxRecipients: number = DEFAULT_MAX_RECIPIENTS): MessageSummary {
  const from = row.sender === null || row.sender.address === '' ? null : { address: row.sender.address, name: row.sender.name }
  const verdict = classify({ subject: row.subject, fromAddress: from?.address ?? null })
  const redact = verdict.security && !config.showSecurityMails
  const pick = (type: 'to' | 'cc') =>
    row.recipients.filter((r) => r.type === type).slice(0, maxRecipients).map((r) => ({ address: r.address, name: r.name }))
  const accountName = new Map(policy.accounts.map((a) => [a.id, a.name]))
  const mailboxes = row.mailboxIds.flatMap((id) => {
    const mb = policy.mailboxes.get(id)
    return mb ? [{ id: String(id), name: mb.name, account: accountName.get(mb.accountId) ?? mb.accountId }] : []
  })
  return {
    id: String(row.gid),
    link: messageLink(row.messageIdHeader),
    subject: redact ? redactSubject(row.subject) : row.subject,
    ...(redact ? { subjectRedacted: true } : {}),
    from,
    to: pick('to'),
    cc: pick('cc'),
    recipientCount: row.recipientCount,
    date: formatLocal(row.dateReceived),
    mailboxes,
    unread: !row.read,
    flagged: row.flagged,
    attachmentNames: row.attachmentNames,
    attachmentCount: row.attachmentCount ?? row.attachmentNames.length,
    threadId: row.conversationId ? String(row.conversationId) : null,
    bodyLocal: row.file,
    category: categoryName(row.category),
    important: row.highImpact,
    reminder: row.reminder === null ? null : formatLocal(row.reminder),
  }
}
