import { z } from 'zod/v4'

// Antworten des Helpers (Spec 7.3). Unbekannte Felder werden verworfen, fehlende oder falsch typisierte sind ein Vertragsbruch.

const person = z.object({ address: z.string(), name: z.string().nullable() })

export const messageRow = z.object({
  gid: z.number().int(),
  messageIdHeader: z.string().nullable(),
  subject: z.string(),
  sender: person.nullable(),
  recipients: z.array(person.extend({ type: z.enum(['to', 'cc', 'bcc']) })),
  recipientCount: z.number().int(),
  dateReceived: z.number().int(),
  dateSent: z.number().int().nullable(),
  mailboxIds: z.array(z.number().int()),
  read: z.boolean(),
  flagged: z.boolean(),
  attachmentNames: z.array(z.string()),
  attachmentCount: z.number().int().optional(),
  conversationId: z.number().int().nullable(),
  file: z.enum(['full', 'partial', 'none']),
})

export const searchResult = z.object({
  messages: z.array(messageRow),
  hasMore: z.boolean(),
  totalMatched: z.number().int().nullable().optional(),
  totalMatchedCapped: z.boolean().optional(),
})

export const getMessagesResult = z.object({
  messages: z.array(
    messageRow.extend({
      raw: z.string().nullable(),
      rawSize: z.number().int(),
      rawTruncated: z.boolean(),
    }),
  ),
  missing: z.array(z.number().int()),
  budgetExhausted: z.boolean(),
})

export const threadResult = z.object({
  conversationId: z.number().int().nullable(),
  messages: z.array(messageRow),
  hasMore: z.boolean(),
})

export const listMailboxesResult = z.object({
  mailboxes: z.array(z.object({ id: z.number().int(), url: z.string(), total: z.number().int(), unread: z.number().int() })),
  accounts: z.array(z.object({ uuid: z.string(), description: z.string().nullable(), username: z.string().nullable() })),
  accountNames: z.enum(['available', 'unavailable']),
  accountNamesReason: z.string().nullable().optional(),
})

export const probeResult = z.object({
  osVersion: z.string(),
  mailDir: z.string().nullable(),
  access: z.enum(['granted', 'denied', 'no_mail_data', 'untrusted_signature']),
  // ddl: CREATE-TABLE-Anweisungen des Fingerabdrucks, nur fuer `doctor --schema` (Spec 14.5).
  schema: z.object({ compatible: z.boolean(), missing: z.array(z.string()), fingerprint: z.string(), ddl: z.array(z.string()).optional() }).optional(),
  counts: z.object({ mailboxes: z.number().int(), messages: z.number().int(), uniqueMessages: z.number().int() }).optional(),
  accountNames: z.object({ status: z.enum(['available', 'unavailable']), unmatchedAccounts: z.number().int(), reason: z.string().nullable().optional() }),
})

export const helloResult = z.object({ protocolVersion: z.number().int(), helperVersion: z.string() })

export type MessageRow = z.infer<typeof messageRow>
export type SearchResult = z.infer<typeof searchResult>
export type GetMessagesResult = z.infer<typeof getMessagesResult>
export type ThreadResult = z.infer<typeof threadResult>
export type ListMailboxesResult = z.infer<typeof listMailboxesResult>
export type ProbeResult = z.infer<typeof probeResult>
export type HelloResult = z.infer<typeof helloResult>
