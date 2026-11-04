import { existsSync } from 'node:fs'
import type { Writable } from 'node:stream'
import type { Config } from '@redpop/apple-mail-mcp/dist/config.js'
import { HelperError } from '@redpop/apple-mail-mcp/dist/errors.js'
import type { HelperRunner } from '@redpop/apple-mail-mcp/dist/helper.js'
import { computePolicy } from '@redpop/apple-mail-mcp/dist/policy.js'
import { listMailboxesResult, probeResult, type ProbeResult } from '@redpop/apple-mail-mcp/dist/schemas.js'
import { readBundleId } from '@redpop/apple-mail-mcp/dist/signing.js'
import { ADHOC_BUNDLE_ID, checkActionsBundle, DEV_BUNDLE_ID, RELEASE_BUNDLE_ID } from '../bundle.js'
import type { ActionsConfigResult } from '../config.js'
import { ActionsError, describeActionsError } from '../errors.js'
import { unsupportedAccountReason, type UnsupportedAccountReason } from '../rules.js'

export type DoctorExec = (file: string, args: string[]) => { stdout: string; stderr: string; status: number }

export interface ActionsDoctorDeps {
  /** Der Lese-Doctor; schreibt auf dasselbe `out` und liefert seinen Exit-Code. */
  readDoctor: () => Promise<number>
  helper: HelperRunner
  actions: HelperRunner
  /** Konfiguration des Actions-Pakets; bei Fehler steht der Schluessel im Ergebnis. */
  configResult: ActionsConfigResult
  /** Konfiguration des Lesepakets, auch wenn die des Actions-Pakets scheitert (leere Kontenliste). */
  baseConfig: Config | null
  bundlePath: string
  override: boolean
  exec: DoctorExec
  exists?: (path: string) => boolean
  out: Writable
  verbose: boolean
}

type Status = 'ok' | 'warn' | 'fail'

const REASON_TEXT: Record<UnsupportedAccountReason, string> = {
  type: 'not an IMAP account',
  allmail: 'has an "All Mail" folder',
  gmail: 'Gmail accounts are not supported',
  name_missing: 'Mail does not report a usable account name',
  name_duplicate: 'another account has the same name',
}

/** Systemaufruf als ExecFn des Bundle-Gatters: Fehlschlag wirft. */
function throwing(exec: DoctorExec): (file: string, args: string[]) => string {
  return (file, args) => {
    const r = exec(file, args)
    if (r.status !== 0) throw new Error('exec failed')
    return r.stdout
  }
}

/** true: Spalte fehlt, false: vorhanden, null: unbekannt. Quelle sind `missing` und die CREATE-Zeilen der Probe. */
function headerColumnMissing(schema: NonNullable<ProbeResult['schema']>): boolean | null {
  if (schema.missing.some((m) => m.includes('message_id_header'))) return true
  const table = (schema.ddl ?? []).find((d) => /CREATE\s+TABLE\s+(IF NOT EXISTS\s+)?"?message_global_data"?/i.test(d))
  if (table === undefined) return null
  return !table.includes('message_id_header')
}

export async function runActionsDoctor(deps: ActionsDoctorDeps): Promise<number> {
  const checks: { id: string; status: Status; message: string }[] = []
  const add = (id: string, status: Status, message: string): void => void checks.push({ id, status, message })

  const readExit = await deps.readDoctor()

  // Bundle und Signatur
  const override = deps.override
  let bundleFine = false
  try {
    checkActionsBundle(deps.bundlePath, { override, exec: throwing(deps.exec), exists: deps.exists ?? existsSync })
    bundleFine = true
    let id = 'unknown'
    try {
      id = readBundleId(deps.bundlePath, throwing(deps.exec))
    } catch {
      // Das Gatter hat die ID schon gelesen.
    }
    const kind = id === RELEASE_BUNDLE_ID ? 'release' : id === DEV_BUNDLE_ID ? 'development' : id === ADHOC_BUNDLE_ID ? 'ad hoc' : 'unknown'
    add('actions-bundle', kind === 'ad hoc' ? 'warn' : 'ok', `Actions bundle found, ${kind} signature, identifier ${id}.`)
  } catch (e) {
    add('actions-bundle', 'fail', e instanceof ActionsError ? describeActionsError(e.code) : 'The Actions bundle could not be checked.')
  }

  // Automation-Freigabe (nie ein Dialog: nur `permission`)
  if (bundleFine) {
    try {
      const status = ((await deps.actions.run('permission', {})) as { status?: unknown } | null)?.status
      if (status === 'granted') add('automation', 'ok', 'Automation: Mail MCP Actions may control Mail.')
      else if (status === 'mail_not_running') add('automation', 'warn', 'Automation: unknown because Mail is not running. Open Mail and run doctor again.')
      else if (status === 'denied') add('automation', 'fail', 'Automation: denied. Switch on Mail under "Mail MCP Actions" in System Settings > Privacy & Security > Automation.')
      else if (status === 'undetermined') add('automation', 'warn', 'Automation: not asked yet. Run `setup` with Mail open.')
      else add('automation', 'fail', 'Automation: the Actions app gave an unexpected answer.')
    } catch (e) {
      add('automation', 'fail', e instanceof ActionsError ? describeActionsError(e.code) : e instanceof HelperError && e.code === 'MAIL_NOT_RUNNING' ? 'Automation: unknown because Mail is not running.' : describeActionsError('ACTIONS_UNAVAILABLE'))
    }
  }

  // Konfiguration
  const cfg = deps.configResult
  if (!cfg.ok && cfg.key === 'APPLE_MAIL_ACCOUNTS') {
    add('accounts-config', 'warn', 'APPLE_MAIL_ACCOUNTS is not set. The server refuses to move messages without it; set it to the accounts it may touch.')
  } else if (!cfg.ok) {
    add('accounts-config', 'fail', `Configuration error in ${cfg.key}: ${cfg.error}`)
  } else {
    add('accounts-config', 'ok', `APPLE_MAIL_ACCOUNTS names ${cfg.config.accounts.length} entr${cfg.config.accounts.length === 1 ? 'y' : 'ies'}; at most ${cfg.config.maxMoves} moves per call.`)
  }

  // Helper-Abfragen: Kopfspalte und Konten
  let probe: ProbeResult | null = null
  try {
    probe = probeResult.parse(await deps.helper.run('probe', {}))
  } catch {
    probe = null
  }
  if (probe?.access === 'granted' && probe.schema) {
    const missing = headerColumnMissing(probe.schema)
    if (missing === true) add('message-id-header', 'warn', 'Mail has no message_id_header column on this Mac (macOS 15): the tool cannot move mail on this Mac.')
    else if (missing === null) add('message-id-header', 'warn', 'Whether the message_id_header column exists could not be determined.')
    else add('message-id-header', 'ok', 'The message_id_header column exists.')

    if (deps.baseConfig === null) {
      add('accounts', 'warn', 'Accounts are not listed because the configuration is invalid.')
    } else {
      try {
        const raw = listMailboxesResult.parse(await deps.helper.run('list-mailboxes', {}))
        const policy = computePolicy(deps.baseConfig, raw)
        if (policy.accounts.length === 0) add('accounts', 'warn', 'No visible account matches the configuration.')
        policy.accounts.forEach((a, i) => {
          const reason = unsupportedAccountReason(raw, a.id)
          // Wie der Lese-Doctor: ohne --verbose keine Kontennamen oder -kennungen.
          const label = deps.verbose ? `${a.name} (${a.id})` : `Account ${i + 1}`
          add(`account-${i + 1}`, reason === null ? 'ok' : 'warn', reason === null ? `${label}: supported.` : `${label}: unsupported, ${REASON_TEXT[reason]}.`)
        })
      } catch {
        add('accounts', 'warn', 'Accounts could not be listed.')
      }
    }
  } else {
    add('message-id-header', 'warn', 'The header column and the accounts could not be checked because the Mail database is not readable (see above).')
  }

  for (const c of checks) deps.out.write(`[${c.status}] ${c.id}: ${c.message}\n`)
  return readExit !== 0 || checks.some((c) => c.status === 'fail') ? 1 : 0
}
