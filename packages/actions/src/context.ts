import { HelperError } from '@redpop/apple-mail-mcp/dist/errors.js'
import { defaultOpen, openFdaOnce, type OpenFn } from '@redpop/apple-mail-mcp/dist/fdaPrompt.js'
import type { HelperRunner } from '@redpop/apple-mail-mcp/dist/helper.js'
import { readBundleName } from '@redpop/apple-mail-mcp/dist/signing.js'
import type { ToolContext } from '@redpop/apple-mail-mcp/dist/context.js'
import type { ActionsConfig, ActionsConfigResult } from './config.js'
import { defaultLockFile, MoveLocks } from './locks.js'
import type { ActionsRunner } from './mover.js'

export interface ActionsContext {
  /** Wirft HelperError CONFIG_INVALID, wenn die Konfiguration ungueltig ist. */
  config(): ActionsConfig
  /** Lese-Helper des Lesepakets (list-mailboxes, locate). */
  helper: HelperRunner
  /** Actions-Bundle (permission, move). */
  actions: ActionsRunner
  locks: Pick<MoveLocks, 'isLocked' | 'lock' | 'tryLock'>
  /** Fuer respond() des Lesepakets: Fehler des Lese-Helpers (etwa FDA) laufen durch dessen Texte. */
  respondContext: ToolContext
}

export function createActionsContext(deps: {
  helper: HelperRunner
  actions: ActionsRunner
  configResult: ActionsConfigResult
  /** Bundle des Lese-Helpers, nicht des Actions-Bundles. */
  helperBundlePath: string
  helperName?: string
  locks?: Pick<MoveLocks, 'isLocked' | 'lock' | 'tryLock'>
  open?: OpenFn
}): ActionsContext {
  const open = deps.open ?? defaultOpen
  const config = (): ActionsConfig => {
    if (!deps.configResult.ok) throw new HelperError('CONFIG_INVALID', deps.configResult.key)
    return deps.configResult.config
  }
  const helperName = deps.helperName ?? (deps.helperBundlePath === '' ? 'Mail MCP Helper' : readBundleName(deps.helperBundlePath))
  // respond() braucht nur diese drei Felder; der Rest von ToolContext gehoert dem Lesepaket (Policy-Cache, Body-Index).
  const respondContext = {
    bundlePath: deps.helperBundlePath,
    helperName,
    onHelperError: (e: unknown): boolean => (e instanceof HelperError && e.code === 'FULL_DISK_ACCESS_REQUIRED' ? openFdaOnce(deps.helperBundlePath, open) : false),
  } as unknown as ToolContext
  return {
    config,
    helper: deps.helper,
    actions: deps.actions,
    locks: deps.locks ?? new MoveLocks(defaultLockFile()),
    respondContext,
  }
}
