#!/bin/bash
# Veroeffentlicht npm-Paket und GitHub-Release (Spec 16.2 Schritte 11 und 12).
# Wiederholbar nach einem Teilfehler: eine schon veroeffentlichte npm-Version wird uebersprungen,
# ein schon vorhandenes Release bekommt seine Assets (erneut) hochgeladen statt neu angelegt.
# Aufruf: publish.sh <tarball> <mcpb> <zip>; braucht GH_TOKEN fuer gh.
set -euo pipefail

if [ $# -ne 3 ]; then
  echo "usage: publish.sh <tarball> <mcpb> <zip>" >&2
  exit 2
fi
TARBALL="$1"
MCPB="$2"
ZIP="$3"
VERSION="$(node -p "require('./package.json').version")"
TAG="v$VERSION"

# --- npm ---
PUBLISHED="$(npm view "@redpop/apple-mail-mcp@$VERSION" version 2>/dev/null || true)"
if [ "$PUBLISHED" = "$VERSION" ]; then
  echo "publish: @redpop/apple-mail-mcp@$VERSION is already on npm, skipping npm publish." >&2
else
  npm publish "$TARBALL" --provenance --access public
fi

# --- GitHub-Release mit Pruefsummen ---
ASSETS="$(/usr/bin/mktemp -d "${RUNNER_TEMP:-/tmp}/release-assets.XXXXXX")"
trap '/bin/rm -rf "$ASSETS"' EXIT
/bin/cp "$MCPB" "$ZIP" "$ASSETS/"
(cd "$ASSETS" && /usr/bin/shasum -a 256 "$(/usr/bin/basename "$MCPB")" "$(/usr/bin/basename "$ZIP")" >SHA256SUMS)
FILES=("$ASSETS/$(/usr/bin/basename "$MCPB")" "$ASSETS/$(/usr/bin/basename "$ZIP")" "$ASSETS/SHA256SUMS")

if gh release view "$TAG" >/dev/null 2>&1; then
  echo "publish: release $TAG exists, uploading its assets again." >&2
  gh release upload "$TAG" "${FILES[@]}" --clobber
else
  gh release create "$TAG" --verify-tag --title "$TAG" --generate-notes "${FILES[@]}"
fi
echo "Published $TAG."
