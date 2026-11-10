#!/bin/bash
# Prueft das Release-Bundle nach Spec 16.2 Schritt 6, bevor es in npm-Paket und MCPB geht.
# Alle Pruefungen laufen; jede fehlgeschlagene meldet "verify-bundle: <check> failed" auf stderr.
# Bei Erfolg steht der CDHash auf stdout (fuer den Vergleich mit den entpackten Kopien).
# Die Requirement kommt vom Aufrufer, aus dist/ des jeweiligen Pakets (vorher bauen), damit sie nur in
# src/signing.ts und packages/actions/src/bundle.ts steht. Daraus stammt auch der erwartete Identifier;
# das Executable nennt das Info.plist des Bundles.
# Aufruf: verify-bundle.sh <bundle> <requirement>
set -euo pipefail

if [ $# -ne 2 ]; then
  echo "usage: verify-bundle.sh <bundle> <requirement>" >&2
  exit 2
fi
BUNDLE="$1"
REQUIREMENT="$2"
EXE="$BUNDLE/Contents/MacOS/$(/usr/bin/plutil -extract CFBundleExecutable raw -o - "$BUNDLE/Contents/Info.plist" 2>/dev/null || true)"

FAILED=0
fail() {
  echo "verify-bundle: $1 failed" >&2
  FAILED=1
}

IDENTIFIER="$(printf '%s' "$REQUIREMENT" | /usr/bin/sed -nE 's/^identifier "([^"]+)".*/\1/p')"
[ -n "$IDENTIFIER" ] || fail "reading the identifier from the requirement"

ARCHS="$(/usr/bin/lipo -archs "$EXE" 2>/dev/null || true)"
case " $ARCHS " in *" arm64 "*) ;; *) fail "lipo (arm64)" ;; esac
case " $ARCHS " in *" x86_64 "*) ;; *) fail "lipo (x86_64)" ;; esac

INFO="$(/usr/bin/codesign -dv --verbose=2 "$BUNDLE" 2>&1 || true)"
printf '%s\n' "$INFO" | /usr/bin/grep -qxF "Identifier=$IDENTIFIER" || fail "Identifier"
printf '%s\n' "$INFO" | /usr/bin/grep -q '^Authority=Developer ID Application:' || fail "Authority"
printf '%s\n' "$INFO" | /usr/bin/grep -qx 'TeamIdentifier=4KTGF63CD2' || fail "TeamIdentifier"
printf '%s\n' "$INFO" | /usr/bin/grep -q 'flags=0x10000(runtime)' || fail "hardened runtime flag"

/usr/bin/codesign --verify --strict --deep "$BUNDLE" 2>/dev/null || fail "codesign --verify --strict --deep"
/usr/bin/codesign --verify -R="$REQUIREMENT" "$BUNDLE" 2>/dev/null || fail "release requirement"
/usr/bin/xcrun stapler validate "$BUNDLE" >/dev/null 2>&1 || fail "stapler validate"
/usr/sbin/spctl -a -vv -t exec "$BUNDLE" 2>&1 | /usr/bin/grep -q 'source=Notarized Developer ID' || fail "spctl (Notarized Developer ID)"
[ -z "$(/usr/bin/find "$BUNDLE" -type l)" ] || fail "no symlinks"

if [ "$FAILED" -ne 0 ]; then
  exit 1
fi
/usr/bin/codesign -dvvv "$BUNDLE" 2>&1 | /usr/bin/sed -n 's/^CDHash=//p'
