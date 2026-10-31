# apple-mail-mcp

A read-only [MCP](https://modelcontextprotocol.io) server that lets an AI assistant
search and read the mail in Apple Mail.

**macOS only.** It reads the local index that Mail.app keeps on your Mac.

```bash
claude mcp add apple-mail -- npx -y @redpop/apple-mail-mcp
```

> **Not published yet.** The npm package `@redpop/apple-mail-mcp` and the MCPB bundle do not
> exist yet; the command above is what installation will look like. Until then, build from
> source: see [Install from source](#install-from-source).

## What it does

The main use is "find the mail about X":

```
"Find the mail from the landlord about the heating bill"
"What did Anna send me last week with an attachment?"
"Show the whole thread about the contract renewal"
```

Four tools: `list_mailboxes`, `search_messages`, `get_message`, `get_thread`. Search covers
sender, recipient, subject, free text, mailbox, date range, unread, flagged and attachments,
and can also look inside message bodies. Every result carries a `message://` link that opens
the mail in Mail.app. Details: [`docs/tools.md`](./docs/tools.md).

## Why this one

- **Fast.** It queries Mail's SQLite index instead of scripting Mail.app with AppleScript.
  On one real mailbox with about 240,000 message rows, a page of search results takes 4 to
  90 ms in the helper, a subject search 25 ms after the first one; see
  [`docs/architecture.md`](./docs/architecture.md) for the measurements and their limits.
- **Full Disk Access goes to a small helper, not to your terminal or your AI client.** The
  server reaches Mail's files through a small app, "Mail MCP Helper", and macOS binds the
  permission to that app alone. Node, Terminal and Claude never get it.
- **Read-only by construction, not by a flag.** There is no code that sends, drafts, moves,
  deletes or flags mail, none that opens the database for writing, and none that opens a
  network connection.
- **Mail.app does not have to be running** and no Automation prompt appears. Your data is
  only as fresh as Mail's last sync, though, and a message that Mail never downloaded has no
  body.
- **Threads and deep links.** `get_thread` returns a conversation; every message has a
  `message://` link.
- **Security mails are withheld by default.** Messages that look like verification codes,
  password resets or sign-in links are shown without their body, with digits in the subject
  masked, and cannot be found by body search. Detection is best effort, not a guarantee.
- **Settings come from configuration, never from tool parameters**, so a malicious mail cannot
  ask the model to switch them off.
- **Works with [apple-calendar-mcp](https://github.com/redpop/apple-calendar-mcp)**: "find the
  mail about Thursday's meeting". Same conventions: timestamps in ISO 8601 with offset, and
  errors as an `isError` result with one plain-English sentence per error code.

## Requirements

- macOS 14 or later. Verified only on macOS 27.0.1 with Mail 16.0. The helper is built for
  macOS 14 and later, but no Mail database from macOS 14 to 26 has been checked yet. Support
  depends on the layout of Mail's database, not on the version number: `doctor` checks it.
  Reports from other versions are welcome, see [Reporting problems](#reporting-problems).
- Node.js 22 or newer.
- Mail set up with at least one account.
- Exchange accounts are untested. Mailboxes and message metadata are listed, but bodies of
  Exchange mail are not read yet: `get_message` reports `file_not_found`. See
  [`docs/exchange.md`](./docs/exchange.md).

## Security model in short

A mailbox holds secrets: codes, reset links, contracts. Read this before connecting it to a
model that can also reach the internet.

- The helper holds Full Disk Access and runs only fixed commands. It has no free-form SQL and no
  path parameter, and it never parses mail content. Untrusted MIME is parsed in Node, which has
  no special permission.
- Mail text is untrusted input. The server tells the model so, but cannot force it.
- If your client also has a web or send tool, a malicious mail could try to make the model
  leak what it read. Use confirmations for those tools, or keep this server in a client without
  them.
- Any program running as your user can start the helper and read your mail with it. This is
  less than giving Full Disk Access to Terminal, but it is not nothing.

The full threat model and both residual risks: [`SECURITY.md`](./SECURITY.md).

## Install from source

This is the path that works today. You need the Xcode Command Line Tools (for Swift) and an
Apple Development certificate in your keychain for a build that keeps its permission across
rebuilds; without one the build is ad hoc and gets its own, weaker identity.

```bash
git clone https://github.com/redpop/apple-mail-mcp.git
cd apple-mail-mcp
npm ci
npm run build           # TypeScript -> dist/
npm run build:helper    # Swift helper -> bin/Mail MCP Helper (Dev).app
```

Then give the helper Full Disk Access (next section) and register the server:

```bash
claude mcp add apple-mail \
  -e APPLE_MAIL_HELPER_PATH="$PWD/bin/Mail MCP Helper (Dev).app" \
  -- node "$PWD/dist/index.js"
```

`APPLE_MAIL_HELPER_PATH` points the server at your local build. Without it the server looks
for the release bundle `Mail MCP Helper.app` inside the package, which only the release
pipeline produces. A local build is named "Mail MCP Helper (Dev)" (Apple Development
signature) or "Mail MCP Helper (Ad hoc)" (no certificate). Both use their own bundle id, so
they never disturb the permission of the release app.

The build script never signs with a Developer ID certificate outside CI.

## Install with npx or MCPB (coming soon)

Once published:

```bash
claude mcp add apple-mail -- npx -y @redpop/apple-mail-mcp
```

For Claude Desktop a one-click MCPB bundle is planned. Settings will then be available in the
extension's settings page instead of environment variables.

## Grant Full Disk Access

macOS protects `~/Library/Mail` and offers no dialog to ask for access. You grant it once, to
the helper app:

1. Run `setup` (from source: `APPLE_MAIL_HELPER_PATH="$PWD/bin/Mail MCP Helper (Dev).app" node dist/index.js setup`;
   after publication: `npx -y @redpop/apple-mail-mcp setup`). It opens System Settings at
   Privacy & Security > Full Disk Access, shows the helper in Finder, and waits until access
   works.
2. Drag **Mail MCP Helper** from the Finder window into the list and switch it on. (For a local
   build the name is "Mail MCP Helper (Dev)".) Alternatively click +, press Cmd-Shift-G and
   paste the path that `setup` prints.
3. `setup` reports success and prints the command to add the server to Claude Code.

Without a terminal (for example with the MCPB bundle) the first tool call that is denied opens
System Settings and the Finder window by itself, once per server process, and the error message
lists the same steps.

Notes:

- The permission belongs to the app's bundle id, not to its location. You can move the package
  or update it without granting again.
- If "Mail MCP Helper" is listed and switched on but access is still denied, the entry is
  stale. Remove it with the minus button and add it again.
- No restart is needed after granting.

More cases: [`docs/troubleshooting.md`](./docs/troubleshooting.md).

## Configuration

Set these in the environment of the server, for example with `claude mcp add -e NAME=value`.
They cannot be changed through tool parameters. Booleans accept `true`, `false`, `1`, `0`.
An empty value counts as not set. An invalid value does not stop the server; every tool call
then fails with `CONFIG_INVALID` naming the setting, and nothing falls back to "allow all".

| Variable | Default | Meaning |
|---|---|---|
| `APPLE_MAIL_ACCOUNTS` | empty (all accounts) | Comma-separated allowlist. An entry matches an account's UUID, address or name, ignoring case. A name shared by two accounts matches both; use the address or UUID to pick one. |
| `APPLE_MAIL_INCLUDE_JUNK` | `false` | Include mailboxes with the junk role. |
| `APPLE_MAIL_INCLUDE_TRASH` | `false` | Include mailboxes with the trash role. |
| `APPLE_MAIL_EXCLUDE_MAILBOXES` | empty | Comma-separated mailboxes to hide. An entry matches a mailbox name (exact, ignoring case) or a path with `/`. |
| `APPLE_MAIL_SHOW_SECURITY_MAILS` | `false` | Show messages detected as security mails without withholding the body or masking the subject. |
| `APPLE_MAIL_BODY_SEARCH` | `true` | Allow `bodyContains` in `search_messages`. When `false`, using it is an `INVALID_INPUT` error. |
| `APPLE_MAIL_MAX_RESULTS` | `50` | Upper bound for the `limit` of a search (1 to 100). |
| `APPLE_MAIL_MAX_BODY_CHARS` | `20000` | Upper bound for `maxChars` in `get_message` (1000 to 100000). |
| `APPLE_MAIL_HELPER_PATH` | not set | Development only: path to a helper bundle (Dev or Ad hoc). A bundle with the release bundle id is refused. |
| `APPLE_MAIL_MCP_DEBUG` | `false` | Write one line per helper request to stderr: command, duration and result code, for example `apple-mail-mcp: search 42 ms ok`. Never payloads or results. |

Example: only the work account, no mailbox called Archive.

```bash
claude mcp add apple-mail \
  -e APPLE_MAIL_ACCOUNTS=work@example.com \
  -e APPLE_MAIL_EXCLUDE_MAILBOXES=Archive \
  -- npx -y @redpop/apple-mail-mcp
```

## Tools

| Tool | What it does |
|---|---|
| `list_mailboxes` | Accounts and visible mailboxes with total and unread counts and a role (inbox, sent, junk, ...). |
| `search_messages` | Newest-first search by sender, recipient, subject, free text, mailbox, dates, unread, flagged, attachment, and optionally body text. Paginated with a cursor. |
| `get_message` | One message: headers, attachment names, body as plain text, optional removal of quoted replies. |
| `get_thread` | The messages of one conversation, oldest first, without bodies. |

All four are marked read-only. Parameters, results and error codes: [`docs/tools.md`](./docs/tools.md).

## Diagnostics and bug reports

```bash
npx -y @redpop/apple-mail-mcp doctor        # from source: node dist/index.js doctor
```

`doctor` checks the macOS version, the helper's signature, Full Disk Access, the database
layout, how many messages have a local file, the mailbox roles and the effective settings. Its
default output contains no names, addresses or subjects, so you can paste it into an issue as
it is. `--verbose` adds mailbox names and account identifiers; `--json` is for machines;
`--schema` prints only the database fingerprint, any missing columns and the `CREATE TABLE`
statements of Mail's database (structure, no data). Exit code 1 means at
least one check failed.

## Reporting problems

Open an issue at <https://github.com/redpop/apple-mail-mcp/issues> and attach the output of
`doctor`. If you run it on a macOS version other than 27, open a
[Schema report](https://github.com/redpop/apple-mail-mcp/issues/new?template=schema-report.yml)
with the output of `doctor --schema` instead: that is the most useful report we can get. Security problems go through GitHub Security Advisories, see
[`SECURITY.md`](./SECURITY.md).

## More documentation

- [`docs/tools.md`](./docs/tools.md): every tool, its parameters, results and errors
- [`docs/architecture.md`](./docs/architecture.md): how it works and what was measured
- [`docs/troubleshooting.md`](./docs/troubleshooting.md): permission and database problems
- [`docs/exchange.md`](./docs/exchange.md): what is known about Exchange accounts
- [`SECURITY.md`](./SECURITY.md): threat model and residual risks

## Not included, on purpose

Sending, replying, drafts, moving, deleting, flagging, attachment contents, semantic search,
link extraction. A read-only server is easier to trust.

## License

MIT, see [`LICENSE`](./LICENSE).
