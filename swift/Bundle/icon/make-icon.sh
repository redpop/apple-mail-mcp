#!/bin/bash
# Erzeugt swift/Bundle/AppIcon.icns und icon.png (MCPB) neu: PNGs zeichnen, dann iconutil. Ergebnis wird eingecheckt,
# build.sh braucht diesen Schritt nicht.
set -euo pipefail
DIR="$(cd "$(/usr/bin/dirname "${BASH_SOURCE[0]}")" && /bin/pwd)"
/bin/rm -rf "$DIR/AppIcon.iconset"
/usr/bin/xcrun swift "$DIR/render-icon.swift" "$DIR/AppIcon.iconset"
/usr/bin/iconutil -c icns "$DIR/AppIcon.iconset" -o "$DIR/../AppIcon.icns"
# Dasselbe Motiv als Symbol der MCPB-Erweiterung (manifest.json "icon").
/bin/cp "$DIR/AppIcon.iconset/icon_512x512.png" "$DIR/../../../icon.png"
echo "$DIR/../AppIcon.icns"
