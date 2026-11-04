# Releasing

For the maintainer. Releases run only in CI: the release bundle id and the Developer ID signature
never exist on a local machine. The maintainer checks the candidate and approves every run in the
`release` environment; step 3 below an agent may do when the maintainer asks for a release by
version.

## What a release produces

A tag `v<version>` runs `.github/workflows/release.yml`. The list below is what happens for the
read package, on every tag. The second package, `packages/actions`, goes along only when its gate
is open; see [The actions package](#the-actions-package). After approval in the `release`
environment the run:

1. checks that the tag matches `package.json`, that all version files agree (`server.json`,
   `manifest.json` and the helper version, and for `packages/actions` its `package.json` with the
   exact pin of the read package, `manifest.json`, `server.json`, Swift version and lock entry), and
   that the tagged commit is on `main` (`scripts/release/check-tag.sh`);
2. runs typecheck, vitest, the Swift tests of both packages and the TypeScript build;
3. imports the Developer ID certificate into a temporary keychain (`import-signing.sh`);
4. builds the universal helper `bin/Mail MCP Helper.app` with the release bundle id, then removes
   the keychain at once, before any downloaded tool runs (`cleanup-keychain.sh`);
5. notarizes and staples it with the App Store Connect API key (`notarize.sh`);
6. verifies the bundle: both architectures, identifier, Developer ID authority, team, hardened
   runtime, the release requirement from `src/signing.ts`, passed as an argument, the stapled
   ticket, Gatekeeper, no symlinks (`verify-bundle.sh`, which prints the CDHash);
7. packs the npm tarball, refuses anything named after `mail-actions` in it, and checks the
   unpacked copy: executable, valid signature, same CDHash (`verify-npm-pack.sh`);
8. builds the `.mcpb` and checks the unpacked copy the same way (`build-mcpb.sh`);
9. attests `mail-helper.zip` and the `.mcpb`;
10. publishes to npm and creates the GitHub release with `mail-helper.zip`, the `.mcpb` and
    `SHA256SUMS` (`publish.sh`);
11. publishes `server.json` to the MCP Registry with the checksum of the `.mcpb` it downloads from
    the release (`scripts/publish-registry.sh`), after waiting up to ten minutes until npm serves the new
    version: the Registry checks the npm package, and a new package shows only a
    `0.0.0-stage` placeholder for a while after its first publish;
12. runs `cleanup-keychain.sh` again as a fallback, also after a failure.

A local `npm publish` of the project directory fails: the `prepublishOnly` hook
(`scripts/release/check-publish.mjs`) requires `CI=true` and exactly the release bundle in `bin/`.
npm skips that hook for `npm publish <tarball>` and `--ignore-scripts`, and the release job itself
publishes a tarball. In the release, `verify-npm-pack.sh` is the check that keeps a development
bundle out of the package. Tags with a prerelease version such as `v0.1.0-rc.1` are refused;
candidates come from the release candidate workflow.

## The actions package

`packages/actions/package.json` sets `"private": true`. That field is the gate:
`scripts/release/actions-enabled.sh` prints `false` while it is there and `true` once it is gone,
and every release step for the actions package runs on that output. While the package is private
a tag releases exactly what the list above says, with the same secrets and settings. No step
touches the actions bundle, tarball, `.mcpb` or registry entry. `ci.yml` ignores the gate and always
runs the actions Swift tests, builds the ad-hoc actions bundle, expects `verify-bundle.sh` to reject
it and validates the second manifest.

The gate is read from the tagged commit. Removing `private` after tagging changes nothing for that
tag, also not in a re-run; the actions package then goes out with the next version.

With the gate open, one tag releases both packages at the same version. In addition to the list
above, the run:

- builds `packages/actions/bin/Mail MCP Actions.app` with the release bundle id, before the keychain
  is removed, with the same Developer ID identity;
- notarizes it and verifies it with the requirement from `packages/actions/src/bundle.ts`;
- packs its tarball, which holds only that bundle under `bin/`;
- builds `apple-mail-actions-mcp-<version>.mcpb`, which runs without npm: it holds both notarized
  bundles and the read package's Node code, the helper in
  `node_modules/@redpop/apple-mail-mcp/bin/`, where `packagedHelperBundle()` looks. Both CDHashes are
  checked in the unpacked copy. The read package comes from the same run, not from npm;
- attests `mail-actions.zip` and that `.mcpb`.

The publish order is fixed: the read package to npm and GitHub, then the actions package to npm and
as further assets of the same GitHub release (`publish.sh --actions`: the `.mcpb`,
`mail-actions.zip` and `SHA256SUMS-actions`), then the registry entry of the read package, then
`publish-registry.sh --package actions`. The release candidate workflow builds and verifies both
bundles when the gate is open, uploads the actions files as a second artifact and still publishes
nothing.

### What the maintainer does once, to open the gate

1. **Open point, to check before anything else: the first publish of the new npm name.** Trusted
   publishing is set up per package, and a package may have to exist on npm before a trusted
   publisher can be added to it. This was not verified for `@redpop/apple-mail-actions-mcp`. The
   release workflow passes no npm token, so without a trusted publisher the actions publish fails
   after the read package is already out. Find out what npm requires at that moment, also given
   the token changes described under [First publish to npm](#first-publish-to-npm), and decide how
   the name comes into existence. A workflow change for this is not prepared.
2. Add the repository and `release.yml` as a trusted publisher for the new name. The expiry rule
   under [First publish to npm](#first-publish-to-npm) applies to it too.
3. Remove `"private": true` from `packages/actions/package.json` in a normal PR.
4. Run the release candidate workflow from `main` and check it on a Mac: first Automation grant of
   the actions bundle, update from one candidate to the next keeps the grant, both bundles work
   from the actions `.mcpb`.

No new secret, environment setting or tag ruleset is needed.

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
3. Bump the version and push the tag (the maintainer, or an agent asked to "release x.y.z"):

   ```bash
   npm version 0.1.0
   git push --follow-tags
   ```

   The `version` hook runs `scripts/sync-versions.mjs`, which writes the version to
   `server.json`, `manifest.json` and the Swift source, and stages them for the version commit;
   it does the same for the files of `packages/actions`.
   The plugin is not part of it; see below.
4. Approve the run in the `release` environment.

### The plugin follows npm after seven days

The plugin starts the package with `npx`, pinned to one exact version, and the marketplace in
`.claude-plugin/marketplace.json` serves it from `main`. Many users set an npm release cooldown
(`min-release-age`); npm then refuses a version younger than that, and `npx` does not fall back
to an older one. A pin to a fresh release would break the plugin for them until the cooldown
ends. We do not lift the user's cooldown.

So the pin trails npm. `.github/workflows/plugin-pin.yml` runs daily, takes the highest stable
version that is at least seven days old (`scripts/plugin-pin.mjs next`), pins it with the
settings and environment of `manifest.json` at that version's tag (`scripts/plugin-pin.mjs
apply`), runs `tests/plugin.test.ts` and opens a PR `plugin-pin/v<version>`. Merge it. The plugin
in `packages/actions/plugin` is pinned the same way (`--package actions`, manifest
`packages/actions/manifest.json`), in its own job and PR `plugin-pin/actions-v<version>`; a
package that npm does not know yet is skipped. A PR
opened with the workflow token does not start `ci.yml`; close and reopen it to run the full CI.
For an urgent fix, run the workflow by hand with `min_days` set to `0`.

The workflow needs "Allow GitHub Actions to create and approve pull requests" under Settings →
Actions → General.

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

Re-run the failed job, never a new tag for the same fix. A re-run builds and signs again, so its files differ byte for byte from
the first run's. `publish.sh` therefore never replaces anything that was published:

- a version already on npm is skipped;
- an existing GitHub release without assets gets all of them; one with all assets stays as it is;
- an existing release with only some assets stops the run. Delete those assets from the release
  and re-run, so that the zip, the `.mcpb` and `SHA256SUMS` come from one build.

If only an MCP Registry step failed, run the **MCP Registry** workflow (`registry.yml`) on the
tag. It downloads the released `.mcpb`, computes its checksum and publishes `server.json`; it
builds and publishes nothing else. Its `package` input chooses the entry, `read` or `actions`, and
`actions` is refused while the package is private. If the read entry failed, the actions entry did
not run either, so run the workflow once for each.

### Retry when the actions publish fails

The read package is published first, and nothing retries automatically. If the actions publish
fails, the run ends red with the read package on npm and on the GitHub release, and neither
registry entry published. To finish without publishing the read package again:

1. Fix the cause, for example a missing trusted publisher.
2. If the release shows some of the actions assets but not all, delete those from the release:
   `apple-mail-actions-mcp-<version>.mcpb`, `mail-actions.zip`, `SHA256SUMS-actions`. The read
   assets stay.
3. Re-run the failed job on the same tag and approve it. It builds and signs again.
   `publish.sh` skips the read package on npm and leaves its complete assets alone, then publishes
   the actions package. The registry steps take each checksum from the released `.mcpb`, not
   from the rebuilt one.

A re-run works from the tagged commit. A cause that needs a change in the repository needs a new
version instead, which also publishes a new version of the read package.
