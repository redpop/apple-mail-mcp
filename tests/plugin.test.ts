import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
// @ts-expect-error: Skript ohne Typdeklaration, liegt ausserhalb von src/
import { MIN_DAYS, PACKAGES, nextPin, pinPlugin } from '../scripts/plugin-pin.mjs'

// Das Plugin fuer Claude Code (AMM-18; Cowork startet es in seiner Linux-VM, dort und im Chat gilt die MCPB) startet denselben Server per npx. Es pinnt eine
// veroeffentlichte Version, die npm erst nach MIN_DAYS Tagen folgt (scripts/plugin-pin.mjs);
// Einstellungen und Umgebung stammen aus dem MCPB-Manifest genau dieser Version.
const root = join(import.meta.dirname, '..')
const pluginDir = join(root, 'plugin')
const readJson = (p: string) => JSON.parse(readFileSync(join(root, p), 'utf8'))

// Der Release-Kandidat setzt package.json auf x.y.z-rc.N; der Pin vergleicht nur mit x.y.z.
function releaseOf(version: string): string {
  return version.replace(/-.*$/, '')
}

describe('Claude plugin', () => {
  const pkg = readJson('package.json')
  const manifest = readJson('manifest.json')
  const plugin = readJson('plugin/.claude-plugin/plugin.json')

  test('metadata', () => {
    expect(plugin.name).toBe('apple-mail-mcp')
    expect(plugin.license).toBe('MIT')
    expect(plugin.privacyPolicyUrl).toBe(manifest.privacy_policies[0])
    expect(plugin.repository).toBe('https://github.com/redpop/apple-mail-mcp')
    expect(existsSync(join(pluginDir, plugin.icon))).toBe(true)
  })

  test('runs the published package at exactly its own version, not newer than package.json', () => {
    const server = plugin.mcpServers['apple-mail']
    expect(server.command).toBe('npx')
    expect(server.args).toEqual(['-y', `@redpop/apple-mail-mcp@${plugin.version}`])
    // nextPin liefert die Plugin-Version nur, wenn sie ueber package.json liegt.
    expect(nextPin({ [plugin.version]: '2000-01-01T00:00:00Z' }, releaseOf(pkg.version), Date.now())).toBeNull()
  })

  test('offers the settings of the MCPB released with the pinned version', () => {
    // Der Tag muss existieren: nur veroeffentlichte Versionen werden gepinnt (CI holt die Tags).
    const tagged = JSON.parse(execFileSync('git', ['show', `v${plugin.version}:manifest.json`], { cwd: root, encoding: 'utf8' }))
    expect(pinPlugin(plugin, plugin.version, tagged)).toEqual(plugin)
  })

  test('marketplace lists the plugin folder', () => {
    const market = readJson('.claude-plugin/marketplace.json')
    // Der Eintrag des Actions-Plugins steht erst nach dem Oeffnen des Gates dahinter und wird unten geprueft.
    expect(market.plugins[0]).toEqual(expect.objectContaining({ name: plugin.name, source: './plugin' }))
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

// Das Plugin des Actions-Pakets ist neu und unveroeffentlicht: sein Pin steht auf der Version des Pakets,
// bis plugin-pin.yml ihn nach der ersten npm-Veroeffentlichung anhebt.
describe('Claude plugin for the actions package', () => {
  const dir = join(root, 'packages/actions/plugin')
  const pkg = readJson('packages/actions/package.json')
  const manifest = readJson('packages/actions/manifest.json')
  const plugin = readJson('packages/actions/plugin/.claude-plugin/plugin.json')

  test('metadata', () => {
    expect(plugin.name).toBe('apple-mail-actions-mcp')
    expect(plugin.license).toBe('MIT')
    expect(plugin.privacyPolicyUrl).toBe(manifest.privacy_policies[0])
    expect(plugin.repository).toBe('https://github.com/redpop/apple-mail-mcp')
    expect(existsSync(join(dir, plugin.icon))).toBe(true)
  })

  test('runs the actions package at exactly its own version, not newer than package.json', () => {
    const server = plugin.mcpServers['apple-mail-actions']
    expect(Object.keys(plugin.mcpServers)).toEqual(['apple-mail-actions'])
    expect(server.command).toBe('npx')
    expect(server.args).toEqual(['-y', `@redpop/apple-mail-actions-mcp@${plugin.version}`])
    expect(nextPin({ [plugin.version]: '2000-01-01T00:00:00Z' }, releaseOf(pkg.version), Date.now())).toBeNull()
  })

  test('environment and settings are consistent', () => {
    const env = plugin.mcpServers['apple-mail-actions'].env as Record<string, string>
    const keys = Object.keys(plugin.userConfig).sort()
    expect(Object.values(env).map((v) => v.replace(/^\$\{user_config\.(.*)\}$/, '$1')).sort()).toEqual(keys)
    expect(plugin.userConfig.accounts.required).toBe(true)
  })

  test('offers the settings of the MCPB released with the pinned version', () => {
    // Das Paket ist neu: am Tag der gepinnten Version gibt es packages/actions/manifest.json noch nicht.
    // Dann entfaellt der Vergleich mit dem Tag, und das Plugin muss dem Manifest im Arbeitsverzeichnis entsprechen.
    // Sobald der Tag die Datei enthaelt, gilt dieselbe strenge Pruefung wie beim Lese-Plugin.
    let tagged: unknown
    try {
      execFileSync('git', ['cat-file', '-e', `v${plugin.version}:packages/actions/manifest.json`], { cwd: root, stdio: 'ignore' })
      tagged = JSON.parse(execFileSync('git', ['show', `v${plugin.version}:packages/actions/manifest.json`], { cwd: root, encoding: 'utf8' }))
    } catch {
      tagged = undefined
    }
    if (tagged === undefined) {
      expect(plugin.userConfig).toEqual(manifest.user_config)
      expect(plugin.mcpServers['apple-mail-actions'].env).toEqual(manifest.server.mcp_config.env)
    } else {
      expect(pinPlugin(plugin, plugin.version, tagged, 'actions')).toEqual(plugin)
    }
  })

  test('marketplace does not list the actions plugin while the package is private', () => {
    const market = readJson('.claude-plugin/marketplace.json')
    const names = market.plugins.map((p: { name: string }) => p.name)
    if (pkg.private === true) {
      expect(names).toEqual(['apple-mail-mcp'])
      expect(JSON.stringify(market)).not.toContain('packages/actions')
    } else {
      expect(market.plugins).toEqual([
        expect.objectContaining({ name: 'apple-mail-mcp', source: './plugin' }),
        expect.objectContaining({ name: plugin.name, source: './packages/actions/plugin' }),
      ])
    }
  })

  test('folder passes the directory file rules', () => {
    const files = readdirSync(dir, { recursive: true, withFileTypes: true }).filter((e) => e.isFile())
    for (const f of files) {
      expect(f.name).not.toMatch(/^(\.DS_Store|\.npmrc|bunfig\.toml|uv\.toml)$/)
      expect(statSync(join(f.parentPath, f.name)).size, f.name).toBeLessThan(256 * 1024)
    }
    expect(existsSync(join(dir, 'bin'))).toBe(false)
    const readme = readFileSync(join(dir, 'README.md'), 'utf8').replace(/```[\s\S]*?```/g, '')
    expect(readme.split(/\s+/).filter(Boolean).length).toBeGreaterThanOrEqual(40)
  })
})

describe('plugin pin per package', () => {
  const read = { name: '@redpop/apple-mail-mcp', pluginFile: 'plugin/.claude-plugin/plugin.json', manifestFile: 'manifest.json', server: 'apple-mail' }
  const actions = { name: '@redpop/apple-mail-actions-mcp', pluginFile: 'packages/actions/plugin/.claude-plugin/plugin.json', manifestFile: 'packages/actions/manifest.json', server: 'apple-mail-actions' }
  const manifest = { server: { mcp_config: { env: { A: '${user_config.a}' } } }, user_config: { a: { type: 'string' } } }

  test('knows both packages', () => {
    expect(PACKAGES.read).toEqual(read)
    expect(PACKAGES.actions).toEqual(actions)
  })

  test('defaults to the read package', () => {
    const pinned = pinPlugin({ name: 'x', version: '0.1.0' }, '0.2.0', manifest)
    expect(pinned.mcpServers).toEqual({ 'apple-mail': { command: 'npx', args: ['-y', '@redpop/apple-mail-mcp@0.2.0'], env: manifest.server.mcp_config.env } })
    expect(pinned.userConfig).toEqual(manifest.user_config)
  })

  test('pins the actions package under its own server name', () => {
    const pinned = pinPlugin({ name: 'x', version: '0.1.0' }, '0.2.0', manifest, 'actions')
    expect(pinned.version).toBe('0.2.0')
    expect(pinned.mcpServers).toEqual({ 'apple-mail-actions': { command: 'npx', args: ['-y', '@redpop/apple-mail-actions-mcp@0.2.0'], env: manifest.server.mcp_config.env } })
  })

  test('rejects an unknown package', () => {
    expect(() => pinPlugin({}, '0.2.0', manifest, 'nope')).toThrow(/unknown package/)
  })
})

describe('plugin pin follows npm after a cooldown', () => {
  const now = Date.parse('2026-11-20T12:00:00Z')
  const daysAgo = (d: number) => new Date(now - d * 24 * 60 * 60 * 1000).toISOString()

  test('waits MIN_DAYS before following a release', () => {
    expect(MIN_DAYS).toBe(7)
    expect(nextPin({ '0.3.0': daysAgo(30), '0.4.0': daysAgo(6.9) }, '0.3.0', now)).toBeNull()
    expect(nextPin({ '0.3.0': daysAgo(30), '0.4.0': daysAgo(7) }, '0.3.0', now)).toBe('0.4.0')
  })

  test('takes the highest old-enough version, skipping a fresh one above it', () => {
    const time = { created: daysAgo(60), modified: daysAgo(1), '0.3.0': daysAgo(30), '0.3.1': daysAgo(9), '0.4.0': daysAgo(2) }
    expect(nextPin(time, '0.3.0', now)).toBe('0.3.1')
  })

  test('never pins a prerelease, an older version or the current one', () => {
    const time = { '0.2.0': daysAgo(40), '0.3.0': daysAgo(30), '0.4.0-rc.1': daysAgo(20), '0.10.0-beta': daysAgo(20) }
    expect(nextPin(time, '0.3.0', now)).toBeNull()
  })

  test('compares numerically, not as text', () => {
    expect(nextPin({ '0.9.0': daysAgo(30), '0.10.0': daysAgo(20) }, '0.9.0', now)).toBe('0.10.0')
  })

  test('honours a custom cooldown', () => {
    expect(nextPin({ '0.4.0': daysAgo(2) }, '0.3.0', now, 0)).toBe('0.4.0')
  })
})
