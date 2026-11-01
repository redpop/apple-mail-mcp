import { collapse } from '../bodyScan.js'
import { parseForScan } from '../mime.js'
import { classify } from '../securityMail.js'
import type { SkipReason } from './store.js'

export type Classify = typeof classify
export type IndexText = { kind: 'text'; text: string } | { kind: 'skip'; reason: SkipReason }

/**
 * Text fuer den Index, genau der Text, den der Live-Scan durchsucht (Spec 5.4): immer der volle Text
 * (exakt oder parseMessage), nie die Vorfilter-Naeherung. Sicherheitsmails liefern nur einen Grund,
 * nie Text; geprueft wird derselbe Text wie in examine.
 */
export async function indexText(raw: string, subject: string, fromAddress: string | null, cls: Classify = classify): Promise<IndexText> {
  const body = await parseForScan(Buffer.from(raw, 'base64'))
  if (!body.ok) return { kind: 'skip', reason: 'parse_failed' }
  const text = body.exact ? body.quick : await body.full()
  if (text === null) return { kind: 'skip', reason: 'parse_failed' }
  if (cls({ subject, fromAddress, text }).security) return { kind: 'skip', reason: 'security' }
  const collapsed = collapse(text)
  if (collapsed === '') return { kind: 'skip', reason: 'empty' }
  return { kind: 'text', text: collapsed }
}
