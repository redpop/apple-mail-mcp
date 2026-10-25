import { fileURLToPath } from 'node:url'
import type { Config } from './config.js'
import { checkBundle } from './signing.js'
import { createStdioRunner, type StdioHelperRunner } from './stdioRunner.js'

export interface HelperRunner {
  run(command: string, payload: Record<string, unknown>): Promise<unknown>
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

/** Ein Runner pro Serverprozess; das Signaturgatter laeuft einmal vor dem ersten Start, das Ergebnis ist gecacht. */
export function createHelperRunner(
  config: Config,
  deps: {
    check?: (bundle: string, opts: { override: boolean }) => void
    makeRunner?: (executable: string) => StdioHelperRunner
  } = {},
): HelperRunner & { stop(): void; bundlePath: string } {
  const bundlePath = resolveHelperBundle(config)
  const inner = (deps.makeRunner ?? ((exe) => createStdioRunner(exe)))(helperExecutable(bundlePath))
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
  }
}
