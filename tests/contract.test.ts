import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { z } from 'zod/v4'
import { describeError } from '../src/errors.js'
import { getMessagesResult, helloResult, listMailboxesResult, probeResult, searchResult, threadResult } from '../src/schemas.js'

// Goldene Helper-Antworten aus swift/Tests/MailHelperCoreTests/ContractTests.swift (Neuerzeugung siehe CLAUDE.md).
const dir = join(import.meta.dirname, 'fixtures', 'contract')

/** Strikte Variante eines Schemas, rekursiv: jedes Objekt lehnt unbekannte Schluessel ab. */
function strict(schema: z.ZodType): z.ZodType {
  if (schema instanceof z.ZodObject) {
    const shape = Object.fromEntries(Object.entries(schema.shape as Record<string, z.ZodType>).map(([k, v]) => [k, strict(v)]))
    return z.strictObject(shape)
  }
  if (schema instanceof z.ZodArray) return z.array(strict(schema.element as z.ZodType))
  if (schema instanceof z.ZodNullable) return strict(schema.unwrap() as z.ZodType).nullable()
  if (schema instanceof z.ZodOptional) return strict(schema.unwrap() as z.ZodType).optional()
  return schema
}

const ok = (result: z.ZodType) => z.strictObject({ id: z.number().int(), ok: z.literal(true), result: strict(result) })

const contracts: Record<string, z.ZodType> = {
  hello: ok(helloResult),
  probe: ok(probeResult),
  'list-mailboxes': ok(listMailboxesResult),
  search: ok(searchResult),
  'get-messages': ok(getMessagesResult),
  thread: ok(threadResult),
  error: z.strictObject({
    id: z.number().int(),
    ok: z.literal(false),
    error: z.strictObject({ code: z.string(), message: z.string() }),
  }),
}

const load = (name: string): unknown => JSON.parse(readFileSync(join(dir, `${name}.json`), 'utf8'))

describe('helper contract (golden files)', () => {
  it('has exactly one golden file per Dispatcher command plus one error', () => {
    expect(readdirSync(dir).filter((f) => f.endsWith('.json')).sort()).toEqual(Object.keys(contracts).map((n) => `${n}.json`).sort())
  })

  for (const [name, schema] of Object.entries(contracts)) {
    it(`${name}.json parses with the strict schema`, () => {
      const r = schema.safeParse(load(name))
      expect(r.success, r.success ? '' : JSON.stringify(r.error.issues)).toBe(true)
    })
  }

  it('covers the optional fields Node relies on', () => {
    const probe = load('probe') as { result: { schema: { ddl: string[] } } }
    expect(probe.result.schema.ddl.length).toBeGreaterThan(0)
    expect(probe.result.schema.ddl.every((s) => s.startsWith('CREATE TABLE'))).toBe(true)
    const gm = load('get-messages') as { result: { messages: Array<{ raw: string | null }> } }
    expect(gm.result.messages[0]?.raw).toEqual(expect.any(String))
  })

  it('the error code has its own message in Node', () => {
    const e = load('error') as { error: { code: string } }
    expect(describeError(e.error.code)).not.toBe(describeError('NOT_A_CODE'))
  })

  it('the strict variant rejects unknown keys, also nested', () => {
    const search = load('search') as { result: { messages: Array<Record<string, unknown>> } }
    search.result.messages[0]!.surprise = 1
    expect(contracts.search!.safeParse(search).success).toBe(false)
    expect(contracts.hello!.safeParse({ ...(load('hello') as object), extra: true }).success).toBe(false)
  })
})
