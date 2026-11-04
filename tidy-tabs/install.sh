#!/bin/bash
# Installs Tidy Tabs into Zen. It uses the same script loader as the Zen Notes
# Library tab (zen-mod/install.sh), which also puts it back after Zen updates.
#
#   ./install.sh              install or update (quit Zen first)
#   ./install.sh --uninstall  remove Tidy Tabs
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
SCRIPT="zen-tidy-tabs.uc.mjs"
PAYLOAD="$HOME/Library/Application Support/ZenNotes/zen-mod"

ZEN_DIR="$HOME/Library/Application Support/zen"
PROFILE_REL=$(awk -F= '/^\[Install/{inst=1} inst && /^Default=/{print $2; exit}' "$ZEN_DIR/profiles.ini" 2>/dev/null || true)
[ -n "$PROFILE_REL" ] || PROFILE_REL=$(awk -F= '/^Path=/{p=$2} /^Default=1/{print p; exit}' "$ZEN_DIR/profiles.ini" 2>/dev/null || true)
[ -n "$PROFILE_REL" ] || { echo "Couldn't find your Zen profile." >&2; exit 1; }
case "$PROFILE_REL" in /*) PROFILE="$PROFILE_REL" ;; *) PROFILE="$ZEN_DIR/$PROFILE_REL" ;; esac

if [ "${1:-}" = "--uninstall" ]; then
  rm -f "$PAYLOAD/$SCRIPT" "$PROFILE/chrome/JS/$SCRIPT"
  rm -rf "$HOME/Library/Caches/zen/Profiles/$(basename "$PROFILE")/startupCache"
  echo "Removed Tidy Tabs. Restart Zen to finish."
  exit 0
fi

if pgrep -xq zen; then
  echo "Please quit Zen first (⌘Q), then run this again." >&2
  exit 1
fi

if [ ! -f "$PROFILE/chrome/utils/boot.sys.mjs" ] || [ ! -d "$PAYLOAD" ]; then
  echo "The script loader isn't set up yet. Running zen-mod/install.sh first…"
  "$HERE/../zen-mod/install.sh"
fi

mkdir -p "$PROFILE/chrome/JS" "$PROFILE/chrome/resources/zen-tidy-tabs"
cp "$HERE/$SCRIPT" "$PAYLOAD/"          # kept here so the repair app restores it after Zen updates
cp "$HERE/$SCRIPT" "$PROFILE/chrome/JS/"
rm -rf "$HOME/Library/Caches/zen/Profiles/$(basename "$PROFILE")/startupCache"

echo "Done. Open Zen: the broom is next to \"Clear\" above your tabs (or press ⌘⌥T)."
echo "The first time you use it, it asks for a Claude API key."
