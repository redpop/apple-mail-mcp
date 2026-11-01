import { existsSync, rmSync } from 'node:fs'
import type { Config, ConfigResult } from '../config.js'
import type { HelperRunner } from '../helper.js'
import type { Policy } from '../policy.js'
import { createIndexer, type Indexer } from './indexer.js'
import { foreignLeaseValid } from './lease.js'
import { indexDir, loadSqlite } from './store.js'

const stderr = (line: string): void => void process.stderr.write(`apple-mail-mcp: ${line}\n`)

/** Index nur mit Body-Suche: ohne sie haette er keinen Nutzen, aber eine Kopie auf der Platte (Spec 5.1). */
export function bodyIndexEnabled(config: Config): boolean {
  return config.bodyIndex && config.bodySearch
}

/**
 * Beim Start, nach loadConfig (Spec 5.8): ungueltige Konfiguration tut nichts; Index aus loescht das
 * Verzeichnis, ausser ein anderer Server haelt gerade einen gueltigen Lease (Entscheidung 7).
 */
export function cleanupOnStartup(
  configResult: ConfigResult,
  opts: { dir?: string; now?: () => number; alive?: (pid: number) => boolean; log?: (line: string) => void } = {},
): 'invalid' | 'enabled' | 'absent' | 'kept' | 'deleted' {
  if (!configResult.ok) return 'invalid'
  if (bodyIndexEnabled(configResult.config)) return 'enabled'
  const dir = opts.dir ?? indexDir()
  if (!existsSync(dir)) return 'absent'
  if (foreignLeaseValid(dir, { now: opts.now, alive: opts.alive })) return 'kept'
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {
    return 'kept'
  }
  ;(opts.log ?? stderr)('body index is off; deleted the index')
  return 'deleted'
}

/**
 * Raeumt beim Start auf und legt bei eingeschaltetem Index den Indexer an. Er startet erst mit
 * notify() nach einem erfolgreichen Helper-Aufruf. Fehlt node:sqlite oder FTS5-trigram, bleibt der
 * Index aus (null); geloescht wird dann nichts. Wirft nie.
 */
export async function startBodyIndex(deps: {
  configResult: ConfigResult
  runner: HelperRunner
  policy: () => Promise<Policy>
  log?: (line: string) => void
}): Promise<Indexer | null> {
  const log = deps.log ?? stderr
  try {
    if (cleanupOnStartup(deps.configResult, { log }) !== 'enabled' || !deps.configResult.ok) return null
    const sqlite = await loadSqlite()
    if (sqlite === null) {
      log('body index is on, but this Node has no node:sqlite with FTS5 trigram; searching live')
      return null
    }
    return createIndexer({ runner: deps.runner, config: deps.configResult.config, policy: deps.policy, sqlite, dir: indexDir(), log })
  } catch {
    log('body index could not start; searching live')
    return null
  }
}
