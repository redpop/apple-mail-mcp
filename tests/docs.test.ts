import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from 'vitest'

const root = join(import.meta.dirname, '..')
const read = (p: string): string => readFileSync(join(root, p), 'utf8')

// Nutzerdokumente: README und docs/*.md. docs/superpowers, docs/spikes und docs/decisions-* sind
// git-ignoriert und liegen nicht im Repository; docs/ wird nur auf der obersten Ebene gelesen.
const userDocs = ['README.md', ...readdirSync(join(root, 'docs')).filter((f) => f.endsWith('.md') && !f.startsWith('decisions-')).map((f) => `docs/${f}`)]

test('README config table lists every config variable', () => {
  const vars = new Set(read('src/config.ts').match(/APPLE_MAIL_[A-Z_]+/g))
  expect(vars.size).toBeGreaterThan(0)
  const readme = read('README.md')
  for (const v of vars) expect(readme, v).toContain(`\`${v}\``)
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
