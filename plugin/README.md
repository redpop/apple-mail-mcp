# Apple Mail MCP

Lets Claude search and read the mail in Apple Mail on your Mac. It can only read: there is no
code that sends, drafts, moves, deletes or flags mail. macOS only.

Not affiliated with or endorsed by Apple.

## What it runs

The plugin starts one local MCP server, the npm package
[`@redpop/apple-mail-mcp`](https://www.npmjs.com/package/@redpop/apple-mail-mcp), pinned to the
plugin's version and started with `npx`. The package contains a small helper app, "Mail MCP
Helper", signed with a Developer ID and notarized by Apple. The helper reads Mail's local
database and message files; the server parses them and answers four tools: `list_mailboxes`,
`search_messages`, `get_message` and `get_thread`.

It needs Node.js 22.16 or newer (or 24 and newer) and runs in Claude Code and in Cowork on your
Mac. The Claude desktop chat does not start local servers from plugins; use the `.mcpb` bundle
from the [GitHub releases](https://github.com/redpop/apple-mail-mcp/releases) there.

## Set it up

Install the plugin in Claude Code:

```
/plugin install apple-mail-mcp --marketplace redpop/apple-mail-mcp
```

Mail's files are protected by macOS. Grant Full Disk Access to the helper once:

```bash
npx -y @redpop/apple-mail-mcp setup
```

The permission goes to the helper alone, not to Claude, your terminal or Node.

## Settings

When you enable the plugin, Claude Code asks for its settings: which accounts to include,
whether junk and trash are visible, excluded mailboxes, security mails, body search, the
optional body index and result limits. The model cannot change them. Details are in the
[configuration section](https://github.com/redpop/apple-mail-mcp#configuration).

## Data

Nothing leaves your Mac through this plugin: it has no telemetry and opens no network
connection. Tool results go to Claude, like any other tool result. The optional body index keeps
a plain-text copy of your mail bodies on disk; it is off by default. Read the
[privacy policy](https://github.com/redpop/apple-mail-mcp#privacy-policy) and
[`SECURITY.md`](https://github.com/redpop/apple-mail-mcp/blob/main/SECURITY.md) before you
use it.

## License

MIT
