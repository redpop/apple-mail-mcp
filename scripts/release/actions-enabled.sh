#!/bin/bash
# Gate fuer jeden Release-Schritt des Actions-Pakets: gibt "true" oder "false" auf stdout aus.
# Solange packages/actions/package.json "private" setzt, veroeffentlicht ein Tag nur das Lesepaket.
# Das Feld entfernt der Maintainer von Hand, wenn das Actions-Paket faellig ist. Fehlt die Datei oder
# ist sie kaputt, endet das Skript mit einem Fehler und raet nicht.
set -euo pipefail

SCRIPT_DIR="$(cd "$(/usr/bin/dirname "${BASH_SOURCE[0]}")" && /bin/pwd)"
ROOT="$(cd "$SCRIPT_DIR/../.." && /bin/pwd)"

# Wie npm: jeder wahre Wert von "private" sperrt das Paket.
node -e '
  const pkg = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"))
  console.log(pkg.private ? "false" : "true")
' "$ROOT/packages/actions/package.json"
