export type ActionsErrorCode = 'MAIL_NOT_RUNNING' | 'AUTOMATION_NOT_GRANTED' | 'MOVE_FAILED' | 'LOCK_UNAVAILABLE' | 'ACTIONS_BUNDLE_MISSING' | 'ACTIONS_SIGNATURE_INVALID'

/** Fehler mit einem Code, den describeActionsError in einen englischen Satz fuer das Modell uebersetzt. */
export class ActionsError extends Error {
  constructor(
    readonly code: string,
    message?: string,
  ) {
    super(message ?? code)
    this.name = 'ActionsError'
  }
}

const TEXTS: Record<ActionsErrorCode, string> = {
  MAIL_NOT_RUNNING: 'Mail.app is not running. Moving messages needs it. Ask the user to open Mail and retry.',
  AUTOMATION_NOT_GRANTED:
    'macOS has not allowed "Mail MCP Actions" to control Mail. The user needs to open System Settings > Privacy & Security > Automation, ' +
    'switch on Mail under "Mail MCP Actions", and retry.',
  MOVE_FAILED: 'Mail did not move the message. Nothing was changed for this message; it may have been moved or deleted in the meantime.',
  LOCK_UNAVAILABLE:
    'The move protection file could not be read or written, so no message was moved. This is a local problem; ask the user to run the doctor command.',
  ACTIONS_BUNDLE_MISSING: 'The Mail MCP Actions app is missing from the installation, so no message was moved. Reinstalling the package should restore it.',
  ACTIONS_SIGNATURE_INVALID:
    'The Mail MCP Actions app is not signed correctly and was not started, so no message was moved. The user should reinstall the package from the official source.',
}

export function describeActionsError(code: string): string {
  return (TEXTS as Record<string, string>)[code] ?? `The move failed with the unexpected error code ${code}.`
}
