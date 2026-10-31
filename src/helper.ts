import { fileURLToPath } from 'node:url'
import type { Config } from './config.js'
import { checkBundle } from './signing.js'
import { createStdioRunner, type StdioHelperRunner, type StdioOptions } from './stdioRunner.js'

export interface HelperRunner {
  run(command: string, payload: Record<string, unknown>): Promise<unknown>
  /** helperVersion aus dem hello-Handshake, sobald einer stattgefunden hat (fuer state.json). */
  helperVersion?(): string | null
}

/** Wo das Bundle im ausgelieferten Paket liegt (gleich fuer src/ und dist/). */
export function packagedHelperBundle(): string {
  return fileURLToPath(new URL('../bin/Mail MCP Helper.app', import.meta.url))
}

export function resolveHelperBundle(config: Config): string {
  return config.helperPath ?? packagedHelperBundle()
}

export function helperExecutable(bundle: string): string {
  return `${bundle}/Contents/MacOS/mail-helper`
}

/**
 * Ein Runner pro Serverprozess; das Signaturgatter laeuft einmal vor dem ersten Start, das Ergebnis ist gecacht.
 * Auch ein Fehlschlag bleibt bis zum Prozessende stehen: nach einer Neuinstallation muss der Client neu starten
 * (docs/troubleshooting.md).
 */
export function createHelperRunner(
  config: Config,
  deps: {
    check?: (bundle: string, opts: { override: boolean }) => void
    makeRunner?: (executable: string, options: { debug: boolean }) => StdioHelperRunner
  } = {},
): HelperRunner & { stop(): void; bundlePath: string; helperVersion(): string | null } {
  const bundlePath = resolveHelperBundle(config)
  const options = { debug: config.debug === true }
  const inner = (deps.makeRunner ?? ((exe, opts: StdioOptions) => createStdioRunner(exe, undefined, opts)))(helperExecutable(bundlePath), options)
  const check = deps.check ?? checkBundle
  let gate: unknown
  return {
    bundlePath,
    run(command, payload) {
      if (gate === undefined) {
        try {
          check(bundlePath, { override: config.helperPath !== null })
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
