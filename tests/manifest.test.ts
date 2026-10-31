import { readFileSync } from 'node:fs'
import { describe, expect, test } from 'vitest'

const read = (name: string) => readFileSync(new URL(`../${name}`, import.meta.url), 'utf8')
const manifest = JSON.parse(read('manifest.json'))

// Nur Entwicklung bzw. Diagnose, nicht ueber MCPB einstellbar (Spec 11).
const NOT_IN_MCPB = ['APPLE_MAIL_HELPER_PATH', 'APPLE_MAIL_MCP_DEBUG']

// Spec 11: Variable -> user_config-Schluessel.
const KEYS: Record<string, string> = {
  APPLE_MAIL_ACCOUNTS: 'accounts',
  APPLE_MAIL_INCLUDE_JUNK: 'include_junk',
  APPLE_MAIL_INCLUDE_TRASH: 'include_trash',
  APPLE_MAIL_EXCLUDE_MAILBOXES: 'exclude_mailboxes',
  APPLE_MAIL_SHOW_SECURITY_MAILS: 'show_security_mails',
  APPLE_MAIL_BODY_SEARCH: 'body_search',
  APPLE_MAIL_MAX_RESULTS: 'max_results',
  APPLE_MAIL_MAX_BODY_CHARS: 'max_body_chars',
}

describe('manifest.json', () => {
  test('maps every configuration variable to user_config', () => {
    const vars = [...new Set(read('src/config.ts').match(/APPLE_MAIL_[A-Z_]+/g))].filter((v) => !NOT_IN_MCPB.includes(v))
    expect(vars.sort()).toEqual(Object.keys(KEYS).sort())
    const env = manifest.server.mcp_config.env as Record<string, string>
    expect(Object.keys(env).sort()).toEqual(vars.sort())
    for (const v of vars) {
      expect(env[v]).toBe(`\${user_config.${KEYS[v]}}`)
      expect(manifest.user_config[KEYS[v]!]).toBeDefined()
    }
  })

  test('user_config types, bounds and defaults match src/config.ts', () => {
    const uc = manifest.user_config
    expect(uc.accounts).toMatchObject({ type: 'string', multiple: true })
    expect(uc.exclude_mailboxes).toMatchObject({ type: 'string' })
    expect(uc.include_junk).toMatchObject({ type: 'boolean', default: false })
    expect(uc.include_trash).toMatchObject({ type: 'boolean', default: false })
    expect(uc.show_security_mails).toMatchObject({ type: 'boolean', default: false })
    expect(uc.body_search).toMatchObject({ type: 'boolean', default: true })
    expect(uc.max_results).toMatchObject({ type: 'number', min: 1, max: 100, default: 50 })
    expect(uc.max_body_chars).toMatchObject({ type: 'number', min: 1000, max: 100000, default: 20000 })
    const config = read('src/config.ts')
    expect(config).toContain("int(env, 'APPLE_MAIL_MAX_RESULTS', 50, 1, 100)")
    expect(config).toContain("int(env, 'APPLE_MAIL_MAX_BODY_CHARS', 20000, 1000, 100000)")
    expect(config).toContain("bool(env, 'APPLE_MAIL_INCLUDE_JUNK', false)")
    expect(config).toContain("bool(env, 'APPLE_MAIL_INCLUDE_TRASH', false)")
    expect(config).toContain("bool(env, 'APPLE_MAIL_SHOW_SECURITY_MAILS', false)")
    expect(config).toContain("bool(env, 'APPLE_MAIL_BODY_SEARCH', true)")
  })

  test('tools match the registered tools', () => {
    const sources = ['src/server.ts', 'src/tools/listMailboxes.ts', 'src/tools/searchMessages.ts', 'src/tools/getMessage.ts', 'src/tools/getThread.ts']
      .map((f) => { try { return read(f) } catch { return '' } })
      .join('\n')
    const registered = [...sources.matchAll(/registerTool\(\s*'([a-z_]+)'/g)].map((m) => m[1])
    expect(registered.length).toBe(4)
    expect(manifest.tools.map((t: { name: string }) => t.name).sort()).toEqual(registered.sort())
  })

  test('server entry and compatibility (Spec 16.3)', () => {
    expect(manifest.server.type).toBe('node')
    expect(manifest.server.entry_point).toBe('dist/index.js')
    expect(manifest.server.mcp_config.command).toBe('node')
    expect(manifest.server.mcp_config.args).toEqual(['${__dirname}/dist/index.js'])
    expect(manifest.compatibility.platforms).toEqual(['darwin'])
    expect(manifest.compatibility.runtimes.node).toBe('>=22')
  })
})
