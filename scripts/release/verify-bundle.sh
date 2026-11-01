#!/bin/bash
# Prueft das Release-Bundle nach Spec 16.2 Schritt 6, bevor es in npm-Paket und MCPB geht.
# Alle Pruefungen laufen; jede fehlgeschlagene meldet "verify-bundle: <check> failed" auf stderr.
# Bei Erfolg steht der CDHash auf stdout (fuer den Vergleich mit den entpackten Kopien).
# Die Requirement kommt aus dist/signing.js (vorher npm run build), damit sie nur in src/signing.ts steht.
# Aufruf: verify-bundle.sh <bundle>
set -euo pipefail

if [ $# -ne 1 ]; then
  echo "usage: verify-bundle.sh <bundle>" >&2
  exit 2
fi
BUNDLE="$1"
EXE="$BUNDLE/Contents/MacOS/mail-helper"
SCRIPT_DIR="$(cd "$(/usr/bin/dirname "${BASH_SOURCE[0]}")" && /bin/pwd)"
ROOT="$(cd "$SCRIPT_DIR/../.." && /bin/pwd)"

FAILED=0
fail() {
  echo "verify-bundle: $1 failed" >&2
  FAILED=1
}

REQUIREMENT="$(node -p "require('$ROOT/dist/signing.js').RELEASE_REQUIREMENT" 2>/dev/null || true)"
[ -n "$REQUIREMENT" ] || fail "reading RELEASE_REQUIREMENT from dist/signing.js (run npm run build)"

ARCHS="$(/usr/bin/lipo -archs "$EXE" 2>/dev/null || true)"
case " $ARCHS " in *" arm64 "*) ;; *) fail "lipo (arm64)" ;; esac
case " $ARCHS " in *" x86_64 "*) ;; *) fail "lipo (x86_64)" ;; esac

INFO="$(/usr/bin/codesign -dv --verbose=2 "$BUNDLE" 2>&1 || true)"
printf '%s\n' "$INFO" | /usr/bin/grep -qx 'Identifier=io.github.redpop.apple-mail-mcp.mail-helper' || fail "Identifier"
printf '%s\n' "$INFO" | /usr/bin/grep -q '^Authority=Developer ID Application:' || fail "Authority"
printf '%s\n' "$INFO" | /usr/bin/grep -qx 'TeamIdentifier=4KTGF63CD2' || fail "TeamIdentifier"
printf '%s\n' "$INFO" | /usr/bin/grep -q 'flags=0x10000(runtime)' || fail "hardened runtime flag"

/usr/bin/codesign --verify --strict --deep "$BUNDLE" 2>/dev/null || fail "codesign --verify --strict --deep"
if [ -n "$REQUIREMENT" ]; then
  /usr/bin/codesign --verify -R="$REQUIREMENT" "$BUNDLE" 2>/dev/null || fail "release requirement"
fi
/usr/bin/xcrun stapler validate "$BUNDLE" >/dev/null 2>&1 || fail "stapler validate"
/usr/sbin/spctl -a -vv -t exec "$BUNDLE" 2>&1 | /usr/bin/grep -q 'source=Notarized Developer ID' || fail "spctl (Notarized Developer ID)"
[ -z "$(/usr/bin/find "$BUNDLE" -type l)" ] || fail "no symlinks"

if [ "$FAILED" -ne 0 ]; then
  exit 1
fi
/usr/bin/codesign -dvvv "$BUNDLE" 2>&1 | /usr/bin/sed -n 's/^CDHash=//p'
