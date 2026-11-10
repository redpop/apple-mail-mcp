import type { Writable } from 'node:stream'
import { HelperError } from '@redpop/apple-mail-mcp/dist/errors.js'
import type { HelperRunner } from '@redpop/apple-mail-mcp/dist/helper.js'
import { describeActionsError } from '../errors.js'

export interface ActionsSetupDeps {
  /** Das Setup des Lesepakets (Full Disk Access); Exit-Code 0 heisst Zugriff erteilt. */
  readSetup: () => Promise<number>
  actions: HelperRunner
  out: Writable
}

const SETTINGS_LINE = 'System Settings > Privacy & Security > Automation'

/**
 * `setup` des Actions-Pakets: erst Full Disk Access ueber das Lese-Setup, dann die Automation-Freigabe.
 * Ohne Zugriff kein Automation-Dialog; der Dialog ist ein Apple Event und braucht laufendes Mail.
 */
export async function runActionsSetup(deps: ActionsSetupDeps): Promise<number> {
  const say = (s: string): void => void deps.out.write(s + '\n')

  const fda = await deps.readSetup()
  if (fda !== 0) {
    say('')
    say('Full Disk Access is not in place yet, so the Automation step was skipped. Fix the steps above, then run setup again.')
    return 1
  }

  say('')
  say('Next: Mail MCP Actions needs permission to control Mail (Automation).')
  let status: unknown
  try {
    status = ((await deps.actions.run('request-permission', {})) as { status?: unknown } | null)?.status
  } catch (e) {
    if (e instanceof HelperError && e.code === 'MAIL_NOT_RUNNING') status = 'mail_not_running'
    else if (e instanceof HelperError && e.code === 'AUTOMATION_NOT_GRANTED') status = 'denied'
    else {
      say(e instanceof HelperError && e.code.startsWith('HELPER_') ? describeActionsError('ACTIONS_UNAVAILABLE') : 'The Mail MCP Actions app could not be asked for the permission.')
      return 1
    }
  }

  switch (status) {
    case 'granted':
      say('Automation is allowed: Mail MCP Actions can control Mail.')
      say('Set APPLE_MAIL_ACCOUNTS to the accounts the server may move messages in; without it no message is ever moved.')
      return 0
    case 'mail_not_running':
      say('Mail is not running. macOS can only ask for the permission while Mail is open.')
      say('Open Mail, then run setup again.')
      return 1
    case 'denied':
      say(`macOS refused the permission. Open ${SETTINGS_LINE}, switch on Mail under "Mail MCP Actions", then run setup again.`)
      return 1
    default:
      say('The permission dialog was dismissed or did not appear. Run setup again and choose OK.')
      return 1
  }
}
