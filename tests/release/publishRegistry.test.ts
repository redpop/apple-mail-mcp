import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test } from 'vitest'

const script = fileURLToPath(new URL('../../scripts/publish-registry.sh', import.meta.url))

test('publish-registry.sh --fill-only writes the real MCPB checksum and leaves server.json alone', () => {
  const dir = mkdtempSync(join(tmpdir(), 'registry-'))
  try {
    const mcpb = join(dir, 'x.mcpb')
    writeFileSync(mcpb, 'not really an mcpb')
    const before = readFileSync(new URL('../../server.json', import.meta.url), 'utf8')
    execFileSync('/bin/bash', [script, '--fill-only', mcpb, join(dir, 'server.json')])
    const filled = JSON.parse(readFileSync(join(dir, 'server.json'), 'utf8'))
    const sha = createHash('sha256').update('not really an mcpb').digest('hex')
    expect(filled.packages.find((p: { registryType: string }) => p.registryType === 'mcpb').fileSha256).toBe(sha)
    expect(readFileSync(new URL('../../server.json', import.meta.url), 'utf8')).toBe(before)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// Attrappe fuer npm: "npm view <pkg>@<version> version" liefert die Version erst ab dem n-ten Aufruf.
// So verhaelt sich ein neues Paket, das npm nach dem Publish noch einige Sekunden verarbeitet.
const FAKE_NPM = `#!/bin/bash
n=$(( $(cat "$COUNT" 2>/dev/null || echo 0) + 1 )); echo "$n" >"$COUNT"
echo "npm $*" >>"$CALLS"
if [ "$1 $2 $3 $5" = "view --userconfig /dev/null version" ] && [ "$n" -ge "$VISIBLE_AFTER" ]; then echo "\${4##*@}"; exit 0; fi
echo "npm error 404 Not Found" >&2; exit 1
`

function waitNpm(visibleAfter: number, timeout: number) {
  const dir = mkdtempSync(join(tmpdir(), 'registry-wait-'))
  try {
    writeFileSync(join(dir, 'npm'), FAKE_NPM, { mode: 0o755 })
    const r = spawnSync('/bin/bash', [script, '--wait-npm-only', '0.1.0'], {
      encoding: 'utf8',
      env: { PATH: `${dir}:${process.env.PATH}`, COUNT: join(dir, 'count'), CALLS: join(dir, 'calls'), VISIBLE_AFTER: String(visibleAfter), REGISTRY_NPM_WAIT_SECONDS: String(timeout), REGISTRY_NPM_POLL_SECONDS: '0' },
    })
    return { status: r.status, stderr: r.stderr, calls: readFileSync(join(dir, 'calls'), 'utf8') }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

test('publish-registry.sh waits until npm serves the new version', () => {
  // Die Registry prueft das npm-Paket; ein neues Paket war beim ersten Release erst nach etwa 70 s sichtbar.
  const r = waitNpm(3, 60)
  expect(r.status).toBe(0)
  expect(r.calls).toContain('npm view --userconfig /dev/null @redpop/apple-mail-mcp@0.1.0 version')
  expect(r.calls.trim().split('\n')).toHaveLength(3)
})

test('publish-registry.sh gives up when npm never serves the version', () => {
  const r = waitNpm(1000, 0)
  expect(r.status).toBe(1)
  expect(r.stderr).toContain('@redpop/apple-mail-mcp@0.1.0 is not on npm')
})
