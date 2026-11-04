import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
// @ts-expect-error Das Skript ist reines JavaScript ohne Typen.
import { checkPublish } from '../../scripts/release/check-publish.mjs'

const repoRoot = fileURLToPath(new URL('../../', import.meta.url))
const HELPER = 'Mail MCP Helper.app'
const ACTIONS = 'Mail MCP Actions.app'
const TEST_ID = 'test.example.not-a-release-bundle'

function fake(dir: string, name: string, body: string): void {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, name), `#!/bin/bash\n${body}`)
  chmodSync(join(dir, name), 0o755)
}

// Ein echtes, ad hoc signiertes Bundle in einem Temp-Pfad, mit einer Test-ID: keine der drei echten IDs,
// also kein Risiko fuer eine Freigabe des Nutzers.
function signedBundle(path: string, executable: string, id = TEST_ID): string {
  mkdirSync(join(path, 'Contents/MacOS'), { recursive: true })
  cpSync('/usr/bin/true', join(path, 'Contents/MacOS', executable))
  chmodSync(join(path, 'Contents/MacOS', executable), 0o755)
  writeFileSync(
    join(path, 'Contents/Info.plist'),
    `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>${id}</string>
<key>CFBundleExecutable</key><string>${executable}</string>
<key>CFBundlePackageType</key><string>APPL</string>
</dict></plist>
`,
  )
  execFileSync('/usr/bin/codesign', ['--sign', '-', '--force', path], { stdio: 'pipe' })
  return execFileSync('/bin/bash', ['-c', `/usr/bin/codesign -dvvv "$1" 2>&1 | /usr/bin/sed -n 's/^CDHash=//p'`, '_', path], { encoding: 'utf8' }).trim()
}

describe('actions-enabled.sh', () => {
  function run(pkg: Record<string, unknown> | null) {
    const dir = mkdtempSync(join(tmpdir(), 'actions-enabled-'))
    try {
      mkdirSync(join(dir, 'scripts/release'), { recursive: true })
      cpSync(join(repoRoot, 'scripts/release/actions-enabled.sh'), join(dir, 'scripts/release/actions-enabled.sh'))
      if (pkg) {
        mkdirSync(join(dir, 'packages/actions'), { recursive: true })
        writeFileSync(join(dir, 'packages/actions/package.json'), JSON.stringify(pkg))
      }
      return spawnSync('/bin/bash', [join(dir, 'scripts/release/actions-enabled.sh')], { encoding: 'utf8' })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }

  test('prints false while the package is private', () => {
    const r = run({ name: 'x', private: true })
    expect(r.status).toBe(0)
    expect(r.stdout).toBe('false\n')
  })

  test('prints true once private is gone', () => {
    const r = run({ name: 'x' })
    expect(r.status).toBe(0)
    expect(r.stdout).toBe('true\n')
  })

  test('fails instead of guessing when the package is missing', () => {
    const r = run(null)
    expect(r.status).not.toBe(0)
    expect(r.stdout).toBe('')
  })
})

describe('verify-bundle.sh', () => {
  const script = join(repoRoot, 'scripts/release/verify-bundle.sh')
  let dir: string
  let bundle: string
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'verify-bundle-'))
    bundle = join(dir, 'Test.app')
    signedBundle(bundle, 'mail-actions')
  })
  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  const verify = (...args: string[]) => spawnSync('/bin/bash', [script, ...args], { encoding: 'utf8' })
  const requirement = (id: string) => `identifier "${id}" and anchor apple generic`

  test('takes the requirement as a second argument', () => {
    expect(verify(bundle).status).toBe(2)
    expect(verify(bundle).stderr).toContain('usage: verify-bundle.sh <bundle> <requirement>')
  })

  test('rejects an ad-hoc bundle and names the failed checks', () => {
    const r = verify(bundle, requirement('some.other.id'))
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('verify-bundle: Identifier failed')
    expect(r.stderr).toContain('verify-bundle: Authority failed')
    expect(r.stdout).toBe('')
  })

  test('takes the expected identifier from the requirement', () => {
    const r = verify(bundle, requirement(TEST_ID))
    expect(r.status).toBe(1)
    expect(r.stderr).not.toContain('verify-bundle: Identifier failed')
    expect(r.stderr).toContain('release requirement failed')
  })

  test('an empty requirement fails', () => {
    const r = verify(bundle, '')
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('verify-bundle: reading the identifier from the requirement failed')
  })
})

describe('verify-npm-pack.sh', () => {
  const script = join(repoRoot, 'scripts/release/verify-npm-pack.sh')
  let dir: string
  let cdhash: Record<string, string>

  // Attrappe fuer npm: die Dateiliste kommt aus $LISTING, "npm pack" kopiert ein vorbereitetes Tarball.
  const FAKE_NPM = `
if [[ " $* " == *" --dry-run "* ]]; then cat "$LISTING"; exit 0; fi
cp "$TARBALL" "$4/$(basename "$TARBALL")"
printf '[{"filename":"%s"}]' "$(basename "$TARBALL")"
`

  function tarball(name: string, app: string, executable: string): string {
    const stage = join(dir, `stage-${name}`, 'package')
    mkdirSync(join(stage, 'bin'), { recursive: true })
    cpSync(join(dir, app), join(stage, 'bin', app), { recursive: true })
    execFileSync('/usr/bin/tar', ['-czf', join(dir, `${name}.tgz`), '-C', dirname(stage), 'package'])
    expect(existsSync(join(stage, 'bin', app, 'Contents/MacOS', executable))).toBe(true)
    return join(dir, `${name}.tgz`)
  }

  function complete(app: string, executable: string, extra: string[] = []): string[] {
    const base = `bin/${app}/Contents`
    return [`${base}/MacOS/${executable}`, `${base}/Info.plist`, `${base}/_CodeSignature/CodeResources`, `${base}/CodeResources`, 'dist/index.js', ...extra]
  }

  function run(hash: string, packageDir: string | null, files: string[], tgz: string) {
    const listing = join(dir, 'listing.json')
    writeFileSync(listing, JSON.stringify([{ files: files.map((path) => ({ path })) }]))
    return spawnSync('/bin/bash', packageDir ? [script, hash, packageDir] : [script, hash], {
      cwd: dir,
      encoding: 'utf8',
      env: { PATH: `${join(dir, 'fake')}:${process.env.PATH}`, LISTING: listing, TARBALL: tgz, RUNNER_TEMP: join(dir, 'temp') },
    })
  }

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'verify-pack-'))
    mkdirSync(join(dir, 'temp'))
    mkdirSync(join(dir, 'packages/actions'), { recursive: true })
    fake(join(dir, 'fake'), 'npm', FAKE_NPM)
    cdhash = { helper: signedBundle(join(dir, HELPER), 'mail-helper'), actions: signedBundle(join(dir, ACTIONS), 'mail-actions') }
  })
  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  test('read package: passes with the helper alone and prints the tarball', () => {
    const r = run(cdhash.helper!, null, complete(HELPER, 'mail-helper'), tarball('read', HELPER, 'mail-helper'))
    expect(r.stderr).toBe('')
    expect(r.status).toBe(0)
    expect(r.stdout.trim()).toBe(join(dir, 'temp', 'read.tgz'))
  })

  test.each([
    ['a file named after the actions helper', 'dist/mail-actions.js'],
    ['the actions bundle under bin/', `bin/${ACTIONS}/Contents/Info.plist`],
    ['the actions package itself', 'packages/actions/package.json'],
  ])('read package: rejects %s', (_label, file) => {
    const r = run(cdhash.helper!, null, complete(HELPER, 'mail-helper', [file]), tarball('read', HELPER, 'mail-helper'))
    expect(r.status).toBe(1)
    expect(r.stderr).toContain(file)
  })

  test('read package: a changed CDHash fails', () => {
    const r = run('0'.repeat(40), null, complete(HELPER, 'mail-helper'), tarball('read', HELPER, 'mail-helper'))
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('differs from')
  })

  test('actions package: passes with its own bundle alone', () => {
    const r = run(cdhash.actions!, 'packages/actions', complete(ACTIONS, 'mail-actions'), tarball('actions', ACTIONS, 'mail-actions'))
    expect(r.stderr).toBe('')
    expect(r.status).toBe(0)
    expect(r.stdout.trim()).toBe(join(dir, 'temp', 'actions.tgz'))
  })

  test('actions package: rejects the helper under bin/', () => {
    const file = `bin/${HELPER}/Contents/Info.plist`
    const r = run(cdhash.actions!, 'packages/actions', complete(ACTIONS, 'mail-actions', [file]), tarball('actions', ACTIONS, 'mail-actions'))
    expect(r.status).toBe(1)
    expect(r.stderr).toContain(`unexpected file under bin/: ${file}`)
  })

  test('actions package: a missing bundle is reported', () => {
    const r = run(cdhash.actions!, 'packages/actions', ['dist/index.js'], tarball('actions', ACTIONS, 'mail-actions'))
    expect(r.status).toBe(1)
    expect(r.stderr).toContain(`missing bin/${ACTIONS}/Contents/MacOS/mail-actions`)
  })
})

describe('build-mcpb.sh', () => {
  let dir: string
  let work: string
  let cdhash: Record<string, string>

  // Attrappen: mcpb packt mit zip und entpackt mit unzip; "npm ci" legt nur an, was die Pruefungen brauchen.
  const FAKE_NPX = `
case "$3" in
  pack) (cd "$4" && /usr/bin/zip -qry "$5" .) ;;
  unpack) /usr/bin/unzip -q "$4" -d "$5" ;;
  *) exit 9 ;;
esac
`
  const FAKE_NPM = `
[ "$1" = ci ] || exit 9
mkdir -p node_modules/@modelcontextprotocol/server
echo '{}' >node_modules/@modelcontextprotocol/server/package.json
[ -n "\${SKIP_ZOD:-}" ] || cp -R "$REAL_ZOD" node_modules/zod
`

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'build-mcpb-'))
    work = join(dir, 'work')
    mkdirSync(join(work, 'scripts/release'), { recursive: true })
    for (const f of ['build-mcpb.sh', 'require-env.sh']) cpSync(join(repoRoot, 'scripts/release', f), join(work, 'scripts/release', f))
    for (const f of ['manifest.json', 'icon.png', 'package.json', 'package-lock.json', 'README.md', 'LICENSE', 'SECURITY.md']) cpSync(join(repoRoot, f), join(work, f))
    const actions = join(work, 'packages/actions')
    mkdirSync(actions, { recursive: true })
    for (const f of ['manifest.json', 'icon.png', 'package.json', 'README.md', 'LICENSE', 'SECURITY.md']) cpSync(join(repoRoot, 'packages/actions', f), join(actions, f))
    // Das echte dist/ des Lesepakets: Nur so zeigt der Test, was packagedHelperBundle() im Paket findet.
    execFileSync(join(repoRoot, 'node_modules/.bin/tsc'), ['-p', join(repoRoot, 'tsconfig.build.json'), '--outDir', join(work, 'dist'), '--sourceMap', 'false', '--declaration', 'false'], { stdio: 'pipe' })
    // Derselbe Import wie in packages/actions/src/index.ts.
    mkdirSync(join(actions, 'dist'))
    writeFileSync(
      join(actions, 'dist/index.js'),
      `import { packagedHelperBundle } from '@redpop/apple-mail-mcp/dist/helper.js'\nconsole.log(packagedHelperBundle())\n`,
    )
    cdhash = {
      helper: signedBundle(join(work, 'bin', HELPER), 'mail-helper'),
      actions: signedBundle(join(actions, 'bin', ACTIONS), 'mail-actions'),
    }
    fake(join(dir, 'fake'), 'npx', FAKE_NPX)
    fake(join(dir, 'fake'), 'npm', FAKE_NPM)
  }, 120_000)
  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  function build(args: string[], env: Record<string, string> = {}) {
    const temp = mkdtempSync(join(dir, 'temp-'))
    const r = spawnSync('/bin/bash', [join(work, 'scripts/release/build-mcpb.sh'), ...args], {
      cwd: work,
      encoding: 'utf8',
      env: { PATH: `${join(dir, 'fake')}:${process.env.PATH}`, MCPB_VERSION: '0.0.0', RUNNER_TEMP: temp, REAL_ZOD: join(repoRoot, 'node_modules/zod'), ...env },
    })
    return { ...r, temp }
  }

  function unpack(mcpb: string): string {
    const out = mkdtempSync(join(dir, 'unpacked-'))
    execFileSync('/usr/bin/unzip', ['-q', mcpb, '-d', out])
    return out
  }

  const version = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')).version as string

  test('read package: one bundle, under the old name, nothing else under bin/', () => {
    const r = build(['.', cdhash.helper!])
    expect(r.stderr).toBe('')
    expect(r.status).toBe(0)
    expect(r.stdout.trim()).toBe(join(r.temp, 'out', `apple-mail-mcp-${version}.mcpb`))
    const out = unpack(r.stdout.trim())
    expect(readdirSync(join(out, 'bin'))).toEqual([HELPER])
    expect(existsSync(join(out, 'node_modules/@redpop'))).toBe(false)
  })

  test('read package: a changed CDHash fails', () => {
    const r = build(['.', '0'.repeat(40)])
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('differs from')
  })

  test('actions package: holds both bundles and the read package, and the helper is where packagedHelperBundle() looks', () => {
    const r = build(['packages/actions', cdhash.actions!, cdhash.helper!])
    expect(r.stderr).toBe('')
    expect(r.status).toBe(0)
    expect(r.stdout.trim()).toBe(join(r.temp, 'out', `apple-mail-actions-mcp-${version}.mcpb`))

    const out = unpack(r.stdout.trim())
    expect(readdirSync(join(out, 'bin'))).toEqual([ACTIONS])
    const read = join(out, 'node_modules/@redpop/apple-mail-mcp')
    expect(readdirSync(join(read, 'bin'))).toEqual([HELPER])
    expect(JSON.parse(readFileSync(join(out, 'package.json'), 'utf8')).name).toBe('@redpop/apple-mail-actions-mcp')
    expect(existsSync(join(out, 'package-lock.json'))).toBe(false)

    const found = execFileSync(process.execPath, [join(out, 'dist/index.js')], { encoding: 'utf8' }).trim()
    expect(found).toBe(join(realpathSync(read), 'bin', HELPER))
    expect(existsSync(join(found, 'Contents/MacOS/mail-helper'))).toBe(true)
  })

  test('actions package: checks both CDHashes', () => {
    const wrongHelper = build(['packages/actions', cdhash.actions!, '0'.repeat(40)])
    expect(wrongHelper.status).toBe(1)
    expect(wrongHelper.stderr).toContain(HELPER)
    const wrongActions = build(['packages/actions', '0'.repeat(40), cdhash.helper!])
    expect(wrongActions.status).toBe(1)
    expect(wrongActions.stderr).toContain(ACTIONS)
  })

  test('actions package: one CDHash is not enough', () => {
    const r = build(['packages/actions', cdhash.actions!])
    expect(r.status).toBe(2)
    expect(r.stderr).toContain('usage')
  })

  test('actions package: a runtime dependency missing from the install fails', () => {
    const r = build(['packages/actions', cdhash.actions!, cdhash.helper!], { SKIP_ZOD: '1' })
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('zod')
  })

  test('an unknown package directory is refused', () => {
    expect(build(['packages/other', cdhash.actions!]).status).toBe(2)
  })
})

describe('publish.sh --actions', () => {
  const script = join(repoRoot, 'scripts/release/publish.sh')
  let dir: string
  const FAKE = `
echo "$(basename "$0") $*" >>"$CALLS"
case "$(basename "$0") $1 $2" in
  "npm view "*) [ "$NPM_HAS" = 1 ] && { echo 0.1.0; exit 0; }; echo "E404" >&2; exit 1 ;;
  "gh release view") [ "$GH_HAS" = 1 ] || exit 1; printf '%s' "$GH_ASSETS"; exit 0 ;;
esac
exit 0
`
  const MCPB = 'apple-mail-actions-mcp-0.1.0.mcpb'
  const ZIP = 'mail-actions.zip'

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'publish-actions-'))
    fake(join(dir, 'fake'), 'npm', FAKE)
    fake(join(dir, 'fake'), 'gh', FAKE)
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ version: '0.1.0' }))
    for (const f of ['actions.tgz', MCPB, ZIP]) writeFileSync(join(dir, f), f)
  })
  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  function publish(state: { npm: boolean; gh: boolean; assets?: string[] }) {
    const calls = join(dir, 'calls.log')
    writeFileSync(calls, '')
    const r = spawnSync('/bin/bash', [script, '--actions', 'actions.tgz', MCPB, ZIP], {
      cwd: dir,
      encoding: 'utf8',
      env: { PATH: `${join(dir, 'fake')}:${process.env.PATH}`, CALLS: calls, NPM_HAS: state.npm ? '1' : '0', GH_HAS: state.gh ? '1' : '0', GH_ASSETS: (state.assets ?? []).map((a) => `${a}\n`).join(''), RUNNER_TEMP: dir },
    })
    return { status: r.status, stderr: r.stderr, calls: readFileSync(calls, 'utf8') }
  }
  const READ_ASSETS = ['apple-mail-mcp-0.1.0.mcpb', 'mail-helper.zip', 'SHA256SUMS']

  test('publishes the actions package and adds its assets to the release of the read package', () => {
    const r = publish({ npm: false, gh: true, assets: READ_ASSETS })
    expect(r.status).toBe(0)
    expect(r.calls).toContain('npm view @redpop/apple-mail-actions-mcp@0.1.0 version')
    expect(r.calls).toContain('npm publish actions.tgz --provenance --access public')
    expect(r.calls).toMatch(/gh release upload v0\.1\.0 .*apple-mail-actions-mcp-0\.1\.0\.mcpb .*mail-actions\.zip .*SHA256SUMS-actions/)
    expect(r.calls).not.toContain('--clobber')
    expect(r.calls).not.toContain('gh release create')
  })

  test('without the release of the read package it publishes nothing', () => {
    const r = publish({ npm: false, gh: false })
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('read package')
    expect(r.calls).not.toContain('npm publish')
    expect(r.calls).not.toContain('gh release create')
  })

  test('rerun: a version already on npm is skipped, complete assets stay as they are', () => {
    const r = publish({ npm: true, gh: true, assets: [...READ_ASSETS, MCPB, ZIP, 'SHA256SUMS-actions'] })
    expect(r.status).toBe(0)
    expect(r.calls).not.toContain('npm publish')
    expect(r.calls).not.toContain('gh release upload')
  })

  test('rerun: partial actions assets stop the run', () => {
    const r = publish({ npm: true, gh: true, assets: [...READ_ASSETS, MCPB] })
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('some assets')
    expect(r.calls).not.toContain('gh release upload')
  })
})

describe('publish-registry.sh --package', () => {
  const script = join(repoRoot, 'scripts/publish-registry.sh')

  test('fills fileSha256 of each package from its own .mcpb', () => {
    const dir = mkdtempSync(join(tmpdir(), 'registry-actions-'))
    try {
      writeFileSync(join(dir, 'read.mcpb'), 'read bytes')
      writeFileSync(join(dir, 'actions.mcpb'), 'actions bytes')
      const sha = (s: string) => createHash('sha256').update(s).digest('hex')
      const mcpbOf = (file: string) => {
        const server = JSON.parse(readFileSync(file, 'utf8'))
        return { name: server.name, sha: server.packages.find((p: { registryType: string }) => p.registryType === 'mcpb').fileSha256 }
      }
      execFileSync('/bin/bash', [script, '--package', 'read', '--fill-only', join(dir, 'read.mcpb'), join(dir, 'read.json')])
      execFileSync('/bin/bash', [script, '--package', 'actions', '--fill-only', join(dir, 'actions.mcpb'), join(dir, 'actions.json')])
      expect(mcpbOf(join(dir, 'read.json'))).toEqual({ name: 'io.github.redpop/apple-mail-mcp', sha: sha('read bytes') })
      expect(mcpbOf(join(dir, 'actions.json'))).toEqual({ name: 'io.github.redpop/apple-mail-actions-mcp', sha: sha('actions bytes') })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('waits for the npm package it publishes', () => {
    const dir = mkdtempSync(join(tmpdir(), 'registry-actions-'))
    try {
      fake(dir, 'npm', 'echo "npm $*" >>"$CALLS"\necho "${4##*@}"\n')
      const calls = join(dir, 'calls')
      execFileSync('/bin/bash', [script, '--package', 'actions', '--wait-npm-only', '0.1.0'], { env: { PATH: `${dir}:${process.env.PATH}`, CALLS: calls } })
      expect(readFileSync(calls, 'utf8')).toContain('npm view --userconfig /dev/null @redpop/apple-mail-actions-mcp@0.1.0 version')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('an unknown package is refused', () => {
    expect(spawnSync('/bin/bash', [script, '--package', 'other', '--fill-only', 'a', 'b']).status).toBe(2)
  })

  test('refuses the actions entry while the actions package is private, before anything else happens', () => {
    const dir = mkdtempSync(join(tmpdir(), 'registry-gate-'))
    try {
      mkdirSync(join(dir, 'scripts/release'), { recursive: true })
      mkdirSync(join(dir, 'packages/actions'), { recursive: true })
      cpSync(script, join(dir, 'scripts/publish-registry.sh'))
      cpSync(join(repoRoot, 'scripts/release/actions-enabled.sh'), join(dir, 'scripts/release/actions-enabled.sh'))
      writeFileSync(join(dir, 'packages/actions/package.json'), JSON.stringify({ name: 'x', private: true }))
      const r = spawnSync('/bin/bash', [join(dir, 'scripts/publish-registry.sh'), '--package', 'actions'], { encoding: 'utf8' })
      expect(r.status).toBe(1)
      expect(r.stderr).toContain('private')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('check-tag.sh with the actions package', () => {
  let dir: string
  let work: string
  const git = (...args: string[]) => execFileSync('/usr/bin/git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], { cwd: work, encoding: 'utf8' })
  const checkTag = () => spawnSync('/bin/bash', ['scripts/release/check-tag.sh', 'v0.1.0'], { cwd: work, encoding: 'utf8' })
  const SWIFT = 'packages/actions/swift/Sources/MailActionsCore/Version.generated.swift'

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'check-tag-actions-'))
    work = join(dir, 'work')
    mkdirSync(join(work, 'scripts/release'), { recursive: true })
    mkdirSync(join(work, 'swift/Sources/MailHelperCore'), { recursive: true })
    mkdirSync(join(work, 'packages/actions/swift/Sources/MailActionsCore'), { recursive: true })
    for (const f of ['scripts/release/check-tag.sh', 'scripts/sync-versions.mjs', 'server.json', 'manifest.json', 'packages/actions/server.json', 'packages/actions/manifest.json']) {
      cpSync(join(repoRoot, f), join(work, f))
    }
    writeFileSync(join(work, 'package.json'), JSON.stringify({ name: '@redpop/apple-mail-mcp', version: '0.1.0' }, null, 2) + '\n')
    writeFileSync(join(work, 'packages/actions/package.json'), JSON.stringify({ name: '@redpop/apple-mail-actions-mcp', version: '0.0.0', dependencies: {} }, null, 2) + '\n')
    writeFileSync(join(work, 'package-lock.json'), JSON.stringify({ packages: { 'packages/actions': { version: '0.0.0' } } }, null, 2) + '\n')
    execFileSync('node', ['scripts/sync-versions.mjs'], { cwd: work })
    execFileSync('/usr/bin/git', ['init', '-q', '-b', 'main'], { cwd: work })
    git('add', '-A')
    git('commit', '-qm', 'init')
    execFileSync('/usr/bin/git', ['clone', '-q', '--bare', work, join(dir, 'origin.git')])
    git('remote', 'add', 'origin', join(dir, 'origin.git'))
    git('fetch', '-q', 'origin')
  })
  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  test('accepts a repository where all version files agree', () => {
    const r = checkTag()
    expect(r.stderr).toBe('')
    expect(r.status).toBe(0)
  })

  const replaceIn = (file: string, from: string, to: string) => {
    const before = readFileSync(join(work, file), 'utf8')
    expect(before).toContain(from)
    writeFileSync(join(work, file), before.replaceAll(from, to))
  }

  test.each([
    ['the actions package version', 'packages/actions/package.json', '"version": "0.1.0"', '"version": "0.0.9"'],
    ['the exact pin of the read package', 'packages/actions/package.json', '"@redpop/apple-mail-mcp": "0.1.0"', '"@redpop/apple-mail-mcp": "0.0.9"'],
    ['the actions manifest', 'packages/actions/manifest.json', '"version": "0.1.0"', '"version": "0.0.9"'],
    ['the actions server.json', 'packages/actions/server.json', '"version": "0.1.0"', '"version": "0.0.9"'],
    ['the actions Swift version', SWIFT, 'helperVersion = "0.1.0"', 'helperVersion = "0.0.9"'],
    ['the lock entry of the actions package', 'package-lock.json', '"version": "0.1.0"', '"version": "0.0.9"'],
  ])('refuses a drift in %s', (_label, file, from, to) => {
    replaceIn(file, from, to)
    git('add', '-A')
    git('commit', '-qm', 'drift')
    try {
      const r = checkTag()
      expect(r.status).toBe(1)
      expect(r.stderr).toContain('out of sync')
      expect(r.stderr).toContain(file)
    } finally {
      git('reset', '-q', '--hard', 'HEAD~1')
    }
  })

  test.each([[SWIFT], ['packages/actions/server.json'], ['packages/actions/manifest.json']])('refuses a repository without %s', (file) => {
    git('rm', '-q', file)
    git('commit', '-qm', 'remove')
    try {
      const r = checkTag()
      expect(r.status).toBe(1)
      expect(r.stderr).toContain(file)
    } finally {
      git('reset', '-q', '--hard', 'HEAD~1')
      git('clean', '-fdq')
    }
  })
})

describe('checkPublish for the actions bundle', () => {
  test('requires exactly the named release bundle', () => {
    expect(checkPublish({ CI: 'true' }, [ACTIONS], ACTIONS)).toBeNull()
    expect(checkPublish({ CI: 'true' }, [HELPER], ACTIONS)).toContain(HELPER)
    expect(checkPublish({ CI: 'true' }, [], ACTIONS)).toContain(`${ACTIONS} is missing`)
  })

  test('without a name it still means the helper', () => {
    expect(checkPublish({ CI: 'true' }, [HELPER])).toBeNull()
    expect(checkPublish({ CI: 'true' }, [ACTIONS])).toContain(ACTIONS)
  })

  test('the actions package runs the hook with its own bundle name', () => {
    const pkg = JSON.parse(readFileSync(join(repoRoot, 'packages/actions/package.json'), 'utf8'))
    expect(pkg.scripts.prepublishOnly).toBe(`node ../../scripts/release/check-publish.mjs "${ACTIONS}"`)
  })
})
