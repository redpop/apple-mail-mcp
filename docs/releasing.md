# Releasing

For the maintainer. Only the maintainer runs releases, and only in CI: the release bundle id and
the Developer ID signature never exist on a local machine.

## What a release produces

A tag `v<version>` runs `.github/workflows/release.yml`. After approval in the `release`
environment it:

1. checks that the tag matches `package.json`, that `server.json`, `manifest.json` and the helper
   version agree, and that the tagged commit is on `main` (`scripts/release/check-tag.sh`);
2. runs typecheck, vitest, Swift tests and the TypeScript build;
3. imports the Developer ID certificate into a temporary keychain (`import-signing.sh`);
4. builds the universal helper `bin/Mail MCP Helper.app` with the release bundle id, then removes
   the keychain at once, before any downloaded tool runs (`cleanup-keychain.sh`);
5. notarizes and staples it with the App Store Connect API key (`notarize.sh`);
6. verifies the bundle: both architectures, identifier, Developer ID authority, team, hardened
   runtime, the release requirement from `src/signing.ts`, the stapled ticket, Gatekeeper, no
   symlinks (`verify-bundle.sh`, which prints the CDHash);
7. packs the npm tarball and checks the unpacked copy: executable, valid signature, same CDHash
   (`verify-npm-pack.sh`);
8. builds the `.mcpb` and checks the unpacked copy the same way (`build-mcpb.sh`);
9. attests `mail-helper.zip` and the `.mcpb`;
10. publishes to npm and creates the GitHub release with `mail-helper.zip`, the `.mcpb` and
    `SHA256SUMS` (`publish.sh`);
11. publishes `server.json` to the MCP Registry with the checksum of the released `.mcpb`
    (`scripts/publish-registry.sh`), after waiting up to ten minutes until npm serves the new
    version: the Registry checks the npm package, and a new package shows only a
    `0.0.0-stage` placeholder for a while after its first publish;
12. runs `cleanup-keychain.sh` again as a fallback, also after a failure.

A local `npm publish` of the project directory fails: the `prepublishOnly` hook
(`scripts/release/check-publish.mjs`) requires `CI=true` and exactly the release bundle in `bin/`.
npm skips that hook for `npm publish <tarball>` and `--ignore-scripts`, and the release job itself
publishes a tarball. In the release, `verify-npm-pack.sh` is the check that keeps a development
bundle out of the package. Tags with a prerelease version such as `v0.1.0-rc.1` are refused;
candidates come from the release candidate workflow.

## One-time setup

- **App Store Connect API key** (Users and Access, Integrations, Team Keys), role Developer, used
  only for notarization of this project's helper.
- **Environment `release`**: required reviewer is the maintainer; deployment branches and tags
  are tags `v*` and the branch `main` (the release candidate runs from `main`).
- **Environment secrets** (never repository secrets): `APPLE_CERTIFICATE_BASE64`,
  `APPLE_CERTIFICATE_PASSWORD` (Developer ID Application `.p12`), `APPLE_API_KEY_BASE64` (the
  `.p8`), `APPLE_API_KEY_ID`, `APPLE_API_ISSUER_ID`, and `NPM_TOKEN` for the first publish only.
  Set them with `gh secret set NAME --env release`.
- **Tag ruleset** for `refs/tags/v*`: restrict creation, update and deletion to repository admins.

On the runner, the `.p12` and the `.p8` exist only inside the script that uses them, in
`$RUNNER_TEMP` with mode 0600, and a `trap` deletes them when that script ends.

## Cutting a release

1. Run the **Release candidate** workflow (`release-candidate.yml`) from `main` and approve it. It
   builds, signs, notarizes and verifies everything as above with the version
   `<version>-rc.<run>`, publishes nothing, and uploads the zip, the `.mcpb` and the npm tarball as
   workflow artifacts for 14 days.
2. On a Mac with real mail, check the candidate:
   - first Full Disk Access grant through the `.mcpb` in Claude Desktop and through
     `npx --package=<tarball> apple-mail-mcp setup`;
   - update from one candidate to the next: the grant stays and no second entry appears;
   - `doctor` with and without `--verbose`;
   - record the measurements in [`architecture.md`](./architecture.md).
3. Bump the version and push the tag:

   ```bash
   npm version 0.1.0
   git push --follow-tags
   ```

   The `version` hook runs `scripts/sync-versions.mjs`, which writes the version to
   `server.json`, `manifest.json` and the Swift source, and stages them for the version commit.
4. Approve the run in the `release` environment.

## First publish to npm

The package does not exist on npm before the first release, so trusted publishing cannot be set
up yet. The first run publishes with `NPM_TOKEN`: a granular access token with "Read and write
(publish and stage)" for the `@redpop` scope, "Bypass two-factor authentication" checked, no IP
ranges (hosted runners have no fixed address) and the shortest expiry. Delete the token on
npmjs.com and the `NPM_TOKEN` secret after the run.

npm is phasing these tokens out: since August 2026 a bypass-2FA token can no longer manage
tokens, maintainers or trusted publishing, and from around January 2027 it can no longer publish
directly, only stage a version that a maintainer then approves with 2FA. A first publish after
that date needs `npm stage publish`, which `publish.sh` does not do yet.

Later runs publish through OIDC; `release.yml` no longer passes a token. Add the repository and
`release.yml` as a trusted publisher on npmjs.com, interactively with 2FA. An unvalidated trusted publisher expires 48 hours after it is
created and becomes validated with its first successful publish. Add it shortly before the next
release, not right after the first one; if it expired, delete it and add it again.

## When a run fails halfway

Re-run the failed job. A re-run builds and signs again, so its files differ byte for byte from
the first run's. `publish.sh` therefore never replaces anything that was published:

- a version already on npm is skipped;
- an existing GitHub release without assets gets all of them; one with all assets stays as it is;
- an existing release with only some assets stops the run. Delete those assets from the release
  and re-run, so that the zip, the `.mcpb` and `SHA256SUMS` come from one build.

If only the MCP Registry step failed, run the **MCP Registry** workflow (`registry.yml`) on the
tag. It downloads the released `.mcpb`, computes its checksum and publishes `server.json`; it
builds and publishes nothing else.
