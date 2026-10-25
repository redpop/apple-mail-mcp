# Architecture

## Two parts

```
MCP client (Claude Desktop, Claude Code, ...)
   |  stdio, MCP protocol
   v
Node / TypeScript MCP server
   |  policy, MIME parsing, HTML to text, quote stripping,
   |  security-mail detection, body scan, cursors
   |  NDJSON over stdin/stdout, one long-lived child
   v
Swift helper "mail-helper serve"  (inside "Mail MCP Helper.app")
   |  SQLite read-only, file reads
   v
~/Library/Mail/V<n>/MailData/Envelope Index   and   .../*.emlx
```

| Task | Where | Why |
|---|---|---|
| Open SQLite, fixed parameterised queries, dedupe, keyset paging | Swift | needs Full Disk Access |
| Derive `.emlx` path, check it stays under `~/Library/Mail`, read bytes up to a limit | Swift | needs Full Disk Access |
| Strip the `.emlx` frame, parse MIME, decode charsets, HTML to text | Node | untrusted input, parser without special rights |
| Mailbox role from the mailbox URL | Node | pure function |
| Policy: compute allowed mailboxes | Node | configuration lives there |
| Security-mail detection, subject masking | Node | needs the parsed body |
| Body scan (`bodyContains`) | Node | needs MIME decoding |
| Encode and verify cursors | Node | part of the tool contract |

The helper never interprets mail content. A bug in the MIME parser therefore affects a process
that holds no permissions.

## Permission model

Reading `~/Library/Mail` needs Full Disk Access (FDA), and macOS offers no dialog for it. The
user must add the program by hand in System Settings. Two problems follow:

1. FDA is attributed to the **responsible process**. A tool started by Claude Desktop is
   attributed to Claude, so granting FDA would give Claude (or the terminal) access to all
   protected data.
2. A grant for a bare binary hangs on its path, and rebuilding it with a new hash at that path
   switches the grant off and adds a duplicate entry.

The design answers both:

- The helper **disclaims responsibility** by re-executing itself with
  `responsibility_spawnattrs_setdisclaim` (a private libSystem call, resolved with `dlsym` so a
  macOS that drops it degrades instead of failing to load). Afterwards the helper is its own
  responsible process, and the grant belongs to it alone.
- The helper is an **`.app` bundle**. For a bundle, the grant is bound to the bundle id and the
  designated requirement (the signing identity), not to the path. The bundle has its own icon
  and name, so the Full Disk Access list shows "Mail MCP Helper" and not a generic entry.

### Bundle spike results (macOS 27.0.1)

| Test | Result |
|---|---|
| Bundle before grant | denied |
| Same bundle after grant | granted |
| Bundle moved to another path | granted |
| Byte-identical copy at another path, original kept | granted |
| New build (new hash, same identity) replaces the old by rename | granted, no second entry |
| Bundle installed at a new path | granted |
| Ad-hoc bundle with the **same bundle id** at any path | denied, and the user's entry is switched off |
| Real bundle afterwards | denied until the user switches the entry on again |

The grant is recorded under the bundle id with client type 0 (bundle id). The same test with a
bare binary gave a path-bound grant and a duplicate entry after an ad-hoc rebuild.

Not tested: a validly signed build with the same bundle id but a different identity (Apple
Development versus Developer ID). The rule that covers it is the same: no non-release build
ever uses the release bundle id.

### Three bundle ids

| Build | Signature | Bundle id | Name in the list |
|---|---|---|---|
| Release (CI only) | Developer ID | `io.github.redpop.apple-mail-mcp.mail-helper` | Mail MCP Helper |
| Development | Apple Development | `...mail-helper.dev` | Mail MCP Helper (Dev) |
| Ad hoc | ad hoc | `...mail-helper.adhoc` | Mail MCP Helper (Ad hoc) |

`swift/build.sh` picks the id from the signing identity and refuses anything else, including
the release id outside CI. A dev build gets its own one-time grant that survives Apple
Development rebuilds wherever it is built.

Three checks protect the release grant:

1. `build.sh` produces the release id only with `CI=true`.
2. Before the first start, Node verifies a release-id bundle with `codesign` against a
   requirement (release identifier, Apple anchor, Developer ID intermediate, the project's team
   id). Otherwise `HELPER_SIGNATURE_INVALID`. An override path (`APPLE_MAIL_HELPER_PATH`) must
   not carry the release id.
3. The helper checks its own signature against its bundle id before it opens anything under
   `~/Library/Mail` or `~/Library/Accounts`. On failure it answers read commands with
   `HELPER_UNTRUSTED_SIGNATURE` and touches no file.

Whether macOS switches a grant off at `exec` or at first file access is not measured. Check 2
helps in the second case; only check 1 covers the first. See [`SECURITY.md`](../SECURITY.md) for
what remains.

## Process model

- Node starts the helper lazily on the first tool call, directly from the bundle
  (`Contents/MacOS/mail-helper`), with no install or copy step.
- Requests are queued first in, first out; each carries an id that the helper mirrors.
- The handshake (`hello`) and the first real request after it get a longer deadline (15 s)
  than later ones (10 s): the handshake covers process start and the disclaim re-exec, the first
  real request the database open. Two timeouts in a row on real requests restart it, also before it
  has answered one.
- If the helper crashes, the next request restarts it. End of input on stdin ends the helper;
  SIGINT and SIGTERM stop it before the server exits.
- **stdout carries protocol only, on both legs.** Logs go to stderr.
- The state file `~/Library/Application Support/apple-mail-mcp/state.json` (mode 0600) records
  when access last worked and which helper version was used (from the handshake). The hash field
  stays empty: the grant follows bundle id and signature, not the file hash, so a hash would not
  help the diagnosis. It contains no mail
  data. `doctor` uses it to recognise a stale Full Disk Access entry: the TCC database is
  itself protected, so a helper without access cannot look up whether it is listed.

## Data access

### Finding the data

The helper looks for `~/Library/Mail/V<n>/MailData/Envelope Index` and opens it with
`SQLITE_OPEN_READONLY` and a busy timeout, never `immutable` (that returns stale data while
Mail writes the WAL). `PRAGMA user_version` is 0, so compatibility comes from column
introspection: if every column the queries need exists, it runs. `doctor --schema` prints the
database fingerprint and any missing columns.

### Deduplication

The table `messages` holds about twice as many rows as there are distinct mails, because a mail
can sit in several mailboxes. Identity is `global_message_id`, exposed as `id`.

- Grouping happens in SQL, before sorting and paging, so pages are full and cursors are
  stable. The cursor is a keyset over the grouped result: date of the newest copy, then id.
- A mail counts as unread or flagged if any copy is; its mailboxes are all allowed mailboxes
  that hold a copy.
- For the body, the best copy wins: a complete file before `.partial` before none.
- `id` stays valid until Mail rebuilds its index. After that, an old id answers
  `MESSAGE_NOT_FOUND`.

### Text search

Search terms are substring matches, case-insensitive including umlauts. SQLite's `LIKE` only
folds ASCII, so the helper registers a function that applies Unicode case folding. Folding is
accent-sensitive: "a with umlaut" does not match plain "a". Wildcard characters typed by the
user have no special meaning.

To keep this fast, search is **dictionary-first**: subject and address text lives in lookup
tables with far fewer rows than `messages`. The helper folds and matches each distinct string
once, then selects messages by the matching ids.

Folding is the expensive part (about 240 ms for one pass over a real store's 76,000 subjects), so
the helper folds each dictionary row only once per connection. On the first search with a text
filter it copies the folded text into two TEMP tables, `temp.fold_subjects(id, f)` and
`temp.fold_addresses(id, a, c)`; before each later text search it appends only rows whose ROWID is
above the highest one already folded. Text filters then run `instr(f, ?) > 0` on these tables.

This writes nothing to Mail's files. The connection stays `SQLITE_OPEN_READONLY`; TEMP tables
belong to the connection, not to the database file, and `PRAGMA temp_store = MEMORY` keeps them in
the helper's memory (a few MB on a large store). A read-only connection may create and fill TEMP
tables (checked with SQLite 3.54); `ATTACH ':memory:'` inherits the read-only flag and fails, which
is why TEMP is used. Both dictionaries are `AUTOINCREMENT` and append-mostly: ROWIDs are not
reused, and rows that disappear are harmless because matches only take effect through `messages`
and `recipients`. A text changed in place under the same ROWID would only be refolded after the
connection reopens, which happens when Mail recreates the index file (new inode).

`totalMatched` comes from the same statement as the page, as `count(*) OVER ()` over the grouped
candidates, and only on the first page; later pages omit it. It is exact, without the former cap
at 10,000, so `totalMatchedCapped` is always `false`. `hasAttachment` is a prefilter on the set of
messages with an attachment instead of an `EXISTS` per row.

Timings from a reviewer's synthetic store of 238,000 message rows, run in Python as an upper
bound for the Swift code:

| Filter | Time |
|---|---|
| subject | about 100 ms |
| to | about 25 ms |
| query (subject, sender, recipients) | about 50 ms |

These are not benchmarks of the finished helper. They came from synthetic data and a different
language. The Swift search was not timed against a real mailbox when this was written; the
manual run with the dev build adds that measurement. To time it, start the server with
`APPLE_MAIL_MCP_DEBUG=true`: every helper request then writes one line to stderr with the
command, its duration including the pipe round trip, and the result code, for example
`apple-mail-mcp: search 42 ms ok`. A `search_messages` page is one `search` line (plus
`get-messages` lines when `bodyContains` scans bodies); the first request after a start also pays
for opening the database.

Separately measured on a real mailbox during the spike: `LIKE` over all subjects 42 ms and over
sender addresses 27 ms with `sqlite3` including process start; `count(*)` through the helper 2
to 6 ms including the re-exec. Treat all of these as orders of magnitude.

### Reading a body

The `.emlx` file name equals `messages.ROWID`. The path is
`V<n>/<account>/<mailbox>.mbox[/<sub>.mbox]/<store-uuid>/Data/<digits of ROWID/1000, reversed>/Messages/<ROWID>[.partial].emlx`.
The store uuid cannot be derived from the mailbox URL, so the helper scans once and caches.
Files with `.partial` contain the text parts and lack only attachments. In the spike mailbox
about 1.6 % of distinct mails had no local file at all.

The helper returns raw bytes with a size limit. Node removes the length frame (first line is the
byte length of the message, the rest is a property list that is dropped), parses with
`postal-mime`, prefers `text/plain`, and converts HTML with `html-to-text` otherwise. Failure to
parse is reported as `parse_failed`, never as an empty body.

### Body scan budget

`bodyContains` cannot use an index; it decodes messages. It is bounded:

- candidates come newest first in pages of 200 from the other filters;
- messages are fetched in blocks of 50, at most 256 KiB per message and 16 MiB per request;
- it stops at the requested number of matches, after 2,000 candidates, or after 3 seconds,
  whichever comes first;
- the result says which, in `scan` and in a plain-text `note`, and `nextCursor` continues
  after the last **examined** candidate (not the last match);
- security mails are skipped, so they cannot be found by content.

A raw grep over 2,000 random files took 2.5 s in the spike, and a scan of the whole mailbox
takes minutes, which is why the scan is bounded. An opt-in full-text index is a possible later
addition; it is not built.

### Policy enforcement

Node computes the set of allowed mailbox ids from configuration (account allowlist, junk and
trash roles, excluded mailboxes) and sends it with every read command. The helper rejects a
missing or empty set and adds `mailbox IN (...)` to each query, before `LIMIT`. Consequences:
pages are full; a mail that exists only in excluded mailboxes is `MESSAGE_NOT_FOUND`; a mail
with copies in both shows only the allowed ones. Against another local process that starts the
helper itself this does nothing, see [`SECURITY.md`](../SECURITY.md).

A hash of the effective configuration (the policy fingerprint) is part of every cursor, so a
cursor from before a settings change is rejected with `INVALID_CURSOR`.

## What was measured and what is assumed

Measured on macOS 27.0.1, Mail 16.0, arm64, one real mailbox (spike, 2026-10-25):

- the read-only open works while Mail writes; `immutable` returns stale data;
- the bundle-id binding of the grant, in the table above;
- duplication of rows, the `.emlx` naming and path scheme, and the share of partial and missing
  files;
- the column semantics used (`recipients.type`, `addresses.comment` as display name, Unix-second
  dates), checked against parsed headers;
- Spotlight finds no mail items, so it is not an option for body search.

Assumed, not measured:

- macOS 14 through 26: the minimum deployment target is 14 and compatibility is decided by the
  column check, but no schema from those versions was inspected;
- Exchange accounts: not in the spike mailbox;
- whether macOS turns a grant off at `exec` or at first file access for an unexpected
  ad-hoc build with the release id;
- search timings with the Swift implementation on a mailbox of that size, beyond the upper bound
  above.
