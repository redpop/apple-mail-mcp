# apple-mail-actions-mcp

An [MCP](https://modelcontextprotocol.io) server with one tool, `move_messages`. It moves
messages to another mailbox of the same account in Apple Mail. It is the companion of
[`@redpop/apple-mail-mcp`](../../README.md), the read-only server. That package stays read-only;
all moving code lives here.

**macOS only.** Status: not published yet. The install commands below apply from the first
release; until then, build it from source.

## What it does

Claude looks at your mailbox with the read server, proposes a folder for some messages, and
you confirm. Then Claude calls `move_messages` with message ids and target mailbox ids. The
package only moves messages. It does not send, draft, delete, flag, create folders, read mail
or move between accounts.

```
"Which of these invoices belong in the Accounting folder? Move the ones you are sure about."
```

The server asks Claude to show the proposal first, with the choices move all, move some,
adjust first or move none. That is a request in the server instructions, not a lock. The lock
is that the tool is not marked read-only, so your client asks before each call.

**Do not choose "Always allow" for this tool.** It turns that confirmation off, and a
malicious mail could then make the model move messages without you seeing it.

## What you need beside it

This package needs the read server beside it. The read server lists mailboxes and finds
messages; this server only takes the ids it returns. Install `@redpop/apple-mail-mcp` first
and give it Full Disk Access as its README describes.

Two settings must match across both servers, because neither server sees the other's
configuration:

- `APPLE_MAIL_ACCOUNTS` is required here. If it is empty, every call fails with
  `CONFIG_INVALID`; moving is never enabled for all accounts. Use the same list in the read
  server.
- Set `APPLE_MAIL_EXCLUDE_MAILBOXES` in both servers. A mailbox hidden in the read server but
  not here would still be a possible target.

Junk and trash are not visible by default, in either server.

## What it moves, and what it refuses

Targets are all visible mailboxes except trash, junk, drafts, sent and "all mail". Sources
must be visible under the same rules, so junk and trash are not sources by default. Further
targets can be forbidden with `APPLE_MAIL_MOVE_EXCLUDE_TARGETS`.

Each message gets one status. `moved` means the index of Mail shows it in the target and no
longer in the source. `moved_unverified` means the move was requested but the index did not
confirm it within 10 seconds. Both describe the local state in Mail, not the mail server.
`failed` and the `skipped_*` statuses say why a message did not move; nothing was changed for
those.

Messages are skipped, never moved, in these cases:

- The message looks like a security mail (verification code, password reset, sign-in link).
  The check looks at the subject only. `APPLE_MAIL_SHOW_SECURITY_MAILS` does not lift it.
- The message was moved in the last 5 minutes. Rapid back and forth can create a copy on the
  mail server, so each moved message is locked for 5 minutes, across processes. Moves you make
  yourself in Mail are not known to the lock.
- The message is visible in several mailboxes and `sourceMailboxId` does not pick one.
- The message has no Message-ID header in Mail's index. On macOS 15 Mail does not store it, so
  the tool cannot move anything there. `doctor` says so.
- The source and target are the same, or in different accounts.
- The account is not supported. Only mailbox.org has been tested. Other IMAP providers are
  untested: they run without a refusal, so limit `APPLE_MAIL_ACCOUNTS` to accounts you
  are willing to try. Gmail, Exchange and local folders are refused.
- A folder name differs from another folder of the account only in case, or contains control
  characters.

Moves run one after another, never in parallel, and are never retried: a failed move may have
arrived halfway.

A folder that never held a message is not in Mail's index, so it does not appear in
`list_mailboxes` and cannot be a target. Put one message in it by hand first.

Only moves between top-level folders have been tested. Subfolders and moves from or to INBOX
are not.

## Requirements

- macOS 15 or later. Verified with a real mailbox only on macOS 27 with Mail 16 and one
  mailbox.org account. On macOS 15 the tool is a no-op because of the missing Message-ID
  header.
- Node.js 22.16 or newer in the 22 line, or 24 and newer.
- The read server `@redpop/apple-mail-mcp` at the same version, with Full Disk Access.
- Mail must be running. The server never starts it; without it the call fails with
  `MAIL_NOT_RUNNING`.

## Install

**Claude Code and Cowork, as a plugin:**

```
/plugin install apple-mail-actions-mcp --marketplace redpop/apple-mail-mcp
npx -y @redpop/apple-mail-actions-mcp setup
```

**Claude Code without the plugin:**

```bash
claude mcp add apple-mail-actions \
  -e APPLE_MAIL_ACCOUNTS=work@example.com \
  -e APPLE_MAIL_EXCLUDE_MAILBOXES=Archive \
  -- npx -y @redpop/apple-mail-actions-mcp
npx -y @redpop/apple-mail-actions-mcp setup
```

**Claude Desktop:** the release will carry an `.mcpb` bundle with the same settings page.

`setup` first runs the setup of the read server (Full Disk Access for its helper), then asks
macOS for the Automation permission of "Mail MCP Actions" to control Mail. Mail must be
running for the dialog to appear. The permission goes to that small app alone, not to Claude,
your terminal or Node. It can be switched off under System Settings > Privacy & Security >
Automation.

## Configuration

Set these in the environment of the server. They cannot be changed through tool parameters.
An invalid value does not stop the server; every call then fails with `CONFIG_INVALID` naming
the setting. The server reads them once, at startup: restart the client after a change.

| Variable | Default | Meaning |
|---|---|---|
| `APPLE_MAIL_ACCOUNTS` | required | Comma-separated allowlist of accounts, by UUID, address or name. Empty is an error, not "all accounts". |
| `APPLE_MAIL_INCLUDE_JUNK` | `false` | Treat mailboxes with the junk role as visible. Same meaning as in the read server. |
| `APPLE_MAIL_INCLUDE_TRASH` | `false` | Treat mailboxes with the trash role as visible. Same meaning as in the read server. |
| `APPLE_MAIL_EXCLUDE_MAILBOXES` | empty | Comma-separated mailboxes to hide, by name or by path with `/`. Set it in both servers. |
| `APPLE_MAIL_MAX_MOVES` | `25` | Upper bound for the number of messages in one call (1 to 100). |
| `APPLE_MAIL_MOVE_EXCLUDE_TARGETS` | empty | Comma-separated mailboxes that are never a target, by name or by path with `/`. |
| `APPLE_MAIL_ACTIONS_PATH` | not set | Development only: path to a Dev or Ad hoc build of the Actions app. A bundle with the release bundle id is refused. |

The settings of the read server that do not appear here, for example body search, do not affect
this package.

## Install from source

You need the Xcode Command Line Tools and an Apple Development certificate for a build that
keeps its permission across rebuilds.

```bash
git clone https://github.com/redpop/apple-mail-mcp.git
cd apple-mail-mcp
npm ci
npm run build && npm run build:helper
npm run build --workspace packages/actions && npm run build:helper --workspace packages/actions
```

Then follow the README of the read server for its helper, and grant Automation with
`node packages/actions/dist/index.js setup`, with `APPLE_MAIL_ACTIONS_PATH` and
`APPLE_MAIL_HELPER_PATH` pointing at the Dev bundles in each `bin/` directory. Never sign
these builds with a Developer ID.

## Diagnostics

```bash
npx -y @redpop/apple-mail-actions-mcp doctor
```

`doctor` runs the checks of the read server, then checks the Actions app and its signature,
the Automation permission, whether Mail is running, whether the Message-ID column exists and
which accounts are supported. Without `--verbose` it names no accounts or addresses. Exit code
1 means at least one check failed.

## Privacy Policy

This policy covers the server and the Actions app, as published on npm and in the GitHub
releases. It adds to the policy of the read server.

### What is collected

Nothing is collected by the author or by any service. The server has no telemetry, and neither
the server nor the app opens a network connection. The app never sees mail content. It receives
a message number, a Message-ID and the names of an account and two mailboxes, and returns a
status.

### How it is used and stored

When your AI client calls `move_messages`, the app asks Mail to move the messages you named. The
server writes one file, `move-locks.json`, under
`~/Library/Application Support/apple-mail-mcp/`, directory 0700, file 0600. It holds the
internal message numbers of recently moved messages and the time their lock ends. No names or
subjects.

### Sharing with third parties

Nothing is shared. Mail itself synchronizes the move with your mail server, as it does for a move
you make by hand. The statuses of a call go back to your AI client.

### Retention

Entries leave the lock file after 5 minutes at the next move. Delete the file at any time. The
server never deletes or changes anything under `~/Library/Mail` itself; the moves are Mail's.

### Contact

Questions about this policy: open an issue at
<https://github.com/redpop/apple-mail-mcp/issues>. Security problems: report them privately as
[`SECURITY.md`](./SECURITY.md#reporting-a-vulnerability) describes.

## License

MIT, see [`LICENSE`](./LICENSE).
