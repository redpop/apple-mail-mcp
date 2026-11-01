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

### Release candidate results (macOS 27.0.1, 2026-10-31)

The first two release candidates, built, signed with Developer ID and notarized in CI, on the
maintainer's Mac:

| Test | Result |
|---|---|
| `rc.1` from the npm tarball, `setup` | first grant, access works |
| `rc.1` `.mcpb` in Claude Desktop, unpacked at another path | installs and starts the helper |
| `rc.2` `.mcpb` over `rc.1` (new build, different CDHash) | granted without a new grant, one entry in the list |
| `rc.2` from the npm tarball, in the npx cache at a third path | granted, `doctor` all `ok` |

This is the spike's result for real release builds: the grant follows bundle id and Developer
ID requirement across builds, paths and both install channels.

Claude Desktop starts the server once and keeps it running. Saving the extension's settings, or
switching the extension off and on, did not restart it; only quitting and reopening the app
applied new settings. A `user_config` field with neither a value nor a `default` reaches the
server as the literal `${user_config.<name>}`, so every field in `manifest.json` has a default
and the server rejects such a placeholder as `CONFIG_INVALID`.

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
   `~/Library/Mail` or `~/Library/Accounts`: a release id against the release requirement, a dev
   id against its identifier, the Apple Development intermediate and the team id. On failure it
   answers read commands with
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
- At runtime Node parses helper responses with non-strict zod schemas (`src/schemas.ts`): a missing
  or mistyped field is a contract break, an unknown extra field is dropped silently. A field Swift
  sends that Node does not declare is caught at test time instead: the golden files in
  `tests/fixtures/contract/` hold one response per helper command, produced by the Swift tests, and
  `tests/contract.test.ts` parses them with strict variants of the same schemas.
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

### Account names

A mailbox URL carries only the account UUID (`imap://<uuid>/INBOX`). The helper reads names
from `~/Library/Accounts/Accounts4.sqlite`, opened read-only for one fixed query bound to the
UUIDs found in `mailboxes.url`: `ZIDENTIFIER`, `ZACCOUNTDESCRIPTION` and `ZUSERNAME`. If a row
has no description, the description of its parent account (`ZPARENTACCOUNT`) is used; the
parent's user name is never read. An account without a description is named by its UUID. A
missing database or column makes names `unavailable`, never an error; without
`ZPARENTACCOUNT` there is just no parent fallback.

Checked on 2026-10-31 with `scripts/check-account-names.py` (counters only): of 14 account
UUIDs, 6 have a row. The other 8 are removed accounts. None has a `V<n>/<uuid>` directory or
an `.emlx` file, yet 7 still have message rows, because Mail does not purge the index. No other
source names them: no other Accounts4 column, no other Envelope Index table, no plist under
`MailData`; `com.apple.mail.plist` mentions 4 of them only in ordering lists without a name.
They keep their UUID as name, and `doctor` counts them as accounts without a match. One of them
is a stale `local://` account with one empty mailbox; the active local account has a row of
type `com.apple.account.OnMyDevice` with its localized name, so no "On My Mac" fallback is
needed. Two matched IMAP accounts had no description but a parent account (iCloud, Google)
with one, hence the parent fallback.

### Deduplication

The table `messages` holds about twice as many rows as there are distinct mails, because a mail
can sit in several mailboxes. Identity is `global_message_id`, exposed as `id`.

- Grouping happens in SQL, before sorting and paging, so pages are full and cursors are
  stable. The cursor is a keyset over the grouped result: date of the newest copy, then id.
- A mail counts as unread or flagged if any copy is; its mailboxes are all allowed mailboxes
  that hold a copy.
- For the body, the best copy wins: a complete file before `.partial` before none.
- Recipients come from `recipients.type`: 0 is `to`, 1 is `cc`, everything else is `bcc`. The
  column is nullable in the schema; a `NULL` reads as 0 and therefore as `to`. The `to` filter
  ignores the type and matches all three.

### One snapshot per request

`search` runs the fold refresh, the page query and the row lookup (`loadRows`) inside one read
transaction; `thread` does the same for the conversation lookup and its rows, `get-messages` for
the rows before it reads files. In WAL mode, which Mail uses, that is one snapshot: a write by
Mail in between cannot drop a found id from the page or make `totalMatched` disagree with it.
The transaction lasts as long as the request (milliseconds to a few hundred). In WAL mode a
reader blocks no writer; it only keeps a checkpoint from passing its snapshot until it ends.

- `id` stays valid until Mail rebuilds its index. After that, an old id answers
  `MESSAGE_NOT_FOUND`.

### Text search

Search terms are substring matches, case-insensitive including umlauts. SQLite's `LIKE` only
folds ASCII, so the helper registers a function that applies Unicode case folding. Folding is
accent-sensitive: "a with umlaut" does not match plain "a". Wildcard characters typed by the
user have no special meaning.

Node folds the same way for body search and for matching settings, with one known difference:
the Greek capital sigma. JavaScript lowercases a word-final capital sigma to the final form
(U+03C2), Swift always to the medial form (U+03C3). Each comparison folds both sides in the same
process, so the difference never mixes the two. It shows only in one case: a search term written
with a final sigma does not match the same word written in capitals in a subject or address
(helper), while body search (Node) does match it. A term ending in the medial form behaves the
other way round.

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
at 10,000, so `totalMatchedCapped` is always `false`.

`hasAttachment` is a prefilter on the set of groups where some allowed, non-deleted copy has an
attachment. The set is built starting from `attachments` (`attachments CROSS JOIN messages`, one
primary-key lookup per attachment row). Written the other way round, SQLite without `ANALYZE`
statistics picked `messages_deleted_mailbox_index` and probed every allowed mailbox for every
message with an attachment: about 1.1 s per page at real size, against 0.3 s for the old
per-row `EXISTS`.

`mailboxIds` is a prefilter too: the set of groups with a non-deleted copy in one of the given
mailboxes, read through `messages_mailbox_date_received_index`. As a `HAVING` condition it read
every allowed row even for a small mailbox: at real size 220 ms for a mailbox with 851 mails, now
3 ms; 230 ms against 100 ms now for the large mailbox that holds 60 % of the mails.

Whenever a prefilter yields a set of group ids (a text filter, `mailboxIds` or `hasAttachment: true`), the
outer query marks `deleted` and `mailbox` with a unary `+`. SQLite then fetches the groups through
`messages_global_message_id_mailbox_index` instead of reading every allowed row. The text filter
subqueries get the same `+`, so they use the subject, sender or ROWID index. The `+` does not
change results. With `sqlite_stat1` present SQLite picks these plans on its own; without it, it
does not. Nobody has checked yet whether Mail's index carries statistics, so the query fixes the
plan in both cases. `loadRows` uses the same `+` for the same reason.

A synthetic store in the real proportions (`FixtureBuilder` `.realSize`: 242,000 rows, 121,000
group ids, 28,700 attachment rows on 15,900 messages, 178 of 208 mailboxes allowed) times this,
one 20-row page with `countTotal`, release build, median of five warm runs, the same with and
without `ANALYZE`:

| Filter | Time |
|---|---|
| none | 270 ms |
| `hasAttachment: true` | 37 ms |
| `hasAttachment: false` | 325 ms |
| subject | 100 ms |
| subject and `hasAttachment: true` | 86 ms |
| from, to, query | 8 to 19 ms |
| query `e`, to `example` (almost every mail matches) | 440 ms, 320 ms |
| `mailboxIds`, small / large mailbox | 3 ms / 100 ms |

Run it with `PERF_REAL_SIZE=1 swift test -c release --package-path swift --filter realSize`. The
no-filter case is slower here than on the maintainer's real store (112 ms), so compare the rows
with each other, not with real-store numbers.

Measured on the maintainer's real mailbox (macOS 27.0.1, arm64, 238,642 message rows, 120,904
distinct mails, 221 mailboxes of which 190 allowed) with `scripts/measure-latency.mjs`, Dev
bundle (release build), warm helper, median of five runs, one 20-row page with `countTotal`
unless noted, 2026-10-26; repeated on the same mailbox on 2026-10-31 after the search hardening
(single read transaction, `mailboxIds` prefilter):

| Request | Median 10-26 | Median 10-31 | First call 10-31 |
|---|---|---|---|
| `list-mailboxes` | 1 ms | 1 ms | 1 ms |
| search, no filter | 89 ms | 95 ms | 249 ms (cold start) |
| search, no filter, no count | 61 ms | 69 ms | 69 ms |
| search, subject | 25 ms | 25 ms | 253 ms (builds the fold cache) |
| search, from | 7 ms | 7 ms | 32 ms |
| search, to | 4 ms | 4 ms | 16 ms |
| search, query | 30 ms | 32 ms | 32 ms |
| search, unread | 71 ms | 72 ms | 75 ms |
| search, `hasAttachment: true` | 27 ms | 28 ms | 31 ms |
| search, broad query `"e"` | | 457 ms | 503 ms |
| search, broad to `"@"` | | 268 ms | 275 ms |
| search, `mailboxIds` smallest / largest mailbox | about 220 ms (smallest) | 1 / 43 ms | 4 / 53 ms |
| `get-messages`, 1 / 20 messages | 2 / 13 ms | 1 / 12 ms | 2 / 15 ms |
| `thread` | 2 ms | 1 ms | 2 ms |
| body scan, one term, 20 matches | 1,267 ms for 981 examined candidates | 1,588 ms for 1,043 | |

Before the fold cache and the planner hints the first run gave subject 476 ms, query 534 ms,
`hasAttachment` 223 ms and a body scan of 6.5 s that broke its 3-second budget. The numbers are
for helper requests through the pipe; a tool call adds the Node work (summaries, MIME for
`get_message`). They are one mailbox on one machine, not a guarantee.

Run it yourself (prints timings and row counts only, never content):

```bash
APPLE_MAIL_HELPER_PATH="$PWD/bin/Mail MCP Helper (Dev).app" node scripts/measure-latency.mjs <term>
```

Inside a client, start the server with `APPLE_MAIL_MCP_DEBUG=true`: every helper request then
writes one line to stderr with the command, its duration including the pipe round trip, and the
result code, for example `apple-mail-mcp: search 42 ms ok`. A `search_messages` page is one
`search` line (plus `get-messages` lines when `bodyContains` scans bodies); the first request
after a start also pays for opening the database.

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
  whichever comes first; the clock is checked before every helper request and before every
  message, so the budget overshoots by at most one helper request or one message (one candidate
  is always examined);
- the result says which, in `scan` and in a plain-text `note`, and `nextCursor` continues
  after the last **examined** candidate (not the last match);
- security mails are skipped, so they cannot be found by content.

The scan does less work per message than `get_message` (`parseForScan` in `src/mime.ts`):
before parsing, `src/mimeTrim.ts` drops the bodies of parts that never become text
(attachments, images, `application/*`, the HTML half of an alternative with a plain half), and
an HTML-only message is searched in a rough tag-stripped form (`src/quickHtml.ts`) instead of
the `html-to-text` output. Both are only a prefilter, compared without any whitespace. A
message that passes it is parsed again exactly as `get_message` does, and that text decides the
match, the `matchContext` and the security check. Search runs first and the security check only
on a match, which gives the same result because the check only ever removes matches.
`unavailable` counts only messages without raw bytes or whose fast parse fails; it never
depends on the search term. A message whose exact parse fails after the prefilter passed counts
as searched without a match, exactly like a prefilter miss. Otherwise terms such as `4`, `48`,
... could read a code digit by digit from the counter. An HTML entity the prefilter does not
know (`&name;`) skips the prefilter for that message, which then always takes the exact parse.

One side channel is accepted: a message that passes the prefilter costs the exact parse and the
security check, so the response time of a scan grows slightly when a term occurs in a security
mail that is then withheld. The response content is the same either way (E2). Narrowing a code
this way would take many calls with timing noise from the helper and the other candidates.
`node scripts/bench-mime.mjs` (after `npm run build`) prints the per-stage timings on synthetic
mail; on the development machine the scan path handles about 2,400 messages per second there,
the full path about 600.

A raw grep over 2,000 random files took 2.5 s in the spike, and a scan of the whole mailbox
takes minutes, which is why the scan is bounded. The opt-in body index (below) lifts the bound
once it is built.

### Body index spike (AMM-14)

The planned index is an FTS5 table with `tokenize = 'trigram case_sensitive 1'`,
`content = ''` and `contentless_delete = 1` over the folded body text, written by Node with
`node:sqlite`. Two scripts check whether that works and what it costs:

- `node scripts/probe-sqlite.mjs` prints one JSON line to stderr with the Node and SQLite
  versions and whether each capability works, in an in-memory database.
  `scripts/build-probe-mcpb.sh <out-dir>` wraps it in an MCPB with the same
  `compatibility.runtimes.node` as the real one, so Claude Desktop runs it in its built-in Node.
  The line lands in `~/Library/Logs/Claude/main.log`.
- `scripts/measure-body-index.mjs [--max=N] [term ...]` builds a throwaway index in a temporary
  directory through the dev helper, prints only counts, sizes and times, and deletes the index
  at the end. Candidates come from `search` like the live scan, text from `parseForScan` (always
  the full text), and security mails are skipped.

Runtimes (2026-11-01, probe with the exact table from the spec):

| Runtime | SQLite | `node:sqlite` | FTS5, trigram, `contentless_delete` |
|---|---|---|---|
| Node 22.13.0, 22.14.0 | 3.47.2 | yes | no (`no such module: fts5`) |
| Node 22.15.0 | 3.49.1 | yes | no |
| Node 22.16.0 | 3.49.1 | yes | yes |
| Node 22.18.0 | 3.50.2 | yes | yes |
| Node 23.0.0 | 3.46.1 | no | no |
| Node 24.0.0, 24.6.0, 24.19.0 | 3.49.1, 3.50.4, 3.53.3 | yes | yes |
| Node 26.13.0 | 3.54.1 | yes | yes |
| Claude Desktop 4.4212.0, MCPB | 3.53.4 | yes | yes |

Claude Desktop starts MCPB node servers, this one included, in an Electron `UtilityProcess` with
its built-in Node (log: `isUsingBuiltInNodeForMcp is true and built-in node is compatible`),
here Node 24.22.0 in Electron 44.9.3. The `RunAsNode` fuse of the app is off, so that runtime
can only be tested through an MCPB. `node:sqlite` alone is not enough: the Node 22 line has it
from 22.13 but bundles FTS5 only from 22.16. The index needs `^22.16 || >=24`.

Build on the spike mailbox (macOS 27.0.1, arm64, default policy, Node 24.19.0, nothing else
running against the helper):

| | |
|---|---|
| distinct mails visible | 120,806 |
| indexed | 115,843 |
| skipped | unavailable 1,793, parse failed 409, empty 304, security 2,457 |
| raw bytes fetched | 4,971 MiB |
| text stored (`docs.text`) | 477 MiB |
| index files after checkpoint | 1,706 MiB (docs 545 MiB, fts 1,159 MiB), 3.6 x text, about 14 KiB per mail |
| build time | 335 s, 2.8 ms per mail |
| of which | `search` 16 s, `get-messages` 80 s, parse and classify 118 s, write 121 s |
| peak RSS | 415 MiB |

Queries (three typical German terms of 5 to 8 characters, median of 5 runs):

| Term length | FTS hits | FTS query | `findMatch` on all hits | `includes` over all stored text | missed by FTS |
|---|---|---|---|---|---|
| 8 | 10,677 | 9 ms | 6.0 s | 1.9 s | 0 |
| 6 | 3,789 | 5 ms | 3.8 s | 2.1 s | 0 |
| 5 | 6,043 | 4 ms | 4.3 s | 2.0 s | 0 |

What follows from it:

- The trigram phrase over folded text gave exactly the live-scan matches: every hit passed
  `findMatch`, and a plain `includes` over all 115,843 stored texts found no message that FTS
  missed.
- The FTS query itself costs milliseconds. `findMatch` costs 0.4 to 1 ms per hit, so the search
  must confirm only the rows of the returned page (spec 5.4 step 4), never all hits.
- No term came near the 200,000-hit fallback.
- The full build takes minutes and the parse and write steps run on the main thread: about
  100 ms per block of 50 mails. A tool call can wait that long behind one block, unless the
  indexer uses smaller blocks or a `worker_thread` (spec section 7 leaves that open).
- Disk use is about 1.7 GiB for 121,000 mails; the README should give about 14 KiB per mail.

### Body index

`APPLE_MAIL_BODY_INDEX=true` (effective only together with `APPLE_MAIL_BODY_SEARCH`) turns on a
full-text index of the message bodies, in `src/bodyIndex/`. Node writes it with `node:sqlite`;
the helper only supplies rows and raw bytes, as for the scan, and never writes or parses
anything.

**Storage.** `~/Library/Application Support/apple-mail-mcp/body-index/index.sqlite` in WAL mode,
directory 0700, files including `-wal` and `-shm` 0600, directory excluded from Time Machine
with `/usr/bin/tmutil addexclusion` when it is created. Tables: `meta` (schema version,
fingerprints, high-water mark, build state), `docs` (one row per message: `gid`, `part`, the
whitespace-collapsed text for `matchContext`), `skipped` (`gid` and a reason: `security`,
`unavailable`, `parse_failed`, `empty`, never text) and the contentless FTS5 table `fts` with
`tokenize = 'trigram case_sensitive 1'` over `foldFast(text)`. Folding before indexing gives the
same folding as the scan, `ss` for `ß` included; the built-in folding of FTS5 differs.

**Building.** The indexer starts after the first successful helper call of a tool, so nothing
happens without Full Disk Access. It walks `messages` by `ROWID` with `index-feed` in pages of
500, fetches bodies with `get-messages` in blocks of 50 (256 KiB per message, 16 MiB per
request, as the scan), parses them with `parseForScan` and always the full text, classifies
them, and writes each block in one transaction together with the new high-water mark. Between
blocks it yields, so tool calls get into the helper queue. After the build it catches up from
the high-water mark every 60 seconds and, for at most one second, before each body search.
Every 30 minutes it reconciles with `index-gids`: messages that are deleted or no longer
allowed leave the index, newly allowed ones and bodies Mail loaded later are fetched. Only then
is the build complete and the index serves searches.

**Consistency.** The index is a cache and is rebuilt rather than repaired: when the Envelope
Index fingerprint or the `V<n>` directory changes, when `max(ROWID)` falls below the high-water
mark (Mail rebuilt its index), when the schema version differs, or when SQLite reports the file
as damaged. A new security-mail classifier re-checks the stored texts; a new MIME parser
retries `parse_failed` and `empty`. A changed configuration (accounts, junk, trash, excluded
mailboxes: the index fingerprint) marks the build incomplete and reconciles.

**Searching** (`src/bodyIndex/search.ts`). The term is folded like the scan's. Terms shorter
than three characters are scanned, because a trigram index cannot find them. Otherwise:

1. FTS returns every `gid` whose folded text contains the term as a phrase, without order.
2. With `APPLE_MAIL_SHOW_SECURITY_MAILS=true`, the security mails in `skipped` are scanned live
   and their matches join the set, because the scan would find them.
3. One `search` with these `gids` (at most 200,000; above that the request is scanned live), the
   other filters, the cursor keyset and `limit`. The helper applies the current policy and
   returns the page in the scan's order, `(date DESC, gid DESC)`.
4. Each row is confirmed with `findMatch` on the stored text, which also yields `matchContext`.
   A row that fails is skipped and the search reads on from its keyset.

Order and keyset come only from the helper; the index stores no date, because the group date
depends on the policy. The cursor is the scan's cursor, and `bodyIndex` is not part of the
policy fingerprint, so cursors stay valid when the index is switched on or off. No count in the
answer depends on the term: `totalMatched` is omitted and `bodyIndex.indexed` counts the whole
index.

**Two servers.** Claude Desktop and Claude Code can each run a server. One of them writes: the
lease is `body-index/writer.lock` with pid and heartbeat, created exclusively, renewed every
10 seconds and free after 60 seconds or when the process is gone. Others open the index read
only and use it if its index fingerprint matches their configuration and the build is
complete; otherwise they scan.

**Turning it off.** A server that starts with a valid configuration and the index off deletes
the directory, unless another server holds a valid lease. An invalid configuration deletes
nothing, nor does a missing `node:sqlite` with the index on. `doctor` opens the index read only
and reports counts, size, last update, build progress and the Time Machine exclusion, never
content.

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
- Spotlight finds no mail items, so it is not an option for body search;
- helper latency per request on that mailbox (2026-10-26), in the table under Text search;
- the grant across release builds, paths and install channels with `rc.1` and `rc.2`
  (2026-10-31), in the table under Permission model. `doctor` on that mailbox: 221 mailboxes,
  238,863 message rows, 121,125 distinct mails, 190 mailboxes visible with the default policy;
  of the 500 newest messages 446 have a full local file, 54 a partial one, none is missing;
- `node:sqlite` with FTS5 trigram per Node version and in Claude Desktop's MCPB runtime, and size
  and build time of a body index on that mailbox (2026-11-01), under Body index spike.

Assumed, not measured:

- macOS 15 and 26 with a real mailbox: the minimum deployment target is 15. The schemas of
  macOS 15.8.2 and 26.6.2 come from the schema probe on GitHub runners without an account and
  pass the column check; macOS 15 lacks `message_global_data.message_id_header`, which is
  therefore optional and read as NULL. Collected schemas go to `fixtures/schema/`, where a
  Swift test runs the column check against each one;
- Exchange accounts: not in the spike mailbox; [`exchange.md`](./exchange.md) lists what the
  code does and what to check;
- whether macOS turns a grant off at `exec` or at first file access for an unexpected
  ad-hoc build with the release id;
- latency on other machines, Intel Macs and mailboxes much larger than the one measured.
