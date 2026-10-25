import { loadConfig, type Config } from '../config.js'
import { defaultOpen } from '../fdaPrompt.js'
import { createHelperRunner, packagedHelperBundle } from '../helper.js'
import { defaultDoctorExec, runDoctor } from './doctor.js'
import { runSetup } from './setup.js'

const DEFAULT_CONFIG: Config = {
  accounts: [], includeJunk: false, includeTrash: false, excludeMailboxes: [], showSecurityMails: false,
  bodySearch: true, maxResults: 50, maxBodyChars: 20000, helperPath: null, debug: false,
}

/** Einstieg fuer `setup` und `doctor`; stoppt den Helper in jedem Fall vor der Rueckkehr. */
export async function runCli(command: 'setup' | 'doctor', args: string[]): Promise<number> {
  const configResult = loadConfig(process.env)
  // setup braucht keine gueltige Konfiguration; doctor meldet den Fehler als Check.
  const config = configResult.ok ? configResult.config : DEFAULT_CONFIG
  const runner = createHelperRunner(config)
  try {
    if (command === 'setup') {
      return await runSetup({
        runner,
        bundlePath: runner.bundlePath || packagedHelperBundle(),
        open: defaultOpen,
        out: process.stdout,
        isTTY: process.stdout.isTTY === true,
        sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
        now: Date.now,
      })
    }
    return await runDoctor({
      runner,
      bundlePath: runner.bundlePath,
      configResult,
      exec: defaultDoctorExec,
      out: process.stdout,
      verbose: args.includes('--verbose'),
      json: args.includes('--json'),
      schema: args.includes('--schema'),
    })
  } finally {
    runner.stop()
  }
}
