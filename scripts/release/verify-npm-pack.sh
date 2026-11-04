#!/bin/bash
# Prueft das npm-Paket nach Spec 16.2 Schritt 7: erst die Dateiliste (Release-Bundle vollstaendig,
# sonst nichts unter bin/), dann das echte Tarball entpackt, weil npm Dateirechte neu setzt:
# ausfuehrbar, gueltig signiert, gleicher CDHash wie das gepruefte Bundle.
# Das Lesepaket enthaelt nichts vom Actions-Paket; das Actions-Paket unter bin/ nur sein eigenes Bundle.
# Aufruf: verify-npm-pack.sh <expected-cdhash> [package-dir]; ohne package-dir das Lesepaket im
# aktuellen Verzeichnis. Gibt den Pfad des Tarballs auf stdout aus.
set -euo pipefail

if [ $# -lt 1 ] || [ $# -gt 2 ] || [ -z "$1" ]; then
  echo "usage: verify-npm-pack.sh <expected-cdhash> [package-dir]" >&2
  exit 2
fi
EXPECTED_CDHASH="$1"
case "${2:-.}" in
  .) APP="bin/Mail MCP Helper.app"; EXE="mail-helper"; PACKAGE="read" ;;
  packages/actions) APP="bin/Mail MCP Actions.app"; EXE="mail-actions"; PACKAGE="actions"; cd packages/actions ;;
  *) echo "usage: verify-npm-pack.sh <expected-cdhash> [package-dir]; package-dir is . or packages/actions" >&2; exit 2 ;;
esac
OUT_DIR="${RUNNER_TEMP:-$(/usr/bin/mktemp -d)}"

# --- Dateiliste ---
LISTING="$(npm pack --json --dry-run 2>/dev/null)"
# shellcheck disable=SC2016 # JavaScript-Template-Strings, kein Shell-Ausdruck
printf '%s' "$LISTING" | APP="$APP" EXE="$EXE" PACKAGE="$PACKAGE" node -e '
let s = ""
process.stdin.on("data", (d) => (s += d)).on("end", () => {
  const { APP: app, EXE: exe, PACKAGE: pkg } = process.env
  const files = new Set(JSON.parse(s)[0].files.map((f) => f.path))
  const required = [
    `${app}/Contents/MacOS/${exe}`,
    `${app}/Contents/Info.plist`,
    `${app}/Contents/_CodeSignature/CodeResources`,
    `${app}/Contents/CodeResources`,
    "dist/index.js",
  ]
  let ok = true
  for (const r of required) if (!files.has(r)) { console.error(`verify-npm-pack: missing ${r}`); ok = false }
  for (const f of files) {
    if (f.startsWith("bin/") && !f.startsWith(`${app}/`)) { console.error(`verify-npm-pack: unexpected file under bin/: ${f}`); ok = false }
    if (pkg === "read" && /mail-actions|mail mcp actions|^packages\//i.test(f)) { console.error(`verify-npm-pack: actions file in the read package: ${f}`); ok = false }
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
[ -x "$COPY/Contents/MacOS/$EXE" ] || { echo "verify-npm-pack: unpacked executable is not executable" >&2; FAILED=1; }
/usr/bin/codesign --verify --strict --deep "$COPY" 2>/dev/null || { echo "verify-npm-pack: unpacked bundle fails codesign --verify --strict --deep" >&2; FAILED=1; }
CDHASH="$(/usr/bin/codesign -dvvv "$COPY" 2>&1 | /usr/bin/sed -n 's/^CDHash=//p')"
[ "$CDHASH" = "$EXPECTED_CDHASH" ] || { echo "verify-npm-pack: unpacked CDHash '$CDHASH' differs from '$EXPECTED_CDHASH'" >&2; FAILED=1; }
[ "$FAILED" -eq 0 ] || exit 1

echo "$TARBALL"
