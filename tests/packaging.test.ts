import { existsSync, readFileSync } from 'node:fs'
import { describe, expect, test } from 'vitest'

const root = new URL('../', import.meta.url)
const readJson = (name: string) => JSON.parse(readFileSync(new URL(name, root), 'utf8'))

describe('packaging metadata', () => {
  const pkg = readJson('package.json')
  const server = readJson('server.json')

  test('versions agree', () => {
    expect(server.version).toBe(pkg.version)
    for (const p of server.packages) expect(p.version).toBe(pkg.version)
    // manifest.json kommt erst mit dem MCPB-Bau dazu.
    if (existsSync(new URL('manifest.json', root))) expect(readJson('manifest.json').version).toBe(pkg.version)
    const swift = readFileSync(new URL('swift/Sources/MailHelperCore/Version.generated.swift', root), 'utf8')
    expect(swift).toContain(`public let helperVersion = "${pkg.version}"`)
  })

  test('server.json', () => {
    expect(server.name).toBe('io.github.redpop/apple-mail-mcp')
    expect(server.description.length).toBeLessThanOrEqual(100)
    expect(server.repository.url).toBe('https://github.com/redpop/apple-mail-mcp')
    expect(server.packages.map((p: { registryType: string }) => p.registryType).sort()).toEqual(['mcpb', 'npm'])
    const npm = server.packages.find((p: { registryType: string }) => p.registryType === 'npm')
    expect(npm.identifier).toBe('@redpop/apple-mail-mcp')
    expect(npm.transport).toEqual({ type: 'stdio' })
    const mcpb = server.packages.find((p: { registryType: string }) => p.registryType === 'mcpb')
    expect(mcpb.identifier).toContain(`v${pkg.version}`)
    expect(mcpb.identifier).toContain(`apple-mail-mcp-${pkg.version}.mcpb`)
    expect(mcpb.fileSha256).toMatch(/^[0-9a-f]{64}$/)
    expect(mcpb.transport).toEqual({ type: 'stdio' })
  })

  test('package.json', () => {
    expect(pkg.mcpName).toBe(server.name)
    expect(pkg.files).toEqual(['dist', 'bin', 'README.md', 'LICENSE', 'SECURITY.md'])
    expect(pkg.repository.url).toBe('git+https://github.com/redpop/apple-mail-mcp.git')
    expect(pkg.description).toBeTruthy()
    expect(pkg.homepage).toContain('https://github.com/redpop/apple-mail-mcp')
    expect(pkg.bugs.url).toContain('https://github.com/redpop/apple-mail-mcp')
    expect(pkg.keywords).toEqual(expect.arrayContaining(['mcp', 'apple-mail', 'macos']))
  })
})
