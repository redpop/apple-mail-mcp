# Tools

Four tools, all read-only. Each is annotated `readOnlyHint`, `idempotentHint` and not
`openWorld`, declares an output schema, and returns the result both as structured content and as
JSON text. Errors come back as tool errors with a plain-English message; see
[Errors](#errors).

Conventions:

- Timestamps are ISO 8601 with the local UTC offset of the machine, for example
  `2026-03-04T09:15:00+01:00`.
- `since` and `before` accept a date (`2026-03-04`, local midnight) or a date and time with an
  explicit offset (`2026-03-04T09:00:00+01:00` or `...Z`). A time without an offset is rejected.
  `since` is inclusive and `before` exclusive.
- Ids are strings of digits. Message ids, mailbox ids and thread ids come from tool results and
  cannot be guessed.
- Mail content (subjects, bodies, names) is untrusted data. The server's `instructions` say so.
- Text filters are substring matches, case-insensitive including umlauts, accent-sensitive.

## Message summary

`search_messages`, `get_thread` and (extended) `get_message` return this shape:

| Field | Meaning |
|---|---|
| `id` | Message id. Stable until Mail rebuilds its index. |
| `link` | `message://` link that opens the mail in Mail.app, or `null` if the mail has no Message-ID (always on macOS 15, where Mail does not store it). |
| `subject` | Subject. For security mails the digit runs of 4 to 8 characters are replaced by `••••` and `subjectRedacted` is `true`. |
| `from` | `{address, name}` or `null`. `name` is `null` when there is no display name. |
| `to`, `cc` | Up to 5 recipients each in lists; `recipientCount` is the total. |
| `date` | When the message was received. |
| `mailboxes` | Visible mailboxes holding a copy: `{id, name, account}`. |
| `unread`, `flagged` | True if any copy is. |
| `attachmentNames`, `attachmentCount` | From Mail's database. |
| `threadId` | Conversation id, or `null`. |
| `bodyLocal` | `full`, `partial` (text present, attachments missing) or `none` (never downloaded). |
| `matchContext` | Up to 160 characters around the first hit; only with `bodyContains`. |

## list_mailboxes

Lists accounts and the mailboxes that are visible under the current settings. Takes no
parameters.

Result: `accounts`, each with `id`, `name` (the account description from macOS, else the
account UUID), `address`, `type` (`imap`, `local`, `exchange`,
`other`) and `mailboxes`. Each mailbox has `id`, `name`, `path`, `role` (`inbox`, `sent`,
`drafts`, `archive`, `junk`, `trash`, `allmail`, `other`), `total` and `unread`. Accounts and
mailboxes excluded by configuration are absent, not marked. If an entry of
`APPLE_MAIL_ACCOUNTS` matches nothing, `note` says so without repeating the entry.

## search_messages

Searches, newest first. With no filter it returns the newest messages.

| Parameter | Meaning |
|---|---|
| `query` | Free text in subject, sender address and name, recipient addresses and names. |
| `from`, `to`, `subject` | Narrower text filters. `to` covers To, Cc and Bcc. |
| `bodyContains` | Text inside the body (2 to 200 characters). See below. |
| `mailboxIds` | Restrict to these mailbox ids from `list_mailboxes`, at most 50. |
| `since`, `before` | Date range on the received date. |
| `unread`, `flagged`, `hasAttachment` | Boolean filters. |
| `limit` | 1 to 100, default 20, capped by `APPLE_MAIL_MAX_RESULTS`. |
| `cursor` | `nextCursor` from the previous page, with the same filters. |

Unknown parameters are rejected.

Result: `messages` (summaries), `nextCursor` (`null` on the last page), `note`, and for
searches without `bodyContains` on the first page `totalMatched`, the exact number of matches,
with `totalMatchedCapped: false`. Later pages (with `cursor`) omit both.

**Body search.** `bodyContains` decodes messages, so it is bounded: it examines up to 2,000 of
the newest candidates for the other filters, or until 3 seconds have passed, or until `limit`
matches are found. The result then includes `scan` (`scanned`, `unavailable`, `stoppedBy` as
`limit`, `cap` or `time`, `complete`) and a `note` that says how far it got. Call again with
`nextCursor` to continue, or narrow with `from`, `since` or `mailboxIds`. Messages whose body is
not on this Mac or cannot be decoded count as `unavailable`; this count never depends on the
search term. Security mails are never matched by body.
`APPLE_MAIL_BODY_SEARCH=false` turns the parameter off.

Errors: `MAILBOX_NOT_FOUND` (unknown or hidden mailbox id; both look the same), `INVALID_CURSOR`,
`INVALID_INPUT`.

## get_message

Returns one message with its body as text.

| Parameter | Meaning |
|---|---|
| `id` | Message id. |
| `maxChars` | 500 to 100,000, default 20,000, capped by `APPLE_MAIL_MAX_BODY_CHARS`. |
| `stripQuoted` | Remove quoted replies and "On ... wrote:" blocks. Default `false`. |

Result: the summary fields plus `replyTo`, `dateSent`, `attachments` (`name`, `downloaded`),
`bodyAvailable` and `body`.

- `body` is `{text, format, truncated, totalChars, quotedRemoved}`. `format` is `plain`, or
  `html` when only HTML existed and was converted to text. Text is cut at a word boundary.
- When there is no body, `body` is `null`, `bodyAvailable` is `false`, and
  `bodyUnavailableReason` is one of `not_downloaded` (Mail has not fetched it),
  `file_not_found` (expected locally but missing), `withheld_security` (detected as a security
  mail and not shown) or `parse_failed`. An empty string never stands for "no body".
- `to` and `cc` are complete here, up to 100 each.
- Attachment contents are not returned.

Errors: `MESSAGE_NOT_FOUND` (also for a message that exists only in hidden mailboxes),
`INVALID_INPUT`.

## get_thread

Returns the conversation that contains a message.

| Parameter | Meaning |
|---|---|
| `id` | Any message of the thread. |
| `limit` | 1 to 100, default 50. |

Result: `threadId`, `messages` (summaries, oldest first, no bodies), `hasMore`, `note`. When
the thread is longer than `limit`, the result shows the oldest `limit` messages and `note` gives
the total. Read bodies with `get_message`. Errors: `MESSAGE_NOT_FOUND`, `INVALID_INPUT`.

## Errors

Every error carries a sentence for the model. The codes:

| Code | Meaning and what to do |
|---|---|
| `FULL_DISK_ACCESS_REQUIRED` | The helper has no Full Disk Access. The message lists the steps. See [troubleshooting](./troubleshooting.md). |
| `MAIL_DATA_NOT_FOUND` | Mail is not set up on this Mac. Open Mail and add an account. |
| `SCHEMA_UNSUPPORTED` | This macOS or Mail version has a different database layout. Run `doctor` and file an issue. |
| `DATABASE_BUSY` | Mail is writing a lot. Retry shortly. |
| `DATABASE_ERROR` | Unexpected database error. Retry once, then run `doctor`. |
| `MESSAGE_NOT_FOUND` | No such message, or it is hidden. Ids become invalid when Mail rebuilds its index. |
| `MAILBOX_NOT_FOUND` | No such mailbox or not visible. Use `list_mailboxes`. |
| `INVALID_CURSOR` | The cursor is from a different search or from before a settings change. Search again without it. |
| `INVALID_INPUT` | A parameter is invalid; the message names it. Also used when `bodyContains` is disabled. |
| `CONFIG_INVALID` | A server setting is invalid; the message names it. The user must fix it and restart the client. |
| `HELPER_MISSING` | The helper app is not in the installation. Reinstall. |
| `HELPER_CRASHED` | The helper stopped. Retrying starts it again. |
| `HELPER_TIMEOUT` | The helper did not answer in time. Retry, with a narrower search. |
| `HELPER_VERSION_MISMATCH` | Server and helper versions differ. Restart the client or reinstall. |
| `HELPER_SIGNATURE_INVALID` | The helper's signature did not verify; it was not started. Reinstall from the official source. |
| `HELPER_UNTRUSTED_SIGNATURE` | The helper judged its own signature untrusted and refused to read. Reinstall. |
