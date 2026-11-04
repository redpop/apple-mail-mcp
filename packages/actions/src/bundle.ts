import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { readBundleId, TEAM_ID, type ExecFn } from '@redpop/apple-mail-mcp/dist/signing.js'
import { createStdioRunner, type StdioHelperRunner, type StdioOptions, type StdioTimeouts } from '@redpop/apple-mail-mcp/dist/stdioRunner.js'
import type { ActionsConfig } from './config.js'
import { ActionsError } from './errors.js'

// Die IDs stehen auch in packages/actions/swift/build.sh; tests/signing.test.ts prueft, dass sie passen.
export const RELEASE_BUNDLE_ID = 'io.github.redpop.apple-mail-mcp.mail-actions'
export const DEV_BUNDLE_ID = RELEASE_BUNDLE_ID + '.dev'
export const ADHOC_BUNDLE_ID = RELEASE_BUNDLE_ID + '.adhoc'

export const RELEASE_REQUIREMENT =
  `identifier "${RELEASE_BUNDLE_ID}" and anchor apple generic and certificate 1[field.1.2.840.113635.100.6.2.6] exists and certificate leaf[subject.OU] = "${TEAM_ID}"`

/** Mehr als die 2 Minuten, nach denen ein Apple Event selbst aufgibt: Sonst gaelte ein noch laufender Zug als tot. */
export const ACTIONS_TIMEOUTS: StdioTimeouts = { firstRequestMs: 130_000, requestMs: 130_000 }

const defaultExec: ExecFn = (file, args) => execFileSync(file, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })

/** Wo das Bundle im ausgelieferten Paket liegt (gleich fuer src/ und dist/). */
export function packagedActionsBundle(): string {
  return fileURLToPath(new URL('../bin/Mail MCP Actions.app', import.meta.url))
}

export function resolveActionsBundle(config: ActionsConfig): string {
  return config.actionsPath ?? packagedActionsBundle()
}

export function actionsExecutable(bundle: string): string {
  return `${bundle}/Contents/MacOS/mail-actions`
}

/**
 * Signaturgatter vor dem ersten Start, nach dem Muster von checkBundle im Lesepaket. Der Override erlaubt nur
 * Dev- und Ad-hoc-Bundles: Eine Release-ID per Override waere ein fremder Build mit der Freigabe des Nutzers.
 */
export function checkActionsBundle(bundle: string, opts: { override: boolean; exec?: ExecFn; exists?: (path: string) => boolean }): void {
  const exec = opts.exec ?? defaultExec
  if (!(opts.exists ?? existsSync)(bundle)) throw new ActionsError('ACTIONS_BUNDLE_MISSING')
  let id: string
  try {
    id = readBundleId(bundle, exec)
  } catch {
    throw new ActionsError('ACTIONS_SIGNATURE_INVALID')
  }
  if (id === RELEASE_BUNDLE_ID) {
    if (opts.override) throw new ActionsError('ACTIONS_SIGNATURE_INVALID')
    try {
      exec('/usr/bin/codesign', ['--verify', '--strict', '--deep', `-R=${RELEASE_REQUIREMENT}`, bundle])
    } catch {
      throw new ActionsError('ACTIONS_SIGNATURE_INVALID')
    }
    return
  }
  if (opts.override && (id === DEV_BUNDLE_ID || id === ADHOC_BUNDLE_ID)) return
  throw new ActionsError('ACTIONS_SIGNATURE_INVALID')
}

/**
 * Ein Runner pro Serverprozess; das Gatter laeuft einmal vor dem ersten Start, auch ein Fehlschlag bleibt
 * bis zum Prozessende stehen (wie createHelperRunner).
 */
export function createActionsRunner(
  config: ActionsConfig,
  deps: {
    check?: (bundle: string, opts: { override: boolean }) => void
    makeRunner?: (executable: string, options: { debug: boolean }) => StdioHelperRunner
  } = {},
): StdioHelperRunner & { bundlePath: string } {
  const bundlePath = resolveActionsBundle(config)
  const options = { debug: config.debug === true }
  const inner = (deps.makeRunner ?? ((exe, opts: StdioOptions) => createStdioRunner(exe, ACTIONS_TIMEOUTS, opts)))(actionsExecutable(bundlePath), options)
  const check = deps.check ?? checkActionsBundle
  let gate: unknown
  return {
    bundlePath,
    run(command, payload) {
      if (gate === undefined) {
        try {
          check(bundlePath, { override: config.actionsPath !== null })
          gate = true
        } catch (e) {
          gate = e
        }
      }
      if (gate !== true) return Promise.reject(gate)
      return inner.run(command, payload)
    },
    stop: () => inner.stop(),
    helperVersion: () => inner.helperVersion(),
  }
}
