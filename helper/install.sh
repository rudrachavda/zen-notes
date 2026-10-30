#!/bin/bash
# Registers the Zen Notes helper with Zen (and Firefox) on macOS.
# Usage: ./install.sh ["/path/to/notes folder"]
set -euo pipefail

HOST_NAME="zen_notes"
EXT_ID="zen-notes@rudrachavda"
SRC_DIR="$(cd "$(dirname "$0")" && pwd)"
APP_DIR="$HOME/Library/Application Support/ZenNotes"
HOST_PATH="$APP_DIR/zen_notes_host.py"

if ! /usr/bin/env python3 -V >/dev/null 2>&1; then
  echo "python3 is required. Install the Xcode command line tools with: xcode-select --install" >&2
  exit 1
fi

mkdir -p "$APP_DIR"
cp "$SRC_DIR/zen_notes_host.py" "$HOST_PATH"
chmod +x "$HOST_PATH"

if [ $# -ge 1 ]; then
  mkdir -p "$1"
  printf '{\n  "folder": "%s"\n}\n' "$1" > "$APP_DIR/config.json"
fi

MANIFEST=$(cat <<EOF
{
  "name": "$HOST_NAME",
  "description": "Zen Notes local markdown storage",
  "path": "$HOST_PATH",
  "type": "stdio",
  "allowed_extensions": ["$EXT_ID"]
}
EOF
)

# Zen reads native messaging manifests from its own folder; Firefox from Mozilla's.
for dir in "$HOME/Library/Application Support/zen/NativeMessagingHosts" \
           "$HOME/Library/Application Support/Mozilla/NativeMessagingHosts"; do
  mkdir -p "$dir"
  echo "$MANIFEST" > "$dir/$HOST_NAME.json"
  echo "Registered helper in $dir"
done

FOLDER=$(python3 -c "import json,os;print(json.load(open(os.path.expanduser('$APP_DIR/config.json'))).get('folder'))" 2>/dev/null || echo "$HOME/Zen Notes")
echo "Notes will be saved in: $FOLDER"
