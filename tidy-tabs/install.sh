#!/bin/bash
# Installs Tidy Tabs into Zen. It uses the same script loader as the Zen Notes
# Library tab (zen-mod/install.sh), which also puts it back after Zen updates.
#
#   ./install.sh              install or update (quit Zen first)
#   ./install.sh --ollama     install and sort tabs with Ollama on this Mac (no API key)
#   ./install.sh --uninstall  remove Tidy Tabs
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
SCRIPT="zen-tidy-tabs.uc.mjs"
PAYLOAD="$HOME/Library/Application Support/ZenNotes/zen-mod"

ZEN_DIR="$HOME/Library/Application Support/zen"
# The profile Zen really uses: of the profiles in profiles.ini, the one whose
# prefs.js was written most recently. (The [Install] default can point at a
# stale profile on Macs that have had more than one Zen install.)
newest_profile() {
  local best="" best_t=0 rel dir t
  while IFS= read -r rel; do
    case "$rel" in /*) dir="$rel" ;; *) dir="$ZEN_DIR/$rel" ;; esac
    [ -f "$dir/prefs.js" ] || continue
    t=$(stat -c %Y "$dir/prefs.js" 2>/dev/null || stat -f %m "$dir/prefs.js" 2>/dev/null || echo 0)
    if [ "$t" -gt "$best_t" ]; then best="$dir"; best_t=$t; fi
  done < <(awk -F= '/^Path=/{print substr($0, 6)}' "$ZEN_DIR/profiles.ini" 2>/dev/null)
  echo "$best"
}
PROFILE="$(newest_profile)"
[ -n "$PROFILE" ] || { echo "Couldn't find your Zen profile." >&2; exit 1; }
echo "Zen profile: $PROFILE"

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
cp "$HERE/default-broom.svg" "$PROFILE/chrome/resources/zen-tidy-tabs/"
rm -rf "$HOME/Library/Caches/zen/Profiles/$(basename "$PROFILE")/startupCache"

if [ "${1:-}" = "--ollama" ]; then
  USERJS="$PROFILE/user.js"
  touch "$USERJS"
  grep -v 'zen.tidy-tabs.provider' "$USERJS" > "$USERJS.tmp" || true
  echo 'user_pref("zen.tidy-tabs.provider", "ollama");' >> "$USERJS.tmp"
  mv "$USERJS.tmp" "$USERJS"
  echo "Tidy Tabs will use Ollama (model: llama3.1). Make sure Ollama is running."
fi

echo "Done. Open Zen: the broom is next to \"Clear\" above your tabs (or press ⌘⌥T)."
[ "${1:-}" = "--ollama" ] || echo "The first time you use it, it asks for a Claude API key."
