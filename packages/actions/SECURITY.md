# Security

This covers `@redpop/apple-mail-actions-mcp`. The threat model of the read server, including
prompt injection and what a mailbox holds, is in the
[root `SECURITY.md`](../../SECURITY.md) and applies here too.

## What the package can do

One tool, `move_messages`, moves messages between mailboxes of one account. The signed app
"Mail MCP Actions" does the move by asking Mail through Apple Events. It has the Automation
permission for Mail and no Full Disk Access. It has a fixed set of commands (`hello`,
`permission`, `request-permission`, `move`) and no command to list, read or delete mail.
It never sees mail content: it gets a message number, a Message-ID and names, and returns a
status or an error number. It holds no credentials and opens no network connection.

What limits the server:

- **Settings come from the environment, never from tool parameters.** The account list, the
  limit per call and the forbidden targets cannot be widened by the model, so an injected mail
  cannot widen them.
- **Accounts are an allowlist.** An empty `APPLE_MAIL_ACCOUNTS` makes every call fail.
- **Targets exclude trash, junk, drafts, sent and "all mail".** Sources must be visible under
  the policy of the read server's rules.
- **Nothing is deleted or sent.** The worst a move does is put a message in the wrong
  folder; moving it back works with the same tool once the 5-minute lock has ended.
- **The message is checked before the move.** The app finds the message by number and compares
  its Message-ID with the one the server read from the index. It moves only if both agree.
- **No raw scripts.** Account and folder names are never put into script text unchecked.
- **Moves are locked for 5 minutes, one at a time, never retried.**
- **The client asks, in a mode that asks.** `move_messages` is not marked read-only, so a client
  asks before each call. If you set "Always allow" for the tool, that is gone; do not. A mode
  that approves tools on its own removes it too: in Claude Desktop and Cowork, Auto moves without
  asking when its automated check does not flag the action, even for a tool set to "Needs
  approval" (tested 2026-11-11). Use Manual there, and no auto-approving mode in Claude Code.

## Residual risks

### Any local process can run the app

Any program running as your macOS user can start the Actions app and send it `move`
commands directly, as long as the Automation permission exists. The server's policy lives in
Node, not in the app. Such a program could move any message it can identify, in any account
that Mail holds, into any folder, trash included. The damage is limited to moving:
the app cannot read, send, delete or flag mail, and a moved message can be moved back. If your
threat model includes hostile programs under your account, this package does not defend
against them. The permission can be switched off in System Settings > Privacy & Security >
Automation.

Mail's own permission model is the reason for the shape: the grant attaches to the app because
it re-launches itself as its own responsible process. The permission does not go to Claude,
your terminal or Node.

### Any local process can switch the grant off

As with the read helper, a program of your user can build an ad-hoc bundle with the release
bundle id and run it. macOS then turns the grant off. The server is blind until you switch it
on again. Local builds use their own bundle ids. The server starts a bundle with the release id
only if its signature verifies against the project's Developer ID requirement, and starts a Dev
or Ad hoc bundle only when `APPLE_MAIL_ACTIONS_PATH` points at it; it refuses any other bundle id.

### The security-mail check looks at the subject only

Messages that look like security mails are never moved. The check is the same heuristic as in
the read server, applied to the subject only. The message text is not read, and the sender address does not change the result. It does not load the body: the body
check also flags ordinary mail with a word like "code" and would block normal moves, and it
could not judge mail that was never downloaded. So a security mail with a harmless subject
can be moved, to a folder you allow. Moving does not read it or send it anywhere. The check
is a safety net, not a guarantee.

### Status means the local state, not the server

A status describes the local state in Mail, not the server. `moved` says that the index of Mail shows the message in the target and not in the source. Mail
then synchronizes with the server. If that fails, or if Mail creates a copy on the server
(rapid back and forth can), the status does not know. Check in the webmail if it matters.

### Untested providers

Only mailbox.org has been tested. Other IMAP providers run without a refusal and may behave
differently, for example by keeping a copy. Limit `APPLE_MAIL_ACCOUNTS` to accounts you are
willing to try.

## Reporting a vulnerability

Please report security problems privately through GitHub Security Advisories:
<https://github.com/redpop/apple-mail-mcp/security/advisories/new>. Do not open a public issue
for them. Include the macOS version, the output of `doctor` and steps to reproduce. Please do
not attach real mail.
