import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'

const pkgDir = join(import.meta.dirname, '..')
const read = (p: string): string => readFileSync(join(pkgDir, p), 'utf8')
const readJson = (p: string) => JSON.parse(read(p))
// Fliesstext ohne Zeilenumbrueche und Markdown-Hervorhebung, damit Saetze ueber Zeilen hinweg treffen.
const flat = (p: string): string => read(p).replace(/[*`]/g, '').replace(/\s+/g, ' ')

// Nur Entwicklung, nicht ueber MCPB einstellbar (wie APPLE_MAIL_HELPER_PATH im Lesepaket).
const NOT_IN_MCPB = ['APPLE_MAIL_ACTIONS_PATH']

// Variable -> user_config-Schluessel. Die Lesevariablen sind die, die die Policy des Verschiebens braucht.
const KEYS: Record<string, string> = {
  APPLE_MAIL_ACCOUNTS: 'accounts',
  APPLE_MAIL_INCLUDE_JUNK: 'include_junk',
  APPLE_MAIL_INCLUDE_TRASH: 'include_trash',
  APPLE_MAIL_EXCLUDE_MAILBOXES: 'exclude_mailboxes',
  APPLE_MAIL_MAX_MOVES: 'max_moves',
  APPLE_MAIL_MOVE_EXCLUDE_TARGETS: 'move_exclude_targets',
  APPLE_MAIL_SAVE_ATTACHMENTS: 'save_attachments',
  APPLE_MAIL_ATTACHMENT_DIR: 'attachment_dir',
  APPLE_MAIL_MAX_ATTACHMENT_BYTES: 'max_attachment_bytes',
  APPLE_MAIL_ATTACHMENT_TYPES: 'attachment_types',
}

describe('README', () => {
  test('configuration table lists every variable of src/config.ts and every manifest variable', () => {
    const vars = new Set([...read('src/config.ts').match(/APPLE_MAIL_[A-Z_]+/g)!, ...Object.keys(KEYS)])
    const section = read('README.md').split(/^## /m).find((s) => s.startsWith('Configuration\n'))
    expect(section, 'README has a Configuration section').toBeDefined()
    const rows = new Set([...section!.matchAll(/^\| `(APPLE_MAIL_[A-Z_]+)` \|/gm)].map((m) => m[1]))
    for (const v of vars) expect(rows, v).toContain(v)
  })

  test('says what the package does and what it needs beside it', () => {
    const t = flat('README.md')
    expect(t).toMatch(/moves messages and, when enabled, saves attachments/i)
    expect(t).toMatch(/needs the read server/i)
    expect(t).toMatch(/APPLE_MAIL_ACCOUNTS is required/i)
    expect(t).toMatch(/APPLE_MAIL_EXCLUDE_MAILBOXES in both servers/i)
    expect(t).toMatch(/Mail must be running/i)
  })

  test('documents save_attachment: opt-in, download by Mail, protected folders', () => {
    const t = flat('README.md')
    expect(t).toMatch(/save_attachment is off unless APPLE_MAIL_SAVE_ATTACHMENTS is true/)
    expect(t).toMatch(/Mail downloads the attachment from the server/)
    expect(t).toMatch(/~\/Downloads needs its own permission/)
    expect(t).toMatch(/Library\/Caches\/apple-mail-mcp\/attachments/)
    expect(t).toMatch(/Gmail and Exchange .* untested/i)
  })

  test('warns about "always allow"', () => {
    expect(flat('README.md')).toMatch(/Always allow/)
  })

  test('warns that an auto-approving mode removes the prompt (Abnahme rc.7: Auto fragte nicht)', () => {
    expect(flat('README.md')).toMatch(/Use a mode that asks/)
    expect(flat('README.md')).toMatch(/Choose Manual/)
    expect(flat('SECURITY.md')).toMatch(/Use Manual there/)
    expect(flat('plugin/README.md')).toMatch(/Modes that\s+approve tools on their own/)
  })

  test('names the tested provider and the refused account kinds', () => {
    const t = flat('README.md')
    expect(t).toMatch(/Only mailbox\.org has been tested/i)
    expect(t).toMatch(/other IMAP providers are untested/i)
    expect(t).toMatch(/Gmail, Exchange and local folders are refused for moving/i)
  })

  test('names the copies risk, the lock, empty folders and macOS 15', () => {
    const t = flat('README.md')
    expect(t).toMatch(/copy on the mail server/i)
    expect(t).toMatch(/5 minutes/)
    expect(t).toMatch(/never held a message/i)
    expect(t).toMatch(/macOS 15/)
    expect(t).toMatch(/macOS 26 or later to move mail/)
    expect(t).toMatch(/2026-11-04.*one test mail was moved to a subfolder and back.*INBOX and back.*single test mails/)
    expect(t).not.toMatch(/moves from or to INBOX are not/)
  })

  test('has a privacy policy that the manifest links to', () => {
    expect(read('README.md')).toMatch(/^## Privacy Policy$/m)
    expect(readJson('manifest.json').privacy_policies).toEqual(['https://github.com/redpop/apple-mail-mcp/blob/main/packages/actions/README.md#privacy-policy'])
  })
})

describe('SECURITY.md', () => {
  const t = flat('SECURITY.md')
  test('names the residual risks', () => {
    expect(t).toMatch(/any local process can run the app/i)
    expect(t).toMatch(/damage is limited to moving/i)
    expect(t).toMatch(/subject only/i)
    expect(t).toMatch(/harmless subject/i)
    expect(t).toMatch(/message text is not read/i)
    expect(t).not.toMatch(/subject and sender/i)
    expect(t).toMatch(/starts a Dev or Ad hoc bundle only when/i)
  })
  test('names the risks of save_attachment', () => {
    expect(t).toMatch(/handover folder/i)
    expect(t).toMatch(/local process that can start the app can fetch attachments into the handover folder/i)
    expect(t).toMatch(/saved files are untrusted/i)
    expect(t).toMatch(/Mail writes the file/i)
  })
  test('says what the app does not have and what status means', () => {
    expect(t).toMatch(/no credentials/i)
    expect(t).toMatch(/no network/i)
    expect(t).toMatch(/local state in Mail, not the (mail )?server/i)
  })
})

describe('manifest.json', () => {
  const manifest = readJson('manifest.json')
  const pkg = readJson('package.json')

  test('maps every configuration variable to user_config', () => {
    const vars = [...new Set(read('src/config.ts').match(/APPLE_MAIL_[A-Z_]+/g))].filter((v) => !NOT_IN_MCPB.includes(v))
    for (const v of vars) expect(Object.keys(KEYS), v).toContain(v)
    const env = manifest.server.mcp_config.env as Record<string, string>
    expect(Object.keys(env).sort()).toEqual(Object.keys(KEYS).sort())
    for (const [v, key] of Object.entries(KEYS)) {
      expect(env[v]).toBe(`\${user_config.${key}}`)
      expect(manifest.user_config[key]).toBeDefined()
    }
    expect(Object.keys(manifest.user_config).sort()).toEqual(Object.values(KEYS).sort())
  })

  test('user_config types, bounds and defaults match src/config.ts', () => {
    const uc = manifest.user_config
    expect(uc.accounts).toMatchObject({ type: 'string', required: true })
    expect(uc.exclude_mailboxes).toMatchObject({ type: 'string', default: '' })
    expect(uc.include_junk).toMatchObject({ type: 'boolean', default: false })
    expect(uc.include_trash).toMatchObject({ type: 'boolean', default: false })
    expect(uc.max_moves).toMatchObject({ type: 'number', min: 1, max: 100, default: 25 })
    expect(uc.move_exclude_targets).toMatchObject({ type: 'string', default: '' })
    expect(uc.save_attachments).toMatchObject({ type: 'boolean', default: false })
    expect(uc.attachment_dir).toMatchObject({ type: 'string', default: '' })
    expect(uc.max_attachment_bytes).toMatchObject({ type: 'number', min: 1, max: 104857600, default: 26214400 })
    expect(uc.attachment_types).toMatchObject({ type: 'string', default: 'pdf,png,jpg,jpeg,heic,gif,txt,csv,ics,vcf,docx,xlsx,pptx,odt,ods,zip' })
    const config = read('src/config.ts')
    expect(config).toContain('let maxMoves = 25')
    expect(config).toContain('Number(m) > 100')
  })

  test('every field except accounts has a default and none takes multiple values', () => {
    for (const [key, field] of Object.entries(manifest.user_config as Record<string, { default?: unknown; multiple?: boolean }>)) {
      if (key !== 'accounts') expect(field.default, key).toBeDefined()
      expect(field.multiple, key).toBeUndefined()
    }
  })

  test('has exactly the registered tool', () => {
    const registered = [...read('src/tools/moveMessages.ts').matchAll(/registerTool\(\s*'([a-z_]+)'/g)].map((m) => m[1])
    const saved = [...read('src/tools/saveAttachment.ts').matchAll(/registerTool\(\s*'([a-z_]+)'/g)].map((m) => m[1])
    expect(registered).toEqual(['move_messages'])
    expect(saved).toEqual(['save_attachment'])
    expect(manifest.tools.map((t: { name: string }) => t.name)).toEqual([...registered, ...saved])
  })

  test('server entry, compatibility, version and icon', () => {
    expect(manifest.name).toBe('apple-mail-actions-mcp')
    expect(manifest.version).toBe(pkg.version)
    expect(manifest.server).toMatchObject({ type: 'node', entry_point: 'dist/index.js' })
    expect(manifest.server.mcp_config.args).toEqual(['${__dirname}/dist/index.js'])
    expect(manifest.compatibility.platforms).toEqual(['darwin'])
    expect(manifest.compatibility.runtimes.node).toBe('^22.16 || >=24')
    // Eigenes Icon gibt es noch nicht: Kopie des Icons im Wurzelverzeichnis.
    expect(manifest.icon).toBe('icon.png')
    const png = readFileSync(join(pkgDir, 'icon.png'))
    expect(png.equals(readFileSync(join(pkgDir, '../../icon.png')))).toBe(true)
  })
})

describe('server.json and package.json', () => {
  const server = readJson('server.json')
  const pkg = readJson('package.json')

  test('registry entry matches the package', () => {
    expect(pkg.mcpName).toBe('io.github.redpop/apple-mail-actions-mcp')
    expect(server.name).toBe(pkg.mcpName)
    expect(server.description.length).toBeLessThanOrEqual(100)
    expect(server.version).toBe(pkg.version)
    expect(server.repository.url).toBe('https://github.com/redpop/apple-mail-mcp')
    expect(server.repository.subfolder).toBe('packages/actions')
    expect(server.packages.map((p: { registryType: string }) => p.registryType).sort()).toEqual(['mcpb', 'npm'])
    const npm = server.packages.find((p: { registryType: string }) => p.registryType === 'npm')
    expect(npm).toMatchObject({ identifier: '@redpop/apple-mail-actions-mcp', version: pkg.version, transport: { type: 'stdio' } })
    const mcpb = server.packages.find((p: { registryType: string }) => p.registryType === 'mcpb')
    expect(mcpb.identifier).toBe(`https://github.com/redpop/apple-mail-mcp/releases/download/v${pkg.version}/apple-mail-actions-mcp-${pkg.version}.mcpb`)
    expect(mcpb.version).toBe(pkg.version)
    expect(mcpb.fileSha256).toMatch(/^[0-9a-f]{64}$/)
  })
})
