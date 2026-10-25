/** Fehler mit einem Code, den der Helper oder Node geliefert hat. */
export class HelperError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = 'HelperError'
  }
}

/** Meldung fuer FULL_DISK_ACCESS_REQUIRED (Spec 10), mit eingesetztem Bundle-Pfad. */
export function fdaMessage(bundlePath: string): string {
  return (
    'Apple Mail data is protected by macOS. Full Disk Access has to be granted to the small helper app "Mail MCP Helper", not to the MCP client. ' +
    'A Finder window showing it has been opened. The user needs to open System Settings > Privacy & Security > Full Disk Access, ' +
    'drag "Mail MCP Helper" from that Finder window into the list, and switch it on. ' +
    `Alternatively click +, press Cmd-Shift-G and paste \`${bundlePath}\`. ` +
    'If "Mail MCP Helper" is already listed and switched on, the entry is stale: remove it with −, then add it again. ' +
    'Retry afterwards; no restart is needed. In Terminal, `npx -y @redpop/apple-mail-mcp setup` walks through the same steps.'
  )
}

// Texte gehen an das Modell, das den Tool-Aufruf gemacht hat: auf Englisch, mit Klickpfad, wo nur ein Mensch handeln kann.
const MESSAGES: Record<string, string> = {
  FULL_DISK_ACCESS_REQUIRED: fdaMessage('the "Mail MCP Helper.app" bundle in the package'),
  MAIL_DATA_NOT_FOUND:
    'Apple Mail does not appear to be set up on this Mac. The user needs to open the Mail app and add an account, then retry.',
  SCHEMA_UNSUPPORTED:
    'This macOS or Mail version is not supported: the Mail database does not have the expected layout. Ask the user to run `npx -y @redpop/apple-mail-mcp doctor` and include its output in a bug report.',
  DATABASE_BUSY: 'Mail is writing to its database right now. Wait a moment and retry the same request.',
  DATABASE_ERROR:
    'The Mail database reported an unexpected error. Retry once; if it persists, ask the user to run `npx -y @redpop/apple-mail-mcp doctor`.',
  MESSAGE_NOT_FOUND:
    'No such message. Message IDs come from search_messages and become invalid when Mail rebuilds its index; search again to get fresh IDs.',
  MAILBOX_NOT_FOUND: 'No such mailbox, or it is not visible under the current settings. Call list_mailboxes to get valid mailbox IDs.',
  INVALID_CURSOR: 'The cursor belongs to a different search or is no longer valid. Repeat the search without a cursor.',
  INVALID_INPUT: 'The request was rejected as invalid.',
  CONFIG_INVALID:
    'The server configuration is invalid, so no mail was accessed. The user needs to correct the named setting in the MCP server configuration and restart the client.',
  HELPER_MISSING:
    'The Mail MCP Helper app is missing from the installation. Reinstalling the package should restore it.',
  HELPER_CRASHED: 'The Mail helper stopped unexpectedly. Retrying the request will start it again.',
  HELPER_TIMEOUT: 'The Mail helper did not answer in time. Retry the request; a narrower search may be faster.',
  HELPER_VERSION_MISMATCH:
    'The installed Mail helper does not match this server version, which points to a damaged installation. The user should restart the MCP client or reinstall the package.',
  HELPER_SIGNATURE_INVALID:
    'The Mail helper is not signed correctly and was not started. The user should reinstall the package from the official source.',
  HELPER_UNTRUSTED_SIGNATURE:
    'The Mail helper reports that its own signature is not trusted and refused to read mail. The user should reinstall the package from the official source.',
}

const FALLBACK = 'An unexpected error occurred while accessing Apple Mail.'

/** Uebersetzt einen Fehlercode in Klartext fuer den Client. Nie ein Stacktrace. */
export function describeError(code: string, detail?: string): string {
  const base = MESSAGES[code] ?? FALLBACK
  return detail !== undefined && detail.length > 0 ? `${base} (Details: ${detail})` : base
}
