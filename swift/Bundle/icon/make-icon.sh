#!/bin/bash
# Erzeugt swift/Bundle/AppIcon.icns neu: PNGs zeichnen, dann iconutil. Ergebnis wird eingecheckt,
# build.sh braucht diesen Schritt nicht.
set -euo pipefail
DIR="$(cd "$(/usr/bin/dirname "${BASH_SOURCE[0]}")" && /bin/pwd)"
/bin/rm -rf "$DIR/AppIcon.iconset"
/usr/bin/xcrun swift "$DIR/render-icon.swift" "$DIR/AppIcon.iconset"
/usr/bin/iconutil -c icns "$DIR/AppIcon.iconset" -o "$DIR/../AppIcon.icns"
echo "$DIR/../AppIcon.icns"
