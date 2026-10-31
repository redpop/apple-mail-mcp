import { execFileSync } from 'node:child_process'
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
