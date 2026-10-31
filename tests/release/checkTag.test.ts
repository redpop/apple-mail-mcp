import { execFileSync, spawnSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'

const repoRoot = fileURLToPath(new URL('../../', import.meta.url))
let dir: string

const git = (...args: string[]) =>
  execFileSync('/usr/bin/git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], { cwd: join(dir, 'work'), encoding: 'utf8' })

function checkTag(tag: string) {
  return spawnSync('/bin/bash', ['scripts/release/check-tag.sh', tag], { cwd: join(dir, 'work'), encoding: 'utf8' })
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'check-tag-'))
  const work = join(dir, 'work')
  mkdirSync(join(work, 'scripts/release'), { recursive: true })
  mkdirSync(join(work, 'swift/Sources/MailHelperCore'), { recursive: true })
  for (const f of ['scripts/release/check-tag.sh', 'scripts/sync-versions.mjs', 'server.json', 'manifest.json']) {
    cpSync(join(repoRoot, f), join(work, f))
  }
  writeFileSync(join(work, 'package.json'), JSON.stringify({ name: 'x', version: '0.1.0' }, null, 2) + '\n')
  execFileSync('node', ['scripts/sync-versions.mjs'], { cwd: work })
  execFileSync('/usr/bin/git', ['init', '-q', '-b', 'main'], { cwd: work })
  git('add', '-A')
  git('commit', '-qm', 'init')
  execFileSync('/usr/bin/git', ['clone', '-q', '--bare', work, join(dir, 'origin.git')])
  git('remote', 'add', 'origin', join(dir, 'origin.git'))
  git('fetch', '-q', 'origin')
  git('tag', 'v0.1.0')
  git('tag', 'v0.1.1')
  // Seitenzweig mit eigenem Commit, nie auf main.
  git('checkout', '-qb', 'side')
  writeFileSync(join(work, 'side.txt'), 'x\n')
  git('add', 'side.txt')
  git('commit', '-qm', 'side')
  git('tag', 'v0.1.0-side')
  git('checkout', '-q', 'main')
})

afterAll(() => rmSync(dir, { recursive: true, force: true }))

describe('check-tag.sh', () => {
  test('accepts a tag on main that matches the version', () => {
    const r = checkTag('v0.1.0')
    expect(r.stderr).toBe('')
    expect(r.status).toBe(0)
  })

  test('refuses a tag that does not match package.json', () => {
    const r = checkTag('v0.1.1')
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('does not match package.json')
  })

  test('refuses a tag that is not on main', () => {
    git('checkout', '-q', 'v0.1.0-side')
    try {
      // Version passt (0.1.0), aber der Commit liegt nur auf dem Seitenzweig.
      const r = checkTag('v0.1.0')
      expect(r.status).toBe(1)
      expect(r.stderr).toContain('not on main')
    } finally {
      git('checkout', '-q', 'main')
    }
  })
})
