import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { describe, expect, test } from 'vitest'

const script = fileURLToPath(new URL('../../scripts/release/require-env.sh', import.meta.url))

function run(env: Record<string, string>) {
  return spawnSync('/bin/bash', [script, 'A', 'B'], { env: { PATH: '/usr/bin:/bin', ...env }, encoding: 'utf8' })
}

describe('require-env.sh', () => {
  test('names the first missing variable', () => {
    const r = run({ A: 'x' })
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('Missing secret: B')
  })

  test('treats an empty variable as missing', () => {
    const r = run({ A: 'x', B: '' })
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('Missing secret: B')
  })

  test('passes when all are set', () => {
    expect(run({ A: 'x', B: 'y' }).status).toBe(0)
  })
})
