// prepublishOnly-Hook: npm publish nur aus dem Release-Workflow und nur mit dem Release-Bundle.
//
// "files" nimmt ganz bin/ ins Paket. Ein lokaler Checkout hat dort das Dev- oder Ad-hoc-Bundle;
// veroeffentlicht schaltete es beim Nutzer nichts frei, wuerde aber nie von Developer ID
// signiert sein. Deshalb: ausserhalb der CI gar nicht, und in bin/ genau das Release-Bundle.
import { readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const RELEASE_BUNDLE = 'Mail MCP Helper.app'

export function checkPublish(env, binEntries) {
  if (env.CI !== 'true') return 'npm publish runs only from the release workflow (CI=true).'
  const others = binEntries.filter((e) => e !== RELEASE_BUNDLE)
  if (others.length > 0) return `bin/ must contain only ${RELEASE_BUNDLE}; found: ${others.join(', ')}.`
  if (!binEntries.includes(RELEASE_BUNDLE)) return `bin/${RELEASE_BUNDLE} is missing.`
  return null
}

// Nur als Skript ausfuehren, nicht beim Import aus den Tests.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  let entries = []
  try {
    entries = readdirSync('bin').filter((e) => e !== '.DS_Store')
  } catch {
    // Kein bin/: checkPublish meldet das fehlende Bundle.
  }
  const error = checkPublish(process.env, entries)
  if (error) {
    console.error(`check-publish: ${error}`)
    process.exit(1)
  }
}
