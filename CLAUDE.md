# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

A read-only MCP server exposing Apple Mail on macOS. Two halves: a Swift helper (an `.app` bundle) that reads Mail's SQLite index and `.emlx` files, and a TypeScript MCP layer that drives it and parses the mail content.

## Commands

```bash
npm test                                  # full vitest suite
npx vitest run tests/policy.test.ts       # one file
npx vitest run -t "name fragment"         # one test by name
npm run typecheck                         # tsc --noEmit (src/ and tests/)
npm run build                             # tsc -> dist/ (src/ only)
npm run build:helper                      # swift/build.sh -> bin/Mail MCP Helper (Dev).app
npm run test:swift                        # swift test --package-path swift
node scripts/sync-versions.mjs            # package.json version -> server.json, manifest.json, Swift
```

Releases run only in CI: `release.yml` (tag `v*`), `release-candidate.yml` (manual, publishes nothing) and `registry.yml` (MCP Registry retry), all in the `release` environment except `registry.yml`. They call the scripts in `scripts/release/`; `docs/releasing.md` has the process. `ci.yml` runs `verify-bundle.sh` against the ad-hoc bundle and expects it to fail, and validates `manifest.json`.

Run the built server against your local helper:

```bash
APPLE_MAIL_HELPER_PATH="$PWD/bin/Mail MCP Helper (Dev).app" node dist/index.js doctor
```

After changing `swift/`, run `npm run build:helper` and restart the client. After changing `src/`, run `npm run build` and restart the client; it loads `dist/index.js` once at startup.

`vitest.config.ts` pins `TZ=Europe/Berlin`. Date tests assert literal offsets; do not make them timezone-agnostic.

Agents must not run `setup`, grant Full Disk Access, or sign with a Developer ID. Granting access to the Dev bundle is a manual step by the maintainer.

## The architecture constraint that explains everything

Apple Mail's files under `~/Library/Mail` need Full Disk Access (FDA). macOS attributes that permission to the **responsible process**, which for a child of a GUI client or terminal is the client or terminal. Granting FDA to either would hand them every protected file on the Mac.

The helper therefore **disclaims responsibility at startup**: it re-execs itself with `responsibility_spawnattrs_setdisclaim` (resolved through `dlsym`), so it becomes its own responsible process and the grant attaches to it alone. It runs as a long-lived child (`mail-helper serve`) speaking NDJSON over stdin/stdout.

The helper is a `.app` bundle, not a bare binary, because the bundle spike (2026-10-25) showed that for a bundle the grant binds to **bundle id plus designated requirement, not to the path**. Moving, copying or updating the bundle keeps the grant. There is no install step and no fixed install path: Node starts the bundle where npm or MCPB put it. An ad-hoc build carrying the same bundle id, at any path, switches the user's grant off. That is why there are three bundle ids (below).

Consequences:

- `HelperRunner.run(command, payload): Promise<unknown>` is the seam. `src/tools/*.ts` and the tool tests use a fake behind it. Keep it intact.
- The helper holds FDA, so everything that can be done without FDA is done in Node: MIME, HTML to text, quote stripping, security-mail detection, body scan, cursor handling, policy computation.
- Node computes `allowedMailboxIds` from configuration and sends it with every read command; the helper requires it and restricts every query to it.

`docs/architecture.md` has the details and the measurements.

## Invariants that are easy to break

**stdout is protocol-only, on both legs.** Between client and Node it carries MCP messages; between Node and the helper it carries NDJSON. Logging goes to stderr. A stray `console.log` in `src/` corrupts the first leg; a stray `print()` in the helper corrupts the second. `setup` and `doctor` are separate CLI modes (`src/cli/`) and may write to stdout; the server mode may not.

**No free SQL, no path parameters in the helper.** The helper has a fixed command set (`hello`, `probe`, `list-mailboxes`, `search`, `get-messages`, `thread`, `index-feed`, `index-gids`), parameterised queries only, and derives `.emlx` paths itself (checked with `realpath` under `~/Library/Mail`). A path or SQL fragment from the caller would turn it into a file or database oracle for any local process. Tests pass the mail root through the library API; the executable knows only `~/Library/Mail`. There is deliberately no `APPLE_MAIL_ROOT`.

**Node parses untrusted MIME, never Swift.** The helper does not even strip the `.emlx` length frame. A parser bug must hit a process without special rights.

**Security-relevant settings come from the environment, never from tool parameters.** Adding a tool parameter that widens access (accounts, junk, security mails, limits) breaks the prompt-injection model.

**Three bundle ids, never shared.** Release `io.github.redpop.apple-mail-mcp.mail-helper` (name "Mail MCP Helper", Developer ID, CI only), `...mail-helper.dev` ("Mail MCP Helper (Dev)", Apple Development), `...mail-helper.adhoc` ("Mail MCP Helper (Ad hoc)"). The team id and ids live in `src/signing.ts` and `swift/build.sh`; `tests/signing.test.ts` checks they match. `build.sh` refuses the release id unless `CI=true`.

**Never sign with Developer ID locally** and never ad-hoc sign at a path that already holds a grant. Do not read release secrets, unlock keychains, or write private keys to disk.

**Fixtures use reserved domains only:** `example.com`, `example.org`, `example.net`, `*.test`. Never a real person's address or domain, in tests, fixtures or docs. `tests/docs.test.ts` enforces this for the docs and keeps an allowlist of platform and package domains.

**Docs and config stay in step.** Every `APPLE_MAIL_*` variable named in `src/config.ts` must appear in the README table (`tests/docs.test.ts`).

**Comments are in German, ASCII-transliterated** (`ae`, `oe`, `ue`, `ss`). User-facing text, error messages, docs and commit messages are in English.

**The helper's JSON is a contract with golden files.** `tests/fixtures/contract/*.json` hold one response per helper command plus one error, produced from the Swift fixture by `swift/Tests/MailHelperCoreTests/ContractTests.swift`; `tests/contract.test.ts` parses them with strict variants of the `src/schemas.ts` schemas, so a key Swift sends but Node does not declare fails. After changing a response shape, regenerate with `UPDATE_CONTRACT=1 npm run test:swift`, review the diff and commit it; without the variable the Swift test compares against the committed files. `osVersion` and `helperVersion` are replaced by `0.0.0` placeholders.

**Errors are mapped, not thrown raw.** `src/errors.ts` maps every code to an English sentence for the model; `respond()` is the only place errors become tool results. Never a stack trace, never user data in the details. A new helper error code needs a message there.

**Invalid configuration does not stop the server.** It starts and answers every tool call with `CONFIG_INVALID`. Invalid config never falls back to "allow all".

## Dependencies worth knowing

`@modelcontextprotocol/server` **v2**, not the older `@modelcontextprotocol/sdk`. In v2, `registerTool`'s `inputSchema` is a complete `z.object({...})`, not a raw shape. zod is imported as `zod/v4`.

Tool `annotations` are functional: `readOnlyHint: true` lets hosts run the tools without a prompt per call. Behavioural guidance for the model belongs in the server `instructions` (`src/server.ts`), never in tool descriptions, where it reads as prompt injection.

Runtime dependencies are limited to `@modelcontextprotocol/server`, `zod`, `postal-mime` and `html-to-text`. Add another only with a written reason in the PR.

## Scope

Four tools, `setup` and `doctor`. Out on purpose: sending, drafts, moving, deleting, flagging, `extract_links`, attachment contents, embeddings. Opt-in and off by default: the body index (`APPLE_MAIL_BODY_INDEX`, `src/bodyIndex/`), a plain-text copy of mail bodies on disk; see `SECURITY.md`. Released: 0.1.0 (2026-11-01) on npm, as a GitHub release with the `.mcpb`, and in the MCP Registry; the next npm publish goes through trusted publishing (`docs/releasing.md`).
