#!/bin/bash
# Notarisiert und stapelt ein Bundle mit dem App-Store-Connect-API-Key (Spec 16.2 Schritt 5, D4).
# Die .p8 liegt nur waehrend dieses Skripts in $RUNNER_TEMP (umask 077) und wird per trap geloescht.
# Aufruf: notarize.sh <bundle> <zip-out>; <zip-out> wird aus dem gestapelten Bundle gepackt.
set -euo pipefail

if [ $# -ne 2 ]; then
  echo "usage: notarize.sh <bundle> <zip-out>" >&2
  exit 2
fi
BUNDLE="$1"
ZIP_OUT="$2"

SCRIPT_DIR="$(cd "$(/usr/bin/dirname "${BASH_SOURCE[0]}")" && /bin/pwd)"
"$SCRIPT_DIR/require-env.sh" APPLE_API_KEY_BASE64 APPLE_API_KEY_ID APPLE_API_ISSUER_ID RUNNER_TEMP

P8="$RUNNER_TEMP/AuthKey-$$.p8"
WORK="$(/usr/bin/mktemp -d "$RUNNER_TEMP/notarize.XXXXXX")"
trap '/bin/rm -f "$P8"; /bin/rm -rf "$WORK"' EXIT

(umask 077 && printf '%s' "$APPLE_API_KEY_BASE64" | /usr/bin/base64 --decode >"$P8")
AUTH=(--key "$P8" --key-id "$APPLE_API_KEY_ID" --issuer "$APPLE_API_ISSUER_ID")

/usr/bin/ditto -c -k --keepParent "$BUNDLE" "$WORK/submit.zip"
# notarytool endet bei "Invalid" je nach Version mit oder ohne Fehlercode; entscheidend ist der Status.
RESULT="$(/usr/bin/xcrun notarytool submit "$WORK/submit.zip" "${AUTH[@]}" --wait --output-format json || true)"
STATUS="$(printf '%s' "$RESULT" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{process.stdout.write(String(JSON.parse(s).status??""))}catch{}})')"
SUBMISSION="$(printf '%s' "$RESULT" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{process.stdout.write(String(JSON.parse(s).id??""))}catch{}})')"

if [ "$STATUS" != "Accepted" ]; then
  echo "notarize: submission ${SUBMISSION:-<none>} ended with status '${STATUS:-unknown}'." >&2
  if [ -n "$SUBMISSION" ]; then
    /usr/bin/xcrun notarytool log "$SUBMISSION" "${AUTH[@]}" >&2 || true
  else
    printf '%s\n' "$RESULT" >&2
  fi
  exit 1
fi

/usr/bin/xcrun stapler staple "$BUNDLE"
/bin/rm -f "$ZIP_OUT"
/usr/bin/ditto -c -k --keepParent "$BUNDLE" "$ZIP_OUT"
echo "Notarized and stapled $BUNDLE (submission $SUBMISSION)."
