import { readFileSync } from 'node:fs'
import { describe, expect, test } from 'vitest'

const read = (name: string) => readFileSync(new URL(`../${name}`, import.meta.url), 'utf8')
const manifest = JSON.parse(read('manifest.json'))
const pkg = JSON.parse(read('package.json'))

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
  APPLE_MAIL_BODY_INDEX: 'body_index',
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
    expect(uc.accounts).toMatchObject({ type: 'string', default: '' })
    expect(uc.exclude_mailboxes).toMatchObject({ type: 'string', default: '' })
    expect(uc.include_junk).toMatchObject({ type: 'boolean', default: false })
    expect(uc.include_trash).toMatchObject({ type: 'boolean', default: false })
    expect(uc.show_security_mails).toMatchObject({ type: 'boolean', default: false })
    expect(uc.body_search).toMatchObject({ type: 'boolean', default: true })
    expect(uc.body_index).toMatchObject({ type: 'boolean', default: false })
    expect(uc.max_results).toMatchObject({ type: 'number', min: 1, max: 100, default: 50 })
    expect(uc.max_body_chars).toMatchObject({ type: 'number', min: 1000, max: 100000, default: 20000 })
    const config = read('src/config.ts')
    expect(config).toContain("int(env, 'APPLE_MAIL_MAX_RESULTS', 50, 1, 100)")
    expect(config).toContain("int(env, 'APPLE_MAIL_MAX_BODY_CHARS', 20000, 1000, 100000)")
    expect(config).toContain("bool(env, 'APPLE_MAIL_INCLUDE_JUNK', false)")
    expect(config).toContain("bool(env, 'APPLE_MAIL_INCLUDE_TRASH', false)")
    expect(config).toContain("bool(env, 'APPLE_MAIL_SHOW_SECURITY_MAILS', false)")
    expect(config).toContain("bool(env, 'APPLE_MAIL_BODY_SEARCH', true)")
    expect(config).toContain("bool(env, 'APPLE_MAIL_BODY_INDEX', false)")
  })

  // Claude Desktop ersetzt ${user_config.x} nur, wenn ein Wert oder Default existiert, und nie mit
  // einem Array in einem String. Sonst kommt der Platzhalter woertlich in der Umgebung an.
  test('every user_config field has a default and none takes multiple values', () => {
    for (const [key, field] of Object.entries(manifest.user_config as Record<string, { default?: unknown; multiple?: boolean }>)) {
      expect(field.default, key).toBeDefined()
      expect(field.multiple, key).toBeUndefined()
    }
  })

  test('tools match the registered tools', () => {
    const sources = ['src/server.ts', 'src/tools/listMailboxes.ts', 'src/tools/searchMessages.ts', 'src/tools/getMessage.ts', 'src/tools/getThread.ts']
      .map((f) => { try { return read(f) } catch { return '' } })
      .join('\n')
    const registered = [...sources.matchAll(/registerTool\(\s*'([a-z_]+)'/g)].map((m) => m[1])
    expect(registered.length).toBe(4)
    expect(manifest.tools.map((t: { name: string }) => t.name).sort()).toEqual(registered.sort())
  })

  test('has a 512 px PNG icon that the MCPB build ships', () => {
    expect(manifest.icon).toBe('icon.png')
    const png = readFileSync(new URL('../icon.png', import.meta.url))
    expect(png.subarray(1, 4).toString('latin1')).toBe('PNG')
    // IHDR: Breite und Hoehe ab Byte 16.
    expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([512, 512])
    expect(read('scripts/release/build-mcpb.sh')).toMatch(/for f in [^\n]*icon\.png/)
  })

  test('server entry and compatibility (Spec 16.3)', () => {
    expect(manifest.server.type).toBe('node')
    expect(manifest.server.entry_point).toBe('dist/index.js')
    expect(manifest.server.mcp_config.command).toBe('node')
    expect(manifest.server.mcp_config.args).toEqual(['${__dirname}/dist/index.js'])
    expect(manifest.compatibility.platforms).toEqual(['darwin'])
    expect(manifest.compatibility.runtimes.node).toBe('^22.16 || >=24')
    expect(pkg.engines.node).toBe('^22.16 || >=24')
  })
})
