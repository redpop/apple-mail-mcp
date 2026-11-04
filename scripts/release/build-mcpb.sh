#!/bin/bash
# Baut ein .mcpb nach Spec 16.2 Schritt 8 und prueft es nach Schritt 9: entpackt, ausfuehrbar,
# gueltig signiert, gleicher CDHash wie das gepruefte Bundle, kein anderes Bundle unter bin/.
#
# Lesepaket (.): bin/Mail MCP Helper.app, wie bisher.
# Actions-Paket (packages/actions): laeuft ohne npm, enthaelt also neben bin/Mail MCP Actions.app auch
# das Lesepaket unter node_modules/@redpop/apple-mail-mcp mit dessen Bundle. Dort findet es
# packagedHelperBundle(), und dorthin loest der Import des Actions-Pakets auf. Das Lesepaket kommt aus
# diesem Lauf, nicht von npm: Es ist beim Bauen noch nicht veroeffentlicht, ein Kandidat wird es nie.
#
# Braucht MCPB_VERSION (im Workflow gepinnt), dist/ (npm run build) und die Bundles.
# Aufruf: build-mcpb.sh . <helper-cdhash>
#         build-mcpb.sh packages/actions <actions-cdhash> <helper-cdhash>
# Schreibt nach $RUNNER_TEMP/out und gibt den Pfad des .mcpb auf stdout aus.
set -euo pipefail

usage() {
  echo "usage: build-mcpb.sh . <helper-cdhash>" >&2
  echo "       build-mcpb.sh packages/actions <actions-cdhash> <helper-cdhash>" >&2
  exit 2
}
[ $# -ge 2 ] || usage
PACKAGE_DIR="$1"
shift
READ_COPY="node_modules/@redpop/apple-mail-mcp"
HELPER_APP="Mail MCP Helper.app"
ACTIONS_APP="Mail MCP Actions.app"
case "$PACKAGE_DIR" in
  .)
    [ $# -eq 1 ] || usage
    NAME="apple-mail-mcp"
    APPS=("bin/$HELPER_APP")
    EXES=(mail-helper) ;;
  packages/actions)
    [ $# -eq 2 ] || usage
    NAME="apple-mail-actions-mcp"
    APPS=("bin/$ACTIONS_APP" "$READ_COPY/bin/$HELPER_APP")
    EXES=(mail-actions mail-helper) ;;
  *) usage ;;
esac
HASHES=("$@")
for hash in "${HASHES[@]}"; do [ -n "$hash" ] || usage; done

SCRIPT_DIR="$(cd "$(/usr/bin/dirname "${BASH_SOURCE[0]}")" && /bin/pwd)"
ROOT="$(cd "$SCRIPT_DIR/../.." && /bin/pwd)"
"$SCRIPT_DIR/require-env.sh" MCPB_VERSION

VERSION="$(node -p "require('$ROOT/package.json').version")"
TEMP_BASE="${RUNNER_TEMP:-$(/usr/bin/mktemp -d)}"
OUT_DIR="$TEMP_BASE/out"
STAGING="$TEMP_BASE/mcpb"
UNPACK="$(/usr/bin/mktemp -d "$TEMP_BASE/mcpb-unpack.XXXXXX")"
trap '/bin/rm -rf "$UNPACK"' EXIT
SOURCE="$ROOT/$PACKAGE_DIR"

# --- Staging: nur, was zur Laufzeit gebraucht wird; die Bundles per ditto (Signatur, Rechte) ---
/bin/rm -rf "$STAGING"
/bin/mkdir -p "$STAGING/bin"
/usr/bin/ditto "$SOURCE/dist" "$STAGING/dist"
/usr/bin/ditto "$SOURCE/${APPS[0]}" "$STAGING/${APPS[0]}"
for f in manifest.json icon.png README.md LICENSE SECURITY.md; do
  /bin/cp "$SOURCE/$f" "$STAGING/$f"
done
# Die Abhaengigkeiten kommen immer aus dem package-lock.json der Wurzel und dem package.json des
# Lesepakets: Sie schliessen die des Actions-Pakets ein, das Lesepaket selbst aber nicht.
/bin/cp "$ROOT/package.json" "$ROOT/package-lock.json" "$STAGING/"
(cd "$STAGING" && npm ci --omit=dev --ignore-scripts --no-audit --no-fund >&2)

if [ "$PACKAGE_DIR" = "packages/actions" ]; then
  /bin/cp "$SOURCE/package.json" "$STAGING/package.json"
  /bin/rm -f "$STAGING/package-lock.json"
  /bin/mkdir -p "$STAGING/$READ_COPY/bin"
  /usr/bin/ditto "$ROOT/dist" "$STAGING/$READ_COPY/dist"
  /usr/bin/ditto "$ROOT/bin/$HELPER_APP" "$STAGING/$READ_COPY/bin/$HELPER_APP"
  for f in package.json README.md LICENSE SECURITY.md; do
    /bin/cp "$ROOT/$f" "$STAGING/$READ_COPY/$f"
  done
  # Ein npm ci ohne eine Abhaengigkeit des Actions-Pakets fiele sonst erst beim Nutzer auf.
  STAGING="$STAGING" node -e '
    const { existsSync, readFileSync } = require("node:fs")
    const root = process.env.STAGING
    const deps = Object.keys(JSON.parse(readFileSync(`${root}/package.json`, "utf8")).dependencies ?? {})
    const missing = deps.filter((d) => !existsSync(`${root}/node_modules/${d}/package.json`))
    if (missing.length > 0) { console.error(`build-mcpb: dependencies missing from the staged package: ${missing.join(", ")}`); process.exit(1) }
  '
fi

/bin/mkdir -p "$OUT_DIR"
MCPB="$(cd "$OUT_DIR" && /bin/pwd)/$NAME-$VERSION.mcpb"
/bin/rm -f "$MCPB"
npx -y "@anthropic-ai/mcpb@$MCPB_VERSION" pack "$STAGING" "$MCPB" >&2

# --- Pruefen am entpackten Archiv ---
# unzip statt ditto: mcpb speichert die Rechte ohne Dateityp-Bits ("?rwxr-xr-x"), ditto verwirft sie
# dann und das Executable verliert das x-Bit. unzip uebernimmt sie, wie die Entpacker der Clients.
/usr/bin/unzip -q "$MCPB" -d "$UNPACK"
# Zweite Kopie mit mcpb unpack, das die gespeicherten Rechte per chmod setzt wie die Clients.
MCPB_UNPACK="$(/usr/bin/mktemp -d "$TEMP_BASE/mcpb-cli-unpack.XXXXXX")"
npx -y "@anthropic-ai/mcpb@$MCPB_VERSION" unpack "$MCPB" "$MCPB_UNPACK" >&2
FAILED=0
for i in "${!APPS[@]}"; do
  APP="${APPS[$i]}"
  EXE="${EXES[$i]}"
  EXPECTED_CDHASH="${HASHES[$i]}"
  COPY="$UNPACK/$APP"
  [ -x "$COPY/Contents/MacOS/$EXE" ] || { echo "build-mcpb: unpacked executable of $APP is not executable" >&2; FAILED=1; }
  /usr/bin/codesign --verify --strict --deep "$COPY" 2>/dev/null || { echo "build-mcpb: unpacked $APP fails codesign --verify --strict --deep" >&2; FAILED=1; }
  CDHASH="$(/usr/bin/codesign -dvvv "$COPY" 2>&1 | /usr/bin/sed -n 's/^CDHash=//p')"
  [ "$CDHASH" = "$EXPECTED_CDHASH" ] || { echo "build-mcpb: unpacked CDHash of $APP '$CDHASH' differs from '$EXPECTED_CDHASH'" >&2; FAILED=1; }
  [ -x "$MCPB_UNPACK/$APP/Contents/MacOS/$EXE" ] || { echo "build-mcpb: executable of $APP unpacked by mcpb unpack is not executable" >&2; FAILED=1; }
  BIN_DIR="$(/usr/bin/dirname "$COPY")"
  OTHERS="$(/bin/ls -A "$BIN_DIR" | /usr/bin/grep -vxF "$(/usr/bin/basename "$APP")" || true)"
  [ -z "$OTHERS" ] || { echo "build-mcpb: unexpected entries beside $APP: $OTHERS" >&2; FAILED=1; }
done
/bin/rm -rf "$MCPB_UNPACK"
[ "$FAILED" -eq 0 ] || exit 1

echo "$MCPB"
