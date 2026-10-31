#!/bin/bash
# Baut das .mcpb nach Spec 16.2 Schritt 8 und prueft es nach Schritt 9: entpackt, ausfuehrbar,
# gueltig signiert, gleicher CDHash wie das gepruefte Bundle, kein anderes Bundle unter bin/.
# Braucht MCPB_VERSION (im Workflow gepinnt), dist/ (npm run build) und bin/Mail MCP Helper.app.
# Aufruf: build-mcpb.sh <expected-cdhash> <out-dir>; gibt den Pfad des .mcpb auf stdout aus.
set -euo pipefail

if [ $# -ne 2 ] || [ -z "$1" ]; then
  echo "usage: build-mcpb.sh <expected-cdhash> <out-dir>" >&2
  exit 2
fi
EXPECTED_CDHASH="$1"
OUT_DIR="$2"
SCRIPT_DIR="$(cd "$(/usr/bin/dirname "${BASH_SOURCE[0]}")" && /bin/pwd)"
ROOT="$(cd "$SCRIPT_DIR/../.." && /bin/pwd)"
"$SCRIPT_DIR/require-env.sh" MCPB_VERSION
APP_NAME="Mail MCP Helper.app"

VERSION="$(node -p "require('$ROOT/package.json').version")"
TEMP_BASE="${RUNNER_TEMP:-$(/usr/bin/mktemp -d)}"
STAGING="$TEMP_BASE/mcpb"
UNPACK="$(/usr/bin/mktemp -d "$TEMP_BASE/mcpb-unpack.XXXXXX")"
trap '/bin/rm -rf "$UNPACK"' EXIT

# --- Staging: nur, was zur Laufzeit gebraucht wird; das Bundle per ditto (Signatur, Rechte) ---
/bin/rm -rf "$STAGING"
/bin/mkdir -p "$STAGING/bin"
/usr/bin/ditto "$ROOT/dist" "$STAGING/dist"
/usr/bin/ditto "$ROOT/bin/$APP_NAME" "$STAGING/bin/$APP_NAME"
for f in manifest.json icon.png package.json package-lock.json README.md LICENSE SECURITY.md; do
  /bin/cp "$ROOT/$f" "$STAGING/$f"
done
(cd "$STAGING" && npm ci --omit=dev --ignore-scripts --no-audit --no-fund >&2)

/bin/mkdir -p "$OUT_DIR"
MCPB="$(cd "$OUT_DIR" && /bin/pwd)/apple-mail-mcp-$VERSION.mcpb"
/bin/rm -f "$MCPB"
npx -y "@anthropic-ai/mcpb@$MCPB_VERSION" pack "$STAGING" "$MCPB" >&2

# --- Pruefen am entpackten Archiv ---
# unzip statt ditto: mcpb speichert die Rechte ohne Dateityp-Bits ("?rwxr-xr-x"), ditto verwirft sie
# dann und das Executable verliert das x-Bit. unzip uebernimmt sie, wie die Entpacker der Clients.
/usr/bin/unzip -q "$MCPB" -d "$UNPACK"
COPY="$UNPACK/bin/$APP_NAME"
FAILED=0
[ -x "$COPY/Contents/MacOS/mail-helper" ] || { echo "build-mcpb: unpacked executable is not executable" >&2; FAILED=1; }
/usr/bin/codesign --verify --strict --deep "$COPY" 2>/dev/null || { echo "build-mcpb: unpacked bundle fails codesign --verify --strict --deep" >&2; FAILED=1; }
CDHASH="$(/usr/bin/codesign -dvvv "$COPY" 2>&1 | /usr/bin/sed -n 's/^CDHash=//p')"
[ "$CDHASH" = "$EXPECTED_CDHASH" ] || { echo "build-mcpb: unpacked CDHash '$CDHASH' differs from '$EXPECTED_CDHASH'" >&2; FAILED=1; }
# Zweite Kopie mit mcpb unpack, das die gespeicherten Rechte per chmod setzt wie die Clients.
MCPB_UNPACK="$(/usr/bin/mktemp -d "$TEMP_BASE/mcpb-cli-unpack.XXXXXX")"
npx -y "@anthropic-ai/mcpb@$MCPB_VERSION" unpack "$MCPB" "$MCPB_UNPACK" >&2
[ -x "$MCPB_UNPACK/bin/$APP_NAME/Contents/MacOS/mail-helper" ] || { echo "build-mcpb: executable unpacked by mcpb unpack is not executable" >&2; FAILED=1; }
/bin/rm -rf "$MCPB_UNPACK"
OTHERS="$(/bin/ls -A "$UNPACK/bin" | /usr/bin/grep -vxF "$APP_NAME" || true)"
[ -z "$OTHERS" ] || { echo "build-mcpb: unexpected entries under bin/: $OTHERS" >&2; FAILED=1; }
[ "$FAILED" -eq 0 ] || exit 1

echo "$MCPB"
