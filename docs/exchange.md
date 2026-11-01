# Exchange accounts

Status: **unverified.** No Exchange account was available when the helper was built or measured
(see "What was measured and what is assumed" in [`architecture.md`](./architecture.md)). This page
records what the code does today and what has to be checked on a real Exchange account before
anything changes. It deliberately does not guess Mail's on-disk layout for Exchange.

## What the code does today

Mail identifies an Exchange (EWS) mailbox by a URL with the scheme `ews://`, like
`imap://<account-uuid>/<folder>` for IMAP. That much is assumed from the scheme names Mail uses,
not observed in a real index.

- **Mailboxes and accounts.** The helper takes the account UUID from the host part of `imap://`,
  `local://` and `ews://` URLs (`MailStore.accountUUID` in `Mailboxes.swift`), so an Exchange
  account gets a name from `Accounts4.sqlite` like any other. Node reports such accounts with
  `type: "exchange"` (`src/mailboxes.ts`).
- **Metadata.** Search, threads and message summaries read only the Envelope Index rows and do not
  depend on the URL scheme. If Mail indexes Exchange mail in the same tables, they should work;
  this is not measured.
- **Bodies.** The `.emlx` locator builds paths only for `imap://` and `local://`
  (`EmlxLocator.mboxPath`). For `ews://` it returns no path, so every Exchange message has no
  file: `get_message` answers `bodyAvailable: false` with `bodyUnavailableReason:
  "file_not_found"` (`src/tools/getMessage.ts`), and attachments show `downloaded: false`.
  `tests/tools.test.ts` and `EmlxLocatorTests.swift` pin this behaviour.

Bodies stay unavailable on purpose until the path scheme is known: the locator turns URL segments
into file paths, which is part of the helper's security boundary. Opening the scheme guard to
`ews` on a guess could read the wrong file for a message or none at all.

## What to check on a real Exchange account

On a Mac with an Exchange account in Mail, in a terminal that has Full Disk Access (`V<n>` is the
newest `~/Library/Mail/V*` directory, `V10` on macOS 27). Write down
structure only; do not copy subjects, addresses, folder names or message text into an issue.

1. **Mailbox URLs.** `sqlite3 -readonly ~/Library/Mail/V<n>/MailData/"Envelope Index" "SELECT
   ROWID, url FROM mailboxes WHERE url LIKE 'ews://%'"`. Note the scheme spelling, whether the
   host is the account UUID from `Accounts4.sqlite`, and whether the path segments are folder
   names (as with IMAP) or opaque ids.
2. **Directory layout.** `find ~/Library/Mail/V<n>/<account-uuid> -maxdepth 3 -type d`. Check
   whether there are `<folder>.mbox` directories with a store UUID and a `Data` directory, as for
   IMAP, and how the directory names relate to the URL segments from step 1.
3. **One message.** Pick a `messages.ROWID` from an Exchange mailbox whose body Mail shows, and
   run `find ~/Library/Mail/V<n>/<account-uuid> -name '<rowid>.emlx' -o -name
   '<rowid>.partial.emlx'`. Compare the path with what `EmlxLocator.mboxPath` and
   `digitDirs` would build for the same URL. If there is no `.emlx` at all, Mail keeps Exchange
   bodies elsewhere and the locator cannot serve them.
4. **Schema.** Run `apple-mail-mcp doctor --schema` and file a "Schema report" issue; Exchange may
   add tables or columns but must not remove the ones the column check needs.

Only if steps 1 to 3 show the IMAP layout can `mboxPath` accept `ews` unchanged, with a fixture
mailbox and a locator test for it. Any other layout needs its own, written path rule first.
