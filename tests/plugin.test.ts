import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'

// Das Plugin fuer Claude Code und Cowork (AMM-18) startet denselben Server per npx. Einstellungen
// und Umgebung muessen mit dem MCPB-Manifest uebereinstimmen, die Version mit package.json.
const root = join(import.meta.dirname, '..')
const pluginDir = join(root, 'plugin')
const readJson = (p: string) => JSON.parse(readFileSync(join(root, p), 'utf8'))

describe('Claude plugin', () => {
  const pkg = readJson('package.json')
  const manifest = readJson('manifest.json')
  const plugin = readJson('plugin/.claude-plugin/plugin.json')

  test('metadata', () => {
    expect(plugin.name).toBe('apple-mail-mcp')
    expect(plugin.version).toBe(pkg.version)
    expect(plugin.license).toBe('MIT')
    expect(plugin.privacyPolicyUrl).toBe(manifest.privacy_policies[0])
    expect(plugin.repository).toBe('https://github.com/redpop/apple-mail-mcp')
    expect(existsSync(join(pluginDir, plugin.icon))).toBe(true)
  })

  test('runs the published package at exactly this version', () => {
    const server = plugin.mcpServers['apple-mail']
    expect(server.command).toBe('npx')
    expect(server.args).toEqual(['-y', `@redpop/apple-mail-mcp@${pkg.version}`])
  })

  test('offers the same settings as the MCPB', () => {
    expect(plugin.userConfig).toEqual(manifest.user_config)
    expect(plugin.mcpServers['apple-mail'].env).toEqual(manifest.server.mcp_config.env)
  })

  test('marketplace lists the plugin folder', () => {
    const market = readJson('.claude-plugin/marketplace.json')
    expect(market.plugins).toEqual([expect.objectContaining({ name: plugin.name, source: './plugin' })])
  })

  test('folder passes the directory file rules', () => {
    // Kein bin/ (Cowork installiert sonst nicht), keine Paketquellen-Konfiguration, Dateien unter 256 KiB.
    const files = readdirSync(pluginDir, { recursive: true, withFileTypes: true }).filter((e) => e.isFile())
    for (const f of files) {
      expect(f.name).not.toMatch(/^(\.DS_Store|\.npmrc|bunfig\.toml|uv\.toml)$/)
      expect(statSync(join(f.parentPath, f.name)).size, f.name).toBeLessThan(256 * 1024)
    }
    expect(existsSync(join(pluginDir, 'bin'))).toBe(false)
    const readme = readFileSync(join(pluginDir, 'README.md'), 'utf8').replace(/```[\s\S]*?```/g, '')
    expect(readme.split(/\s+/).filter(Boolean).length).toBeGreaterThanOrEqual(40)
  })
})
