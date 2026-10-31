import { readFileSync } from 'node:fs'
import { describe, expect, test } from 'vitest'

const read = (name: string) => readFileSync(new URL(`../../${name}`, import.meta.url), 'utf8')

// Der Schluesselbund mit der Developer-ID-Identitaet darf nicht mehr offen sein, wenn Fremdcode
// laeuft (mcpb per npx, Attestation, npm publish, mcp-publisher).
describe.each(['.github/workflows/release.yml', '.github/workflows/release-candidate.yml'])('%s', (file) => {
  const yml = read(file)

  test('removes the keychain right after the helper build, before any third-party code', () => {
    const build = yml.indexOf('run: npm run build:helper')
    const cleanup = yml.indexOf('scripts/release/cleanup-keychain.sh')
    expect(build).toBeGreaterThan(0)
    expect(cleanup).toBeGreaterThan(build)
    for (const later of ['notarize.sh', 'build-mcpb.sh', 'attest-build-provenance']) {
      expect(cleanup, later).toBeLessThan(yml.indexOf(later))
    }
    // Rueckfall nach einem Fehler bleibt.
    expect(yml).toMatch(/if: always\(\)\n\s+run: scripts\/release\/cleanup-keychain\.sh/)
  })

  test('does not leave the write token in .git/config', () => {
    const start = yml.indexOf('actions/checkout@v5')
    const block = yml.slice(start, yml.indexOf('\n      - ', start))
    expect(block).toContain('persist-credentials: false')
  })
})

test('publish-registry.sh verifies the mcp-publisher download against pinned checksums', () => {
  const sh = read('scripts/publish-registry.sh')
  for (const platform of ['darwin_arm64', 'darwin_amd64', 'linux_amd64', 'linux_arm64']) {
    expect(sh).toMatch(new RegExp(`PUBLISHER="${platform}"; PUBLISHER_SHA256="[0-9a-f]{64}"`))
  }
  expect(sh).toContain('shasum -a 256')
  expect(sh).not.toMatch(/curl[^\n]*\|\s*tar/)
})
