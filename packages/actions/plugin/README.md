# Apple Mail Actions MCP

Lets Claude move messages between mailboxes in Apple Mail on your Mac, after you confirm. It
moves messages and, when enabled, saves attachments: it does not send, draft, delete, flag or
read mail. macOS only.

Not affiliated with or endorsed by Apple.

## What it needs

This plugin needs the Apple Mail MCP plugin (`apple-mail-mcp`) beside it. That plugin finds
messages and lists mailboxes; this one takes the ids it returns. Install and set up that one
first, including its Full Disk Access.

Set the same accounts and excluded mailboxes in both plugins. The accounts setting is required
here: an empty list makes every call fail.

## What it runs

The plugin starts one local MCP server, the npm package
[`@redpop/apple-mail-actions-mcp`](https://www.npmjs.com/package/@redpop/apple-mail-actions-mcp),
pinned to the plugin's version and started with `npx`. The package contains a small app, "Mail
MCP Actions", signed with a Developer ID and notarized by Apple. It asks Mail to do the move
and holds the Automation permission for Mail, not Claude.

The package was first released as 0.3.2 on 2026-11-12. The pin follows a new npm release after
seven days, so an npm release cooldown of up to seven days does not block it; until the pin
reaches 0.3.2, this plugin does not start.

It needs Node.js 22.16 or newer (or 24 and newer). Mail must be running when a move is made.
It runs in Claude Code. Cowork starts a plugin's local server inside its Linux virtual
machine, away from Mail, and the desktop chat ignores such servers; use the `.mcpb` bundle
from the GitHub releases there.

## Set it up


```
/plugin install apple-mail-actions-mcp --marketplace redpop/apple-mail-mcp
```

Then grant the Automation permission once, with Mail running:

```bash
npx -y @redpop/apple-mail-actions-mcp setup
```

## Saving attachments

The package also has an optional tool, `save_attachment`. It is off unless you switch on "Save
attachments" in the plugin settings (`APPLE_MAIL_SAVE_ATTACHMENTS`). Then Mail saves one
attachment into a handover folder and Claude gets the file path. The
[README of the package](https://github.com/redpop/apple-mail-mcp/blob/main/packages/actions/README.md#saving-attachments)
has the folder, size and type settings, and the limits.

## Do not choose "Always allow"

Your client asks before each move, in a mode that asks. If you choose "Always allow" for the
tool, a malicious mail could make the model move messages without you seeing it. Modes that
approve tools on their own, such as auto mode or skipping permissions, have the same effect.

## Settings

When you enable the plugin, Claude Code asks for accounts, excluded mailboxes, junk and trash
visibility, the number of moves per call, forbidden target mailboxes and the attachment settings. The model cannot change
them. Details and limits, including which accounts are supported, are in the
[README of the package](https://github.com/redpop/apple-mail-mcp/blob/main/packages/actions/README.md).
Only mailbox.org has been tested; Gmail, Exchange and local folders are refused for moving.

## Data

Nothing leaves your Mac through this plugin: it has no telemetry and opens no network
connection. It stores a small lock file with internal message numbers for 5 minutes after a
move. Read the
[privacy policy](https://github.com/redpop/apple-mail-mcp/blob/main/packages/actions/README.md#privacy-policy)
and the
[security notes](https://github.com/redpop/apple-mail-mcp/blob/main/packages/actions/SECURITY.md).

## License

MIT
