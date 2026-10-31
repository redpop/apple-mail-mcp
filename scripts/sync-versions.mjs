// Haelt alle Versionsangaben mit package.json im Gleichklang.
//
// Die Version steht ausser in package.json noch in server.json (Server, beide Pakete und die
// URL des MCPB-Assets), in manifest.json (sobald es existiert) und im Swift-Quelltext des
// Helpers. tests/packaging.test.ts meldet eine Abweichung, dieses Skript verhindert sie.
//
// Laeuft als npm-"version"-Hook, also zwischen Versionsbump und Commit, und im Release-Workflow
// (dort prueft scripts/release/check-tag.sh, dass es nichts mehr aendert).
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const root = new URL('../', import.meta.url)
const path = (name) => fileURLToPath(new URL(name, root))
const readJson = (name) => JSON.parse(readFileSync(path(name), 'utf8'))
const writeJson = (name, value) => writeFileSync(path(name), `${JSON.stringify(value, null, 2)}\n`)

const { version } = readJson('package.json')

const server = readJson('server.json')
server.version = version
for (const entry of server.packages) {
  entry.version = version
  if (entry.registryType === 'mcpb') {
    entry.identifier = `https://github.com/redpop/apple-mail-mcp/releases/download/v${version}/apple-mail-mcp-${version}.mcpb`
  }
}
writeJson('server.json', server)

if (existsSync(path('manifest.json'))) {
  const manifest = readJson('manifest.json')
  manifest.version = version
  writeJson('manifest.json', manifest)
}

// Gleicher Text wie in swift/build.sh, damit build.sh die Datei danach unveraendert laesst.
const swiftFile = 'swift/Sources/MailHelperCore/Version.generated.swift'
const swiftBody = `// Von swift/build.sh aus package.json erzeugt. Bewusst eingecheckt (mit dem aktuellen Wert),
// damit \`swift test\` ohne build.sh kompiliert; build.sh schreibt die Datei nur, wenn sich der Wert aendert.
public let helperVersion = "${version}"
`
if (!existsSync(path(swiftFile)) || readFileSync(path(swiftFile), 'utf8') !== swiftBody) writeFileSync(path(swiftFile), swiftBody)

console.log(`Versions set to ${version}`)
