#!/bin/bash
# Adds a "Notes" section to Zen's Library.
#
# Zen only runs CSS mods on its own, so this sets up fx-autoconfig, a small,
# widely used loader for browser scripts (https://github.com/MrOtherGuy/fx-autoconfig),
# then adds zen-notes-library.uc.mjs to your Zen profile. Quit Zen before running.
# Zen updates replace the app, so run this again after an update if Notes disappears.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"

APP=""
for candidate in "/Applications/Zen.app" "/Applications/Zen Browser.app" "$HOME/Applications/Zen.app"; do
  [ -d "$candidate" ] && APP="$candidate" && break
done
[ -n "$APP" ] || { echo "Couldn't find Zen in /Applications." >&2; exit 1; }

if pgrep -xq zen; then
  echo "Please quit Zen first (⌘Q), then run this again." >&2
  exit 1
fi

# 1. The loader's two program files go inside the app.
RES="$APP/Contents/Resources"
if [ -f "$RES/config.js" ] && ! cmp -s "$RES/config.js" "$HERE/fx-autoconfig/program/config.js"; then
  echo "Zen already has a different config.js (another script loader?). Leaving it alone." >&2
else
  if ! cp "$HERE/fx-autoconfig/program/config.js" "$RES/config.js" 2>/dev/null; then
    echo "macOS blocked changing the Zen app. Allow Terminal under System Settings >" >&2
    echo "Privacy & Security > App Management, then run this again." >&2
    exit 1
  fi
  mkdir -p "$RES/defaults/pref"
  cp "$HERE/fx-autoconfig/program/defaults/pref/config-prefs.js" "$RES/defaults/pref/config-prefs.js"
fi

# 2. The loader's profile files and the Notes script go in your Zen profile.
ZEN_DIR="$HOME/Library/Application Support/zen"
PROFILE_REL=$(awk -F= '/^\[Install/{inst=1} inst && /^Default=/{print $2; exit}' "$ZEN_DIR/profiles.ini" 2>/dev/null || true)
if [ -z "$PROFILE_REL" ]; then
  PROFILE_REL=$(awk -F= '/^Path=/{p=$2} /^Default=1/{print p; exit}' "$ZEN_DIR/profiles.ini" 2>/dev/null || true)
fi
[ -n "$PROFILE_REL" ] || { echo "Couldn't find your Zen profile in $ZEN_DIR/profiles.ini" >&2; exit 1; }
case "$PROFILE_REL" in /*) PROFILE="$PROFILE_REL" ;; *) PROFILE="$ZEN_DIR/$PROFILE_REL" ;; esac

mkdir -p "$PROFILE/chrome/utils" "$PROFILE/chrome/JS"
if [ ! -f "$PROFILE/chrome/utils/boot.sys.mjs" ]; then
  cp "$HERE/fx-autoconfig/profile/chrome/utils/"* "$PROFILE/chrome/utils/"
fi
cp "$HERE/zen-notes-library.uc.mjs" "$PROFILE/chrome/JS/"
# Animated icon made from Arc's own Notes icon (not in the repo; see README).
if [ -f "$HERE/notes-sprite.svg" ]; then
  mkdir -p "$PROFILE/chrome/zen-notes"
  cp "$HERE/notes-sprite.svg" "$PROFILE/chrome/zen-notes/"
fi

# 3. Clear Zen's startup cache so the loader is picked up.
rm -rf "$HOME/Library/Caches/zen/Profiles/$(basename "$PROFILE")/startupCache"

echo "Done. Open Zen and the Library (the sidebar's Library button) now has a Notes section."
echo "Profile: $PROFILE"
