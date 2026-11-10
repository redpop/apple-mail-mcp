import { readFileSync } from 'node:fs'
import { describe, expect, test } from 'vitest'

const read = (name: string) => readFileSync(new URL(`../../${name}`, import.meta.url), 'utf8')

const GATE = "if: steps.actions.outputs.enabled == 'true'"

/** Die Schritte eines Jobs, in Reihenfolge, als Textbloecke; reicht fuer die Pruefungen hier, ohne YAML-Abhaengigkeit. */
function steps(yml: string): string[] {
  return yml.split('\n    steps:\n')[1]!.split(/\n(?=      - )/)
}

const concernsActions = (step: string) =>
  /packages\/actions|mail-actions|Mail MCP Actions|--actions|--package actions|steps\.actions_/.test(step)

function index(all: string[], fragment: string): number {
  const i = all.findIndex((s) => s.includes(fragment))
  expect(i, fragment).toBeGreaterThanOrEqual(0)
  return i
}

describe.each(['.github/workflows/release.yml', '.github/workflows/release-candidate.yml'])('%s, actions gate', (file) => {
  const yml = read(file)
  const all = steps(yml)
  const gated = all.filter((s) => s.includes(GATE))

  test('computes the gate with actions-enabled.sh before the first gated step', () => {
    const gate = index(all, 'scripts/release/actions-enabled.sh')
    expect(all[gate]).toContain('id: actions')
    expect(all[gate]).toContain('>>"$GITHUB_OUTPUT"')
    expect(gate).toBeLessThan(all.indexOf(gated[0]!))
  })

  test('every step that touches the actions package is gated, and no step for the read package is', () => {
    expect(gated.length).toBeGreaterThan(0)
    for (const step of all) {
      if (concernsActions(step)) expect(step, step).toContain(GATE)
      else expect(step, step).not.toContain(GATE)
    }
  })

  test('needs no secret beyond those of a read-only release', () => {
    const names = new Set([...yml.matchAll(/secrets\.(\w+)/g)].map((m) => m[1]))
    expect([...names].sort()).toEqual(['APPLE_API_ISSUER_ID', 'APPLE_API_KEY_BASE64', 'APPLE_API_KEY_ID', 'APPLE_CERTIFICATE_BASE64', 'APPLE_CERTIFICATE_PASSWORD'])
    for (const step of gated) if (!step.includes('notarize.sh')) expect(step, step).not.toContain('secrets.')
  })

  test('signs the second bundle before the keychain goes, and downloads nothing before that', () => {
    const helper = index(all, 'run: npm run build:helper\n')
    const second = index(all, 'run: npm run build:helper --workspace packages/actions')
    const cleanup = index(all, 'scripts/release/cleanup-keychain.sh')
    expect(helper).toBeLessThan(second)
    expect(second).toBeLessThan(cleanup)
    expect(all[second]).toContain("CI: 'true'")
    for (const later of ['notarize.sh', 'build-mcpb.sh', 'attest-build-provenance', 'verify-npm-pack.sh']) {
      expect(cleanup, later).toBeLessThan(index(all, later))
    }
  })

  test('builds, notarizes and verifies both bundles, each package with its own requirement', () => {
    const notarizeRead = index(all, 'notarize.sh "bin/Mail MCP Helper.app"')
    const notarizeActions = index(all, 'notarize.sh "packages/actions/bin/Mail MCP Actions.app"')
    const verifyRead = index(all, 'verify-bundle.sh "bin/Mail MCP Helper.app"')
    const verifyActions = index(all, 'verify-bundle.sh "packages/actions/bin/Mail MCP Actions.app"')
    expect(notarizeRead).toBeLessThan(verifyRead)
    expect(notarizeActions).toBeLessThan(verifyActions)
    expect(all[verifyRead]).toContain("require('./dist/signing.js').RELEASE_REQUIREMENT")
    expect(all[verifyActions]).toContain("require('./packages/actions/dist/bundle.js').RELEASE_REQUIREMENT")
    expect(index(all, 'npm run build --workspace packages/actions')).toBeLessThan(verifyActions)
    const pack = index(all, 'verify-npm-pack.sh "${{ steps.actions_bundle.outputs.cdhash }}" packages/actions')
    expect(verifyActions).toBeLessThan(pack)
    const mcpb = index(all, 'build-mcpb.sh packages/actions "${{ steps.actions_bundle.outputs.cdhash }}" "${{ steps.bundle.outputs.cdhash }}"')
    expect(pack).toBeLessThan(mcpb)
    expect(index(all, 'build-mcpb.sh . "${{ steps.bundle.outputs.cdhash }}"')).toBeLessThan(mcpb)
  })

  test('attests the actions artifacts in their own step and leaves the read step as it was', () => {
    const attest = all.filter((s) => s.includes('attest-build-provenance'))
    expect(attest).toHaveLength(2)
    expect(attest[0]).not.toContain('mail-actions')
    expect(attest[1]).toContain('mail-actions.zip')
    expect(attest[1]).toContain('steps.actions_mcpb.outputs.path')
  })
})

describe('release.yml', () => {
  const all = steps(read('.github/workflows/release.yml'))

  test('verifies everything before anything is published', () => {
    const firstPublish = index(all, 'scripts/release/publish.sh "')
    for (const check of ['verify-bundle.sh "bin', 'verify-bundle.sh "packages/actions', 'verify-npm-pack.sh "${{ steps.bundle', 'verify-npm-pack.sh "${{ steps.actions_bundle', 'build-mcpb.sh .', 'build-mcpb.sh packages/actions']) {
      expect(index(all, check), check).toBeLessThan(firstPublish)
    }
  })

  test('publishes the read package, then actions, then both registry entries', () => {
    const order = [
      index(all, 'scripts/release/publish.sh "${{ steps.npm.outputs.tarball }}"'),
      index(all, 'scripts/release/publish.sh --actions "${{ steps.actions_npm.outputs.tarball }}"'),
      index(all, 'scripts/publish-registry.sh --package read'),
      index(all, 'scripts/publish-registry.sh --package actions'),
    ]
    expect(order).toEqual([...order].sort((a, b) => a - b))
  })

  test('a failed actions publish fails the run: no automatic retry, no continue-on-error', () => {
    expect(all.join('\n')).not.toContain('continue-on-error')
    expect(all.join('\n')).not.toMatch(/retry/i)
  })

  test('registry entries use the checksum of the released asset, not of a rebuilt one', () => {
    // Ein Re-Run baut neu, die Bytes unterscheiden sich vom schon veroeffentlichten .mcpb.
    for (const fragment of ['--package read', '--package actions']) {
      const step = all[index(all, `scripts/publish-registry.sh ${fragment}`)]!
      expect(step).toMatch(new RegExp(`publish-registry\\.sh ${fragment}\\n`))
      expect(step).toContain('GH_TOKEN')
    }
  })
})

describe('release-candidate.yml', () => {
  const yml = read('.github/workflows/release-candidate.yml')

  test('publishes nothing', () => {
    const all = steps(yml).join('\n')
    for (const forbidden of ['publish.sh', 'publish-registry.sh', 'npm publish', 'gh release']) {
      expect(all, forbidden).not.toContain(forbidden)
    }
  })

  test('uploads the actions artifacts in their own gated step', () => {
    const all = steps(yml)
    const upload = all.filter((s) => s.includes('upload-artifact'))
    expect(upload).toHaveLength(2)
    expect(upload[0]).not.toContain(GATE)
    expect(upload[1]).toContain(GATE)
    for (const path of ['mail-actions.zip', 'steps.actions_mcpb.outputs.path', 'steps.actions_npm.outputs.tarball']) {
      expect(upload[1]).toContain(path)
    }
  })
})

describe('ci.yml', () => {
  const yml = read('.github/workflows/ci.yml')

  test('always covers the actions package, without the gate', () => {
    expect(yml).not.toContain('steps.actions.outputs')
    expect(yml).not.toContain('actions-enabled.sh')
    expect(yml).toContain('run: npm run test:swift')
    expect(yml).toContain('run: npm run build --workspace packages/actions')
    expect(yml).toContain('run: npm run build:helper --workspace packages/actions')
    expect(yml).toContain('validate packages/actions/manifest.json')
  })

  test('verify-bundle.sh must reject both ad-hoc bundles', () => {
    expect(yml).toMatch(/if scripts\/release\/verify-bundle\.sh "bin\/Mail MCP Helper \(Ad hoc\)\.app" "\$REQUIREMENT"/)
    expect(yml).toMatch(/if scripts\/release\/verify-bundle\.sh "packages\/actions\/bin\/Mail MCP Actions \(Ad hoc\)\.app" "\$REQUIREMENT"/)
  })
})

describe('registry.yml', () => {
  const yml = read('.github/workflows/registry.yml')

  test('can publish either entry, the read one by default, and stays outside the release environment', () => {
    expect(yml).toMatch(/options:\s*\[read, actions\]/)
    expect(yml).toContain('default: read')
    expect(yml).toContain('scripts/publish-registry.sh --package "$PACKAGE"')
    expect(yml).not.toContain('environment:')
  })
})

test('npm run test:swift covers both Swift packages', () => {
  const script = JSON.parse(read('package.json')).scripts['test:swift'] as string
  expect(script).toContain('swift test --package-path swift')
  expect(script).toContain('swift test --package-path packages/actions/swift')
})

describe('docs/releasing.md', () => {
  const docs = read('docs/releasing.md')

  test('describes the gate, the actions artifacts and the retry', () => {
    for (const fragment of ['scripts/release/actions-enabled.sh', 'apple-mail-actions-mcp-<version>.mcpb', 'SHA256SUMS-actions', '--package actions', '0.0.0-stage', 'direct publishing is selected']) {
      expect(docs, fragment).toContain(fragment)
    }
    expect(docs).toMatch(/retry/i)
  })
})
