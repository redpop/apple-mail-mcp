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
4. builds the universal helper `bin/Mail MCP Helper.app` with the release bundle id;
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
    (`scripts/publish-registry.sh`);
12. removes the keychain, also after a failure (`cleanup-keychain.sh`).

`npm publish` from anywhere else fails: the `prepublishOnly` hook
(`scripts/release/check-publish.mjs`) requires `CI=true` and exactly the release bundle in `bin/`.

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
     `npx <tarball> setup`;
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
up yet. The first run publishes with `NPM_TOKEN`. Afterwards, add the repository and
`release.yml` as a trusted publisher on npmjs.com and delete the `NPM_TOKEN` secret; later runs
publish through OIDC.

## When a run fails halfway

Re-run the failed job. `publish.sh` skips `npm publish` when the version is already on npm, and
uploads the assets again when the GitHub release already exists.

If only the MCP Registry step failed, run the **MCP Registry** workflow (`registry.yml`) on the
tag. It downloads the released `.mcpb`, computes its checksum and publishes `server.json`; it
builds and publishes nothing else.
