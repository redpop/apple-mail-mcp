#!/bin/bash
# Baut das Actions-Bundle universal (arm64 + x86_64) und verpackt es als signiertes .app-Bundle in
# packages/actions/bin/. Gegenstueck zu swift/build.sh, aber mit eigenen Bundle-IDs und einer
# Berechtigung (nur Apple Events); die IDs werden nie mit dem Helper geteilt.
#   Developer ID Application -> Release-ID, nur mit CI=true
#   Apple Development        -> ...mail-actions.dev,   "Mail MCP Actions (Dev)"
#   ad hoc ("-")             -> ...mail-actions.adhoc, "Mail MCP Actions (Ad hoc)"
# Identitaet: $CODESIGN_IDENTITY, sonst die erste "Apple Development", sonst ad hoc.
# Die letzte Ausgabezeile ist der Bundle-Pfad.
set -euo pipefail

SCRIPT_DIR="$(cd "$(/usr/bin/dirname "${BASH_SOURCE[0]}")" && /bin/pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && /bin/pwd)"
REPO_ROOT="$(cd "$ROOT/../.." && /bin/pwd)"
BIN_DIR="$ROOT/bin"

TEAM_ID="4KTGF63CD2"
RELEASE_BUNDLE_ID="io.github.redpop.apple-mail-mcp.mail-actions"
DEV_BUNDLE_ID="io.github.redpop.apple-mail-mcp.mail-actions.dev"
ADHOC_BUNDLE_ID="io.github.redpop.apple-mail-mcp.mail-actions.adhoc"

# --- Identitaet und Art bestimmen (vor jedem Build, damit ein Abbruch nichts anfasst) ---
IDENTITY="${CODESIGN_IDENTITY:-}"
if [ -z "$IDENTITY" ]; then
  IDENTITY="$(/usr/bin/security find-identity -v -p codesigning 2>/dev/null \
    | /usr/bin/grep '"Apple Development' | /usr/bin/head -n 1 \
    | /usr/bin/sed -E 's/.*"(.*)".*/\1/' || true)"
fi
if [ -z "$IDENTITY" ]; then
  # Rueckfall auf ad hoc nur mit Hinweis: das Bundle bekommt eine eigene, schwaechere Identitaet.
  echo "build.sh: warning: no Apple Development identity found, signing ad hoc ($ADHOC_BUNDLE_ID). The Automation permission granted to a development build does not apply to it; set CODESIGN_IDENTITY to choose an identity." >&2
  IDENTITY="-"
fi

case "$IDENTITY" in
  "Developer ID Application:"*)
    if [ "${CI:-}" != "true" ]; then
      echo "build.sh: the release bundle id is only built in CI (CI=true); use an Apple Development identity or ad hoc locally." >&2
      exit 1
    fi
    BUNDLE_ID="$RELEASE_BUNDLE_ID"; NAME="Mail MCP Actions"; SIGN_FLAGS=(--options runtime) ;;
  "Apple Development:"*)
    BUNDLE_ID="$DEV_BUNDLE_ID"; NAME="Mail MCP Actions (Dev)"; SIGN_FLAGS=(--options runtime) ;;
  "-")
    BUNDLE_ID="$ADHOC_BUNDLE_ID"; NAME="Mail MCP Actions (Ad hoc)"; SIGN_FLAGS=() ;;
  *)
    echo "build.sh: unsupported signing identity '$IDENTITY' (expected Developer ID Application, Apple Development or -)." >&2
    exit 1 ;;
esac

# --- Version aus dem package.json der Wurzel in den Swift-Quelltext: beide Pakete haben dieselbe Version ---
VERSION="$(/usr/bin/plutil -extract version raw -o - "$REPO_ROOT/package.json")"
VERSION_FILE="$SCRIPT_DIR/Sources/MailActionsCore/Version.generated.swift"
VERSION_BODY="// Von packages/actions/swift/build.sh aus package.json erzeugt. Bewusst eingecheckt (mit dem aktuellen Wert),
// damit \`swift test\` ohne build.sh kompiliert; build.sh schreibt die Datei nur, wenn sich der Wert aendert.
public let helperVersion = \"$VERSION\""
if [ "$(/bin/cat "$VERSION_FILE" 2>/dev/null || true)" != "$VERSION_BODY" ]; then
  printf '%s\n' "$VERSION_BODY" >"$VERSION_FILE"
fi

# --- Universal bauen: je Architektur einzeln, dann lipo ---
export MACOSX_DEPLOYMENT_TARGET="15.0"
SLICE_DIR="$(/usr/bin/mktemp -d)"
trap '/bin/rm -rf "$SLICE_DIR"' EXIT
for arch in arm64 x86_64; do
  /usr/bin/xcrun swift build --package-path "$SCRIPT_DIR" -c release --arch "$arch" --scratch-path "$SCRIPT_DIR/.build/$arch" >&2
  BIN_PATH="$(/usr/bin/xcrun swift build --package-path "$SCRIPT_DIR" -c release --arch "$arch" --scratch-path "$SCRIPT_DIR/.build/$arch" --show-bin-path)"
  /bin/cp "$BIN_PATH/mail-actions" "$SLICE_DIR/mail-actions-$arch"
done

# --- Bundle zusammensetzen; das alte Bundle derselben Art vorher entfernen ---
BUNDLE="$BIN_DIR/$NAME.app"
/bin/rm -rf "$BUNDLE"
/bin/mkdir -p "$BUNDLE/Contents/MacOS" "$BUNDLE/Contents/Resources"
/usr/bin/lipo -create "$SLICE_DIR/mail-actions-arm64" "$SLICE_DIR/mail-actions-x86_64" -output "$BUNDLE/Contents/MacOS/mail-actions"
/usr/bin/sed -e "s|@BUNDLE_ID@|$BUNDLE_ID|g" -e "s|@NAME@|$NAME|g" -e "s|@VERSION@|$VERSION|g" \
  "$SCRIPT_DIR/Bundle/Info.plist.in" >"$BUNDLE/Contents/Info.plist"
/usr/bin/plutil -lint "$BUNDLE/Contents/Info.plist" >&2
# Dasselbe Symbol wie der Helper, ohne eine zweite Binaerdatei im Repository.
/bin/cp "$REPO_ROOT/swift/Bundle/AppIcon.icns" "$BUNDLE/Contents/Resources/AppIcon.icns"

# --- Signieren: das ganze Bundle; die einzige Berechtigung sind Apple Events ---
/usr/bin/codesign --sign "$IDENTITY" ${SIGN_FLAGS[@]+"${SIGN_FLAGS[@]}"} --entitlements "$SCRIPT_DIR/Bundle/entitlements.plist" --force "$BUNDLE" >&2

echo "$BUNDLE"
