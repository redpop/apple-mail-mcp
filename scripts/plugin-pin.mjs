// Hebt den npx-Pin eines Plugins auf eine veroeffentlichte Version: standardmaessig des Lese-Plugins
// (plugin/.claude-plugin/plugin.json), mit --package actions des Actions-Plugins.
//
// Das Plugin pinnt exakt (das Verzeichnis lehnt Spannen und @latest ab). Viele Nutzer haben in npm
// einen Cooldown (min-release-age): npm lehnt dann Versionen ab, die juenger sind, und npx faellt
// nicht auf eine aeltere zurueck. Deshalb folgt der Pin npm erst, wenn eine Version MIN_DAYS alt
// ist. Den Cooldown des Nutzers hebeln wir bewusst nicht aus.
//
//   node scripts/plugin-pin.mjs next [--min-days N] [--package read|actions]
//                                                     gibt die naechste Pin-Version aus (oder nichts)
//   node scripts/plugin-pin.mjs apply <version> [--package read|actions]
//                                                     schreibt den Pin; Einstellungen und Umgebung
//                                                     aus dem Manifest am Tag v<version>
//
// Laeuft im Workflow plugin-pin.yml, der daraus einen PR macht.
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

export const PACKAGES = {
  read: { name: '@redpop/apple-mail-mcp', pluginFile: 'plugin/.claude-plugin/plugin.json', manifestFile: 'manifest.json', server: 'apple-mail' },
  actions: {
    name: '@redpop/apple-mail-actions-mcp',
    pluginFile: 'packages/actions/plugin/.claude-plugin/plugin.json',
    manifestFile: 'packages/actions/manifest.json',
    server: 'apple-mail-actions',
  },
}
export const MIN_DAYS = 7
const DAY_MS = 24 * 60 * 60 * 1000

// Nur x.y.z; Vorabversionen pinnen wir nie.
const parse = (v) => (/^\d+\.\d+\.\d+$/.test(v) ? v.split('.').map(Number) : null)
const compare = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]

/** Hoechste stabile Version ueber `current`, die mindestens `minDays` alt ist; sonst null. */
export function nextPin(time, current, now, minDays = MIN_DAYS) {
  const cur = parse(current)
  if (!cur) throw new Error(`current pin is not x.y.z: ${current}`)
  let best = null
  for (const [version, published] of Object.entries(time)) {
    const v = parse(version)
    if (!v || compare(v, cur) <= 0) continue
    if (now - Date.parse(published) < minDays * DAY_MS) continue
    if (!best || compare(v, parse(best)) > 0) best = version
  }
  return best
}

/** Plugin mit Pin auf `version`; Einstellungen und Umgebung aus dem Manifest dieser Version. */
export function pinPlugin(plugin, version, manifest, which = 'read') {
  const pkg = PACKAGES[which]
  if (!pkg) throw new Error(`unknown package: ${which}`)
  return {
    ...plugin,
    version,
    mcpServers: {
      [pkg.server]: { command: 'npx', args: ['-y', `${pkg.name}@${version}`], env: manifest.server.mcp_config.env },
    },
    userConfig: manifest.user_config,
  }
}

// Nur als Skript ausfuehren, nicht beim Import aus den Tests.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2)
  // --package darf an beliebiger Stelle stehen; ohne die Option gilt das Lese-Plugin.
  let which = 'read'
  const at = args.indexOf('--package')
  if (at !== -1) {
    which = args[at + 1] ?? ''
    args.splice(at, 2)
  }
  const pkg = PACKAGES[which]
  if (!pkg) {
    console.error(`unknown package: ${which}`)
    process.exit(2)
  }
  const [mode, arg, value] = args
  const plugin = JSON.parse(readFileSync(pkg.pluginFile, 'utf8'))
  if (mode === 'next') {
    const minDays = arg === '--min-days' ? Number(value) : MIN_DAYS
    if (!Number.isInteger(minDays) || minDays < 0) throw new Error(`invalid --min-days: ${value}`)
    let time
    try {
      time = JSON.parse(execFileSync('npm', ['view', pkg.name, 'time', '--json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }))
    } catch (e) {
      // Ein Paket, das npm noch nicht kennt (E404), hat nichts zu pinnen; jeder andere Fehler bleibt einer.
      if (/E404/.test(`${e.stderr ?? ''}${e.stdout ?? ''}`)) process.exit(0)
      throw e
    }
    const next = nextPin(time, plugin.version, Date.now(), minDays)
    if (next) console.log(next)
  } else if (mode === 'apply' && parse(arg ?? '')) {
    const manifest = JSON.parse(execFileSync('git', ['show', `v${arg}:${pkg.manifestFile}`], { encoding: 'utf8' }))
    writeFileSync(pkg.pluginFile, `${JSON.stringify(pinPlugin(plugin, arg, manifest, which), null, 2)}\n`)
    console.log(`Plugin pinned to ${arg}`)
  } else {
    console.error('usage: plugin-pin.mjs next [--min-days N] | apply <x.y.z> [--package read|actions]')
    process.exit(2)
  }
}
