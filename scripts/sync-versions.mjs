// Haelt alle Versionsangaben mit package.json im Gleichklang.
//
// Die Version steht ausser in package.json noch in server.json (Server, beide Pakete und die
// URL des MCPB-Assets), in manifest.json (sobald es existiert) und im Swift-Quelltext des Helpers.
// tests/packaging.test.ts meldet eine Abweichung, dieses Skript verhindert sie. Das Plugin folgt
// npm bewusst spaeter und getrennt (scripts/plugin-pin.mjs).
//
// Laeuft als npm-"version"-Hook, also zwischen Versionsbump und Commit, und im Release-Workflow
// (dort prueft scripts/release/check-tag.sh, dass es nichts mehr aendert).
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const root = new URL('../', import.meta.url)
const path = (name) => fileURLToPath(new URL(name, root))
const readJson = (name) => JSON.parse(readFileSync(path(name), 'utf8'))
const writeJson = (name, value) => writeFileSync(path(name), `${JSON.stringify(value, null, 2)}\n`)

const { version, name: rootName } = readJson('package.json')

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

// Actions-Paket: Version und die exakte Abhaengigkeit vom Lesepaket folgen der Wurzel.
// packages/actions/manifest.json und server.json gibt es erst ab Task 8 (MCPB und Registry); bis dahin werden sie uebersprungen.
// Fehlt packages/actions ganz (etwa in den Temp-Repos der Release-Tests), entfaellt der Abschnitt.
const actionsPkg = 'packages/actions/package.json'
if (existsSync(path(actionsPkg))) {
  const actions = readJson(actionsPkg)
  actions.version = version
  actions.dependencies = { ...actions.dependencies, [rootName]: version }
  writeJson(actionsPkg, actions)

  for (const name of ['packages/actions/manifest.json', 'packages/actions/server.json']) {
    if (!existsSync(path(name))) continue
    const doc = readJson(name)
    doc.version = version
    if (Array.isArray(doc.packages)) {
      for (const entry of doc.packages) {
        entry.version = version
        if (entry.registryType === 'mcpb') {
          entry.identifier = entry.identifier.replace(/\/v[^/]+\/(.*?)-[^-/]+\.mcpb$/, `/v${version}/$1-${version}.mcpb`)
        }
      }
    }
    writeJson(name, doc)
  }

  // Gleicher Text wie in packages/actions/swift/build.sh.
  const actionsSwift = 'packages/actions/swift/Sources/MailActionsCore/Version.generated.swift'
  const actionsBody = `// Von packages/actions/swift/build.sh aus package.json erzeugt. Bewusst eingecheckt (mit dem aktuellen Wert),
// damit \`swift test\` ohne build.sh kompiliert; build.sh schreibt die Datei nur, wenn sich der Wert aendert.
public let helperVersion = "${version}"
`
  if (!existsSync(path(actionsSwift)) || readFileSync(path(actionsSwift), 'utf8') !== actionsBody) writeFileSync(path(actionsSwift), actionsBody)

  // package-lock.json fuehrt die Workspace-Version ebenfalls; npm version kennt sie nicht.
  if (existsSync(path('package-lock.json'))) {
    const lock = readJson('package-lock.json')
    const entry = lock.packages?.['packages/actions']
    if (entry) {
      entry.version = version
      entry.dependencies = { ...entry.dependencies, [rootName]: version }
      writeJson('package-lock.json', lock)
    }
  }
}

console.log(`Versions set to ${version}`)
