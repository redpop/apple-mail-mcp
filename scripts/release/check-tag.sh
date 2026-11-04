#!/bin/bash
# Spec 16.2 Schritt 1: der Tag passt zur Version, sie ist keine Vorabversion, alle Versionsangaben sind synchron, und der
# ausgecheckte Commit (der Tag) liegt auf main. Braucht origin/main (checkout mit fetch-depth: 0).
# Die Versionsangaben: server.json, manifest.json, Swift, dazu vom Actions-Paket package.json mit dem
# exakten Pin des Lesepakets, manifest.json, server.json, Swift und sein Eintrag in package-lock.json.
# Aufruf: check-tag.sh <tag>
set -euo pipefail

if [ $# -ne 1 ]; then
  echo "usage: check-tag.sh <tag>" >&2
  exit 2
fi
TAG="$1"
VERSION="$(node -p "require('./package.json').version")"

if [ "${TAG#v}" != "$VERSION" ]; then
  echo "check-tag: tag $TAG does not match package.json version $VERSION." >&2
  exit 1
fi

# Vorabversionen gehen nur ueber release-candidate.yml: npm publish ohne --tag machte sie zu "latest".
case "$VERSION" in
  *-*)
    echo "check-tag: $VERSION is a prerelease version; use the release candidate workflow instead of a tag." >&2
    exit 1 ;;
esac

# sync-versions.mjs ueberspringt fehlende JSON-Dateien; ohne diese Pruefung fiele das nicht auf.
VERSION_FILES=(server.json manifest.json swift/Sources/MailHelperCore/Version.generated.swift)
if [ -e packages/actions/package.json ]; then
  VERSION_FILES+=(packages/actions/manifest.json packages/actions/server.json packages/actions/swift/Sources/MailActionsCore/Version.generated.swift)
fi
for file in "${VERSION_FILES[@]}"; do
  if [ ! -e "$file" ]; then
    echo "check-tag: version file $file is missing." >&2
    exit 1
  fi
done

node scripts/sync-versions.mjs >/dev/null
# Mit --untracked-files=normal: auch eine Datei, die das Skript erst neu angelegt hat, ist eine Abweichung.
CHANGED="$(/usr/bin/git status --porcelain --untracked-files=normal)"
if [ -n "$CHANGED" ]; then
  echo "check-tag: version files are out of sync with package.json; run node scripts/sync-versions.mjs and commit:" >&2
  printf '%s\n' "$CHANGED" >&2
  exit 1
fi

if ! /usr/bin/git merge-base --is-ancestor HEAD origin/main; then
  echo "check-tag: $TAG ($(/usr/bin/git rev-parse --short HEAD)) is not on main." >&2
  exit 1
fi
echo "Tag $TAG matches version $VERSION and is on main."
