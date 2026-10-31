import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'

const script = fileURLToPath(new URL('../../scripts/release/publish.sh', import.meta.url))
let dir: string

// Attrappen fuer npm und gh: protokollieren jeden Aufruf; was schon existiert, steuern Umgebungsvariablen.
const FAKE = `#!/bin/bash
echo "$(basename "$0") $*" >>"$CALLS"
case "$(basename "$0") $1 $2" in
  "npm view "*) [ "$NPM_HAS" = 1 ] && { echo 0.1.0; exit 0; }; echo "E404" >&2; exit 1 ;;
  "gh release view") [ "$GH_HAS" = 1 ] && exit 0; exit 1 ;;
esac
exit 0
`

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'publish-'))
  mkdirSync(join(dir, 'fake'))
  for (const name of ['npm', 'gh']) {
    writeFileSync(join(dir, 'fake', name), FAKE)
    chmodSync(join(dir, 'fake', name), 0o755)
  }
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ version: '0.1.0' }))
  for (const f of ['pkg.tgz', 'apple-mail-mcp-0.1.0.mcpb', 'mail-helper.zip']) writeFileSync(join(dir, f), f)
})

afterEach(() => rmSync(dir, { recursive: true, force: true }))

function publish(state: { npm: boolean; gh: boolean }) {
  const calls = join(dir, 'calls.log')
  writeFileSync(calls, '')
  const r = spawnSync('/bin/bash', [script, 'pkg.tgz', 'apple-mail-mcp-0.1.0.mcpb', 'mail-helper.zip'], {
    cwd: dir,
    encoding: 'utf8',
    env: { PATH: `${join(dir, 'fake')}:${process.env.PATH}`, CALLS: calls, NPM_HAS: state.npm ? '1' : '0', GH_HAS: state.gh ? '1' : '0', RUNNER_TEMP: dir },
  })
  return { status: r.status, stderr: r.stderr, calls: readFileSync(calls, 'utf8') }
}

describe('publish.sh', () => {
  test('first run publishes to npm and creates the release', () => {
    const r = publish({ npm: false, gh: false })
    expect(r.status).toBe(0)
    expect(r.calls).toContain('npm publish pkg.tgz --provenance --access public')
    expect(r.calls).toMatch(/gh release create v0\.1\.0 --verify-tag .*apple-mail-mcp-0\.1\.0\.mcpb .*mail-helper\.zip .*SHA256SUMS/)
  })

  test('rerun after npm succeeded skips npm publish and still creates the release', () => {
    const r = publish({ npm: true, gh: false })
    expect(r.status).toBe(0)
    expect(r.calls).not.toContain('npm publish')
    expect(r.stderr).toContain('already on npm')
    expect(r.calls).toContain('gh release create v0.1.0')
  })

  test('rerun with an existing release uploads the assets instead of creating it', () => {
    const r = publish({ npm: true, gh: true })
    expect(r.status).toBe(0)
    expect(r.calls).not.toContain('gh release create')
    expect(r.calls).toMatch(/gh release upload v0\.1\.0 .*SHA256SUMS --clobber/)
  })
})
