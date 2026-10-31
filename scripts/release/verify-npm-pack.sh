#!/bin/bash
# Prueft das npm-Paket nach Spec 16.2 Schritt 7: erst die Dateiliste (Release-Bundle vollstaendig,
# sonst nichts unter bin/), dann das echte Tarball entpackt, weil npm Dateirechte neu setzt:
# ausfuehrbar, gueltig signiert, gleicher CDHash wie das gepruefte Bundle.
# Aufruf: verify-npm-pack.sh <expected-cdhash>; gibt den Pfad des Tarballs auf stdout aus.
set -euo pipefail

if [ $# -ne 1 ] || [ -z "$1" ]; then
  echo "usage: verify-npm-pack.sh <expected-cdhash>" >&2
  exit 2
fi
EXPECTED_CDHASH="$1"
APP="bin/Mail MCP Helper.app"
OUT_DIR="${RUNNER_TEMP:-$(/usr/bin/mktemp -d)}"

# --- Dateiliste ---
LISTING="$(npm pack --json --dry-run 2>/dev/null)"
# shellcheck disable=SC2016 # JavaScript-Template-Strings, kein Shell-Ausdruck
printf '%s' "$LISTING" | APP="$APP" node -e '
let s = ""
process.stdin.on("data", (d) => (s += d)).on("end", () => {
  const app = process.env.APP
  const files = new Set(JSON.parse(s)[0].files.map((f) => f.path))
  const required = [
    `${app}/Contents/MacOS/mail-helper`,
    `${app}/Contents/Info.plist`,
    `${app}/Contents/_CodeSignature/CodeResources`,
    `${app}/Contents/CodeResources`,
    "dist/index.js",
  ]
  let ok = true
  for (const r of required) if (!files.has(r)) { console.error(`verify-npm-pack: missing ${r}`); ok = false }
  for (const f of files) {
    if (f.startsWith("bin/") && !f.startsWith(`${app}/`)) { console.error(`verify-npm-pack: unexpected file under bin/: ${f}`); ok = false }
  }
  process.exit(ok ? 0 : 1)
})'

# --- Echtes Tarball, entpackt geprueft ---
TARBALL_NAME="$(npm pack --json --pack-destination "$OUT_DIR" 2>/dev/null | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.parse(s)[0].filename))')"
TARBALL="$OUT_DIR/$TARBALL_NAME"
UNPACK="$(/usr/bin/mktemp -d "$OUT_DIR/npm-unpack.XXXXXX")"
trap '/bin/rm -rf "$UNPACK"' EXIT
/usr/bin/tar -xzf "$TARBALL" -C "$UNPACK"
COPY="$UNPACK/package/$APP"

FAILED=0
[ -x "$COPY/Contents/MacOS/mail-helper" ] || { echo "verify-npm-pack: unpacked executable is not executable" >&2; FAILED=1; }
/usr/bin/codesign --verify --strict --deep "$COPY" 2>/dev/null || { echo "verify-npm-pack: unpacked bundle fails codesign --verify --strict --deep" >&2; FAILED=1; }
CDHASH="$(/usr/bin/codesign -dvvv "$COPY" 2>&1 | /usr/bin/sed -n 's/^CDHash=//p')"
[ "$CDHASH" = "$EXPECTED_CDHASH" ] || { echo "verify-npm-pack: unpacked CDHash '$CDHASH' differs from '$EXPECTED_CDHASH'" >&2; FAILED=1; }
[ "$FAILED" -eq 0 ] || exit 1

echo "$TARBALL"
