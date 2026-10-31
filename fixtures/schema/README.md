# Collected schemas

DDL only, never data. `swift/Tests/MailHelperCoreTests/SchemaFixtureTests.swift` runs the
helper's column check against every `envelope-index-*` file here, so adding a schema needs no
code change.

| File | Source | Verified |
| --- | --- | --- |
| `envelope-index-macos27.sql` | macOS 27.0.1, Mail 16.0, spike 2026-10-25 | yes, against a real mailbox |
| `accounts4-min.sql` | minimal `Accounts4.sqlite` for the fixture builder | not a collected schema |

## Adding a schema

Name the file `envelope-index-<macos>[-<note>].<ext>`, for example `envelope-index-macos15.4.txt`,
and add a row to the table above with macOS and Mail version and where it came from.

- `.txt`: the output of `apple-mail-mcp doctor --schema`, pasted unchanged from a
  "Schema report" issue. The first line is the fingerprint; any further lines without `CREATE `
  are the missing columns `doctor` reported, and the test expects exactly those.
- `.sql`: SQL, for example `sqlite3 -readonly "Envelope Index" .schema` or the artifact of the
  "Schema probe (experiment)" workflow. `CREATE TABLE sqlite_*` lines, indexes, triggers and
  views that cannot be created without Mail are skipped. If columns are missing on purpose, add a
  line `-- expect-missing: table.column, table.column`; without it the schema must be compatible.

Check that the file holds no `INSERT` statements or other data before committing it.
