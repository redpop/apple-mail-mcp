import { createHash } from 'node:crypto'
import { HelperError } from './errors.js'

function stableJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableJson).join(',')}]`
  if (v !== null && typeof v === 'object') {
    const o = v as Record<string, unknown>
    return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${stableJson(o[k])}`).join(',')}}`
  }
  return JSON.stringify(v) ?? 'null'
}

/** Kurzer Hash ueber normalisierte Suchparameter (ohne cursor/limit) und den Policy-Fingerabdruck. */
export function queryHash(params: Record<string, unknown>, policyFingerprint: string): string {
  return createHash('sha256').update(stableJson({ params, policy: policyFingerprint })).digest('hex').slice(0, 16)
}

export function encodeCursor(k: { d: number; g: number }, hash: string): string {
  return Buffer.from(JSON.stringify({ v: 1, d: k.d, g: k.g, h: hash })).toString('base64url')
}

function bad(): HelperError {
  return new HelperError('INVALID_CURSOR', 'The cursor does not belong to this search.')
}

export function decodeCursor(s: string, hash: string): { d: number; g: number } {
  if (!/^[A-Za-z0-9_-]+$/.test(s)) throw bad()
  let o: unknown
  try {
    o = JSON.parse(Buffer.from(s, 'base64url').toString('utf8'))
  } catch {
    throw bad()
  }
  if (o === null || typeof o !== 'object' || Array.isArray(o)) throw bad()
  const c = o as Record<string, unknown>
  if (c.v !== 1 || !Number.isSafeInteger(c.d) || !Number.isSafeInteger(c.g) || typeof c.h !== 'string' || c.h !== hash) throw bad()
  return { d: c.d as number, g: c.g as number }
}
