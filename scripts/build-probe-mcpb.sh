#!/bin/bash
# Baut eine Probe-MCPB, deren Server nur scripts/probe-sqlite.mjs ist. Claude Desktop startet sie
# mit derselben Laufzeit wie apple-mail-mcp (gleiche compatibility.runtimes.node), also im
# eingebauten Node des UtilityProcess. Die Probe schreibt eine Zeile auf stderr und endet; Claude
# Desktop meldet danach, dass der Server beendet wurde. Das ist erwartet.
# Aufruf: scripts/build-probe-mcpb.sh <out-dir>; gibt den Pfad des .mcpb auf stdout aus.
set -euo pipefail

if [ $# -ne 1 ]; then
  echo "usage: build-probe-mcpb.sh <out-dir>" >&2
  exit 2
fi
SCRIPT_DIR="$(cd "$(/usr/bin/dirname "${BASH_SOURCE[0]}")" && /bin/pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && /bin/pwd)"
MCPB_VERSION="${MCPB_VERSION:-2.1.2}"
STAGING="$(/usr/bin/mktemp -d)"
trap '/bin/rm -rf "$STAGING"' EXIT

/bin/cp "$SCRIPT_DIR/probe-sqlite.mjs" "$STAGING/probe-sqlite.mjs"
# Laufzeitbedingung aus dem echten Manifest, damit Claude Desktop dieselbe Wahl trifft.
RUNTIME="$(node -p "require('$ROOT/manifest.json').compatibility.runtimes.node")"
/bin/cat > "$STAGING/manifest.json" <<EOF
{
  "manifest_version": "0.3",
  "name": "apple-mail-mcp-sqlite-probe",
  "display_name": "Apple Mail SQLite Probe",
  "version": "0.0.1",
  "description": "Prints the Node and SQLite versions of the MCPB runtime to the log, then exits.",
  "author": { "name": "Martin Alker" },
  "server": {
    "type": "node",
    "entry_point": "probe-sqlite.mjs",
    "mcp_config": { "command": "node", "args": ["\${__dirname}/probe-sqlite.mjs"] }
  },
  "compatibility": { "platforms": ["darwin"], "runtimes": { "node": "$RUNTIME" } }
}
EOF

/bin/mkdir -p "$1"
OUT="$(cd "$1" && /bin/pwd)/apple-mail-mcp-sqlite-probe.mcpb"
/bin/rm -f "$OUT"
npx -y "@anthropic-ai/mcpb@$MCPB_VERSION" pack "$STAGING" "$OUT" >&2
echo "$OUT"
