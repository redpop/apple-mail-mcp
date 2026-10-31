#!/bin/bash
# Baut den Helper universal (arm64 + x86_64) und verpackt ihn als signiertes .app-Bundle in bin/.
# Bundle-ID und Name richten sich nach der Signaturart (Spec 13.1):
#   Developer ID Application -> Release-ID, nur mit CI=true
#   Apple Development        -> ...mail-helper.dev,   "Mail MCP Helper (Dev)"
#   ad hoc ("-")             -> ...mail-helper.adhoc, "Mail MCP Helper (Ad hoc)"
# Identitaet: $CODESIGN_IDENTITY, sonst die erste "Apple Development", sonst ad hoc.
# Die letzte Ausgabezeile ist der Bundle-Pfad.
set -euo pipefail

SCRIPT_DIR="$(cd "$(/usr/bin/dirname "${BASH_SOURCE[0]}")" && /bin/pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && /bin/pwd)"
BIN_DIR="$ROOT/bin"

# Dieselben Literale wie in src/signing.ts (tests/signing.test.ts prueft die Uebereinstimmung).
TEAM_ID="4KTGF63CD2"
RELEASE_BUNDLE_ID="io.github.redpop.apple-mail-mcp.mail-helper"
DEV_BUNDLE_ID="io.github.redpop.apple-mail-mcp.mail-helper.dev"
ADHOC_BUNDLE_ID="io.github.redpop.apple-mail-mcp.mail-helper.adhoc"

# --- Identitaet und Art bestimmen (vor jedem Build, damit ein Abbruch nichts anfasst) ---
IDENTITY="${CODESIGN_IDENTITY:-}"
if [ -z "$IDENTITY" ]; then
  IDENTITY="$(/usr/bin/security find-identity -v -p codesigning 2>/dev/null \
    | /usr/bin/grep '"Apple Development' | /usr/bin/head -n 1 \
    | /usr/bin/sed -E 's/.*"(.*)".*/\1/' || true)"
fi
if [ -z "$IDENTITY" ]; then
  # Rueckfall auf ad hoc nur mit Hinweis (Spec 13.3): das Bundle bekommt eine eigene, schwaechere Identitaet.
  echo "build.sh: warning: no Apple Development identity found, signing ad hoc ($ADHOC_BUNDLE_ID). Full Disk Access granted to a development build does not apply to it; set CODESIGN_IDENTITY to choose an identity." >&2
  IDENTITY="-"
fi

case "$IDENTITY" in
  "Developer ID Application:"*)
    if [ "${CI:-}" != "true" ]; then
      echo "build.sh: the release bundle id is only built in CI (CI=true); use an Apple Development identity or ad hoc locally." >&2
      exit 1
    fi
    BUNDLE_ID="$RELEASE_BUNDLE_ID"; NAME="Mail MCP Helper"; SIGN_FLAGS=(--options runtime) ;;
  "Apple Development:"*)
    BUNDLE_ID="$DEV_BUNDLE_ID"; NAME="Mail MCP Helper (Dev)"; SIGN_FLAGS=(--options runtime) ;;
  "-")
    BUNDLE_ID="$ADHOC_BUNDLE_ID"; NAME="Mail MCP Helper (Ad hoc)"; SIGN_FLAGS=() ;;
  *)
    echo "build.sh: unsupported signing identity '$IDENTITY' (expected Developer ID Application, Apple Development or -)." >&2
    exit 1 ;;
esac

# --- Version aus package.json in den Swift-Quelltext ---
VERSION="$(/usr/bin/plutil -extract version raw -o - "$ROOT/package.json")"
VERSION_FILE="$SCRIPT_DIR/Sources/MailHelperCore/Version.generated.swift"
VERSION_BODY="// Von swift/build.sh aus package.json erzeugt. Bewusst eingecheckt (mit dem aktuellen Wert),
// damit \`swift test\` ohne build.sh kompiliert; build.sh schreibt die Datei nur, wenn sich der Wert aendert.
public let helperVersion = \"$VERSION\""
if [ "$(/bin/cat "$VERSION_FILE" 2>/dev/null || true)" != "$VERSION_BODY" ]; then
  printf '%s\n' "$VERSION_BODY" >"$VERSION_FILE"
fi

# --- Universal bauen: je Architektur einzeln, dann lipo ---
export MACOSX_DEPLOYMENT_TARGET="14.0"
SLICE_DIR="$(/usr/bin/mktemp -d)"
trap '/bin/rm -rf "$SLICE_DIR"' EXIT
for arch in arm64 x86_64; do
  /usr/bin/xcrun swift build --package-path "$SCRIPT_DIR" -c release --arch "$arch" --scratch-path "$SCRIPT_DIR/.build/$arch" >&2
  BIN_PATH="$(/usr/bin/xcrun swift build --package-path "$SCRIPT_DIR" -c release --arch "$arch" --scratch-path "$SCRIPT_DIR/.build/$arch" --show-bin-path)"
  /bin/cp "$BIN_PATH/mail-helper" "$SLICE_DIR/mail-helper-$arch"
done

# --- Bundle zusammensetzen; das alte Bundle derselben Art vorher entfernen ---
BUNDLE="$BIN_DIR/$NAME.app"
/bin/rm -rf "$BUNDLE"
/bin/mkdir -p "$BUNDLE/Contents/MacOS" "$BUNDLE/Contents/Resources"
/usr/bin/lipo -create "$SLICE_DIR/mail-helper-arm64" "$SLICE_DIR/mail-helper-x86_64" -output "$BUNDLE/Contents/MacOS/mail-helper"
/usr/bin/sed -e "s|@BUNDLE_ID@|$BUNDLE_ID|g" -e "s|@NAME@|$NAME|g" -e "s|@VERSION@|$VERSION|g" \
  "$SCRIPT_DIR/Bundle/Info.plist.in" >"$BUNDLE/Contents/Info.plist"
/usr/bin/plutil -lint "$BUNDLE/Contents/Info.plist" >&2
/bin/cp "$SCRIPT_DIR/Bundle/AppIcon.icns" "$BUNDLE/Contents/Resources/AppIcon.icns"

# --- Signieren: das ganze Bundle, damit Info.plist und Ressourcen in der Signatur stehen ---
/usr/bin/codesign --sign "$IDENTITY" ${SIGN_FLAGS[@]+"${SIGN_FLAGS[@]}"} --force "$BUNDLE" >&2

echo "$BUNDLE"
