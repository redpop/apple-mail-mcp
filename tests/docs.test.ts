import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from 'vitest'

const root = join(import.meta.dirname, '..')
const read = (p: string): string => readFileSync(join(root, p), 'utf8')

// Dokumente im Repository: README, SECURITY, CLAUDE und docs/*.md. docs/superpowers, docs/spikes und
// docs/decisions-* sind git-ignoriert und liegen nicht im Repository; docs/ wird nur auf der obersten Ebene gelesen.
const userDocs = ['README.md', 'SECURITY.md', 'CLAUDE.md', ...readdirSync(join(root, 'docs')).filter((f) => f.endsWith('.md') && !f.startsWith('decisions-')).map((f) => `docs/${f}`)]

test('README config table lists every config variable', () => {
  const vars = new Set(read('src/config.ts').match(/APPLE_MAIL_[A-Z_]+/g))
  expect(vars.size).toBeGreaterThan(0)
  // Nur die erste Spalte der Tabelle unter "## Configuration" zaehlt; eine Erwaehnung im Fliesstext reicht nicht.
  const section = read('README.md').split(/^## /m).find((s) => s.startsWith('Configuration\n'))
  expect(section, 'README has a Configuration section').toBeDefined()
  const rows = new Set([...section!.matchAll(/^\| `(APPLE_MAIL_[A-Z_]+)` \|/gm)].map((m) => m[1]))
  for (const v of vars) expect(rows, v).toContain(v)
})

test('docs never name a real mailbox domain outside example domains', () => {
  // Reservierte Beispieldomains (RFC 2606) plus die Domains der Projekt-, Plattform- und Paketlinks.
  // Die Allowlist ist absichtlich eng: jede neue Domain muss hier bewusst eingetragen werden.
  const allowed = /^(example\.(com|org|net)|([a-z0-9-]+\.)*test|github\.com|apple\.com|anthropic\.com|npmjs\.com|modelcontextprotocol\.io)$/i
  for (const file of userDocs) {
    for (const m of read(file).matchAll(/[A-Za-z0-9._%+-]+@([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+)/g)) {
      // "@redpop/apple-mail-mcp" hat keinen Punkt nach dem @ und trifft nicht; "@user.github.io"-artige Treffer schon.
      expect(m[1], `${file}: ${m[0]}`).toMatch(allowed)
    }
  }
})
