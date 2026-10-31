# Troubleshooting

Start with `doctor`. Its default output holds no names, addresses or subjects:

```bash
npx -y @redpop/apple-mail-mcp doctor
# from source:
APPLE_MAIL_HELPER_PATH="$PWD/bin/Mail MCP Helper (Dev).app" node dist/index.js doctor
```

Each line is `ok`, `warn` or `fail`. Exit code 1 means at least one `fail`. `--verbose` adds
mailbox names and account identifiers, `--json` gives machine output, `--schema` prints only the
database fingerprint and missing columns.

## Full Disk Access denied (`FULL_DISK_ACCESS_REQUIRED`)

macOS has not given the helper access to `~/Library/Mail`. The grant goes to the helper app, not
to your terminal or client.

1. Run `setup`. It opens System Settings > Privacy & Security > Full Disk Access and shows the
   helper in Finder. Without a terminal, the first denied tool call does the same, once per
   server process.
2. Drag **Mail MCP Helper** (for a local build: "Mail MCP Helper (Dev)") from Finder into the
   list and switch it on. Or click +, press Cmd-Shift-G and paste the path.
3. Retry. No restart is needed.

Make sure it is the helper that you add, and not Terminal, Claude or Node. Adding those works
for nothing here and widens access for no reason.

## The entry is there and on, but access is still denied (stale entry)

The most likely cause is an entry that macOS no longer matches to the running helper. `doctor`
then reports "Access worked on <date>. Since then macOS denies it." Fix:

1. Open System Settings > Privacy & Security > Full Disk Access.
2. Select every "Mail MCP Helper" entry (and duplicates) and remove it with the minus button.
3. Run `setup` again, or drag the helper in again.

Updating the package does not cause this: a new build with the same identity keeps the grant.
Common causes are another build with the same bundle id (a bundle signed ad hoc with the
release id switches the grant off) or manual changes in the list. If you build from source and
sometimes build without a certificate, you get the "Ad hoc" variant with its own id; that one
never touches the release entry but needs its own grant.

## The Mail database cannot be read or is busy

- `DATABASE_BUSY`: Mail is writing, often while syncing a large account. Wait and retry.
- `DATABASE_ERROR`, or `doctor` says "Mail database could not be read (busy or damaged)": quit
  and reopen Mail, wait for sync to finish, retry. If it persists, run `doctor --verbose` and
  open an issue.
- The server never writes to the database, and never opens it with `immutable`, so it cannot
  corrupt it.

## Helper signature invalid (`HELPER_SIGNATURE_INVALID`)

The server verifies a release-signed helper before starting it and refuses if the check fails.
Reinstall the package from the official source. If you set `APPLE_MAIL_HELPER_PATH`, point it
at a local Dev or Ad hoc build; a bundle with the release id is refused as an override.
`HELPER_UNTRUSTED_SIGNATURE` is the same problem seen from the helper's side. `doctor` shows
the bundle id, authority and team.

The server checks the signature once, before the helper's first start, and keeps the result for
as long as the server process runs. After a failed check every tool call returns
`HELPER_SIGNATURE_INVALID`, even once the bundle has been fixed or reinstalled. Restart the MCP
client so it starts a new server process, which checks again.

If `HELPER_MISSING` appears when running from source, the server looks for the release bundle
inside the package. Build the helper and set `APPLE_MAIL_HELPER_PATH`.

## Mail is not set up (`MAIL_DATA_NOT_FOUND`)

There is no `~/Library/Mail/V<n>` directory. Open Mail, add an account and let it sync.

## Schema unsupported (`SCHEMA_UNSUPPORTED`)

The helper checks the columns it needs instead of a version number. This error means the
database on this macOS or Mail version looks different. Run:

```bash
npx -y @redpop/apple-mail-mcp doctor --schema
```

and attach the output to an issue, together with the macOS version. It lists the fingerprint and
the missing columns and no mail data.

## Other symptoms

**Searches return nothing, or messages are missing.**
The data is only as fresh as Mail's last sync. Also check the settings: junk and trash are
excluded unless `APPLE_MAIL_INCLUDE_JUNK` / `APPLE_MAIL_INCLUDE_TRASH` are `true`, and
`APPLE_MAIL_ACCOUNTS` and `APPLE_MAIL_EXCLUDE_MAILBOXES` hide accounts and mailboxes. `doctor`
shows the effective policy and mailbox counts. `list_mailboxes` shows what the model can see.

**A message has no body.**
`bodyUnavailableReason` tells why: `not_downloaded` (Mail never fetched it; open it in Mail),
`file_not_found`, `withheld_security` (looks like a verification or reset mail; see
`APPLE_MAIL_SHOW_SECURITY_MAILS`), or `parse_failed`.

**`CONFIG_INVALID`.**
A setting has a bad value. The message names it. Booleans accept `true`, `false`, `1`, `0`;
numbers must be inside their range. Fix it in the server configuration and restart the client.

**`MESSAGE_NOT_FOUND` for an id that worked before.**
Mail rebuilt its index, which renumbers messages. Search again.

**`HELPER_TIMEOUT`.**
The first call after a start takes longer (process start and database open). Retry. For body
search, narrow the filters.

**A body search ends with a note about scanning.**
This is by design: it examines a bounded number of messages. Continue with `nextCursor` or
narrow the search.

## Reporting

Open an issue with the `doctor` output and your macOS version. Do not attach mail content.
