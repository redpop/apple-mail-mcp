#!/bin/bash
# Veroeffentlicht npm-Paket und GitHub-Release (Spec 16.2 Schritte 11 und 12).
# Wiederholbar nach einem Teilfehler: eine schon veroeffentlichte npm-Version wird uebersprungen.
# Ein vorhandenes Release wird nie ueberschrieben: leer bekommt es alle Assets, vollstaendig bleibt
# es, wie es ist, teilweise gefuellt bricht das Skript ab. Ein Re-Run baut neu, also mit anderen
# Bytes; Pruefsummen, Attestation und Registry-Eintrag gehoeren aber zu den Assets des ersten Laufs.
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

NAMES=("$(/usr/bin/basename "$MCPB")" "$(/usr/bin/basename "$ZIP")" SHA256SUMS)
if EXISTING="$(gh release view "$TAG" --json assets --jq '.assets[].name' 2>/dev/null)"; then
  PRESENT=0
  for name in "${NAMES[@]}"; do
    if printf '%s\n' "$EXISTING" | /usr/bin/grep -qxF "$name"; then PRESENT=$((PRESENT + 1)); fi
  done
  if [ "$PRESENT" -eq "${#NAMES[@]}" ]; then
    echo "publish: release $TAG already has all assets, leaving it unchanged." >&2
  elif [ "$PRESENT" -eq 0 ]; then
    echo "publish: release $TAG exists without assets, uploading them." >&2
    gh release upload "$TAG" "${FILES[@]}"
  else
    echo "publish: release $TAG has some assets but not all; delete them from the release and re-run, so that all assets come from one build." >&2
    exit 1
  fi
else
  gh release create "$TAG" --verify-tag --title "$TAG" --generate-notes "${FILES[@]}"
fi
echo "Published $TAG."
