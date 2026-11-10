# Apple Mail Actions MCP

Lets Claude move messages between mailboxes in Apple Mail on your Mac, after you confirm. It
only moves: it does not send, draft, delete, flag or read mail. macOS only.

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
MCP Actions". Release builds will be signed with a Developer ID and notarized by Apple in CI;
that has not been exercised for this app yet. It asks Mail to do the move and
holds the Automation permission for Mail, not Claude.

The package is not published yet, so this plugin does not start until the first release. The
pin follows a new npm release after seven days, so an npm release cooldown of up to seven days
does not block it.

It needs Node.js 22.16 or newer (or 24 and newer). Mail must be running when a move is made.
It runs in Claude Code. The read plugin did not start in Cowork in a test on 2026-11-10, for a
reason not yet known; use the `.mcpb` bundle from the GitHub releases there.

## Set it up


```
/plugin install apple-mail-actions-mcp --marketplace redpop/apple-mail-mcp
```

Then grant the Automation permission once, with Mail running:

```bash
npx -y @redpop/apple-mail-actions-mcp setup
```

## Do not choose "Always allow"

Your client asks before each move. If you choose "Always allow" for the tool, a malicious mail
could make the model move messages without you seeing it.

## Settings

When you enable the plugin, Claude Code asks for accounts, excluded mailboxes, junk and trash
visibility, the number of moves per call and forbidden target mailboxes. The model cannot change
them. Details and limits, including which accounts are supported, are in the
[README of the package](https://github.com/redpop/apple-mail-mcp/blob/main/packages/actions/README.md).
Only mailbox.org has been tested; Gmail, Exchange and local folders are refused.

## Data

Nothing leaves your Mac through this plugin: it has no telemetry and opens no network
connection. It stores a small lock file with internal message numbers for 5 minutes after a
move. Read the
[privacy policy](https://github.com/redpop/apple-mail-mcp/blob/main/packages/actions/README.md#privacy-policy)
and the
[security notes](https://github.com/redpop/apple-mail-mcp/blob/main/packages/actions/SECURITY.md).

## License

MIT
