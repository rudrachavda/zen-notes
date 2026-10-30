#!/bin/bash
# Puts the Zen Notes Library files back where Zen expects them.
#
# Zen updates replace Zen.app, which deletes fx-autoconfig's two loader files.
# A LaunchAgent (set up by install.sh) runs this with --check whenever Zen.app
# changes and once an hour. If something is missing it opens "Zen Notes Repair",
# a tiny app that can be given permission to change Zen.app, to copy it back.
#
#   repair.sh            copy everything now (install.sh and the repair app use this)
#   repair.sh --check    only check; hand off to the repair app if anything is missing
set -uo pipefail

SUPPORT="$HOME/Library/Application Support/ZenNotes"
PAYLOAD="$SUPPORT/zen-mod"
APPLET="$SUPPORT/Zen Notes Repair.app"
LOG="$HOME/Library/Logs/ZenNotes-repair.log"
MODE="${1:-repair}"

log() { echo "$(date '+%Y-%m-%d %H:%M:%S') $*" >> "$LOG"; }
notify() { /usr/bin/osascript -e "display notification \"$1\" with title \"Zen Notes\"" >/dev/null 2>&1 || true; }

APP=""
for candidate in "/Applications/Zen.app" "/Applications/Zen Browser.app" "$HOME/Applications/Zen.app"; do
  [ -d "$candidate" ] && APP="$candidate" && break
done
[ -n "$APP" ] || { log "Zen not found"; exit 0; }
RES="$APP/Contents/Resources"

ZEN_DIR="$HOME/Library/Application Support/zen"
PROFILE_REL=$(awk -F= '/^\[Install/{inst=1} inst && /^Default=/{print $2; exit}' "$ZEN_DIR/profiles.ini" 2>/dev/null || true)
if [ -z "$PROFILE_REL" ]; then
  PROFILE_REL=$(awk -F= '/^Path=/{p=$2} /^Default=1/{print p; exit}' "$ZEN_DIR/profiles.ini" 2>/dev/null || true)
fi
PROFILE=""
if [ -n "$PROFILE_REL" ]; then
  case "$PROFILE_REL" in /*) PROFILE="$PROFILE_REL" ;; *) PROFILE="$ZEN_DIR/$PROFILE_REL" ;; esac
fi

program_ok() {
  cmp -s "$RES/config.js" "$PAYLOAD/fx-autoconfig/program/config.js" &&
    cmp -s "$RES/defaults/pref/config-prefs.js" "$PAYLOAD/fx-autoconfig/program/defaults/pref/config-prefs.js"
}
# Another script loader's config.js (not fx-autoconfig): never overwrite it.
foreign_loader() {
  [ -f "$RES/config.js" ] && ! cmp -s "$RES/config.js" "$PAYLOAD/fx-autoconfig/program/config.js" &&
    ! grep -q "boot.sys.mjs" "$RES/config.js" 2>/dev/null
}
profile_ok() {
  [ -z "$PROFILE" ] && return 0
  [ -f "$PROFILE/chrome/utils/boot.sys.mjs" ] &&
    cmp -s "$PROFILE/chrome/JS/zen-notes-library.uc.mjs" "$PAYLOAD/zen-notes-library.uc.mjs" &&
    [ -f "$PROFILE/chrome/resources/zen-notes/note-icon.svg" ]
}

if [ "$MODE" = "--check" ]; then
  foreign_loader && exit 0
  if program_ok && profile_ok; then exit 0; fi
  log "Missing files after a change to Zen; opening the repair app"
  if [ -d "$APPLET" ]; then
    /usr/bin/open -g "$APPLET"
  else
    "$0" # no repair app (yet): try directly
  fi
  exit 0
fi

# --- Repair ---------------------------------------------------------------------
[ -d "$PAYLOAD" ] || { echo "Missing $PAYLOAD; run install.sh again." >&2; exit 1; }
status=0

# Writing into Zen.app needs App Management permission; test for it every run so
# macOS asks (and we find out) now, not only after an update.
if touch "$RES/.zen-notes-probe" 2>/dev/null; then
  rm -f "$RES/.zen-notes-probe"
else
  log "macOS blocked changing $APP"
  echo "macOS blocked changing the Zen app." >&2
  exit 2
fi

if ! program_ok; then
  if foreign_loader; then
    echo "Zen already has a different config.js (another script loader?). Leaving it alone." >&2
    log "Foreign config.js, left alone"
  elif cp "$PAYLOAD/fx-autoconfig/program/config.js" "$RES/config.js" 2>/dev/null &&
    mkdir -p "$RES/defaults/pref" &&
    cp "$PAYLOAD/fx-autoconfig/program/defaults/pref/config-prefs.js" "$RES/defaults/pref/config-prefs.js"; then
    log "Restored loader in $APP"
    if pgrep -xq zen; then
      notify "Zen was updated. Quit and reopen Zen to bring Notes back to the Library."
    fi
  else
    log "macOS blocked changing $APP"
    echo "macOS blocked changing the Zen app." >&2
    status=2
  fi
fi

if [ -n "$PROFILE" ] && ! profile_ok; then
  mkdir -p "$PROFILE/chrome/utils" "$PROFILE/chrome/JS" "$PROFILE/chrome/resources/zen-notes"
  [ -f "$PROFILE/chrome/utils/boot.sys.mjs" ] || cp "$PAYLOAD/fx-autoconfig/profile/chrome/utils/"* "$PROFILE/chrome/utils/"
  cp "$PAYLOAD/zen-notes-library.uc.mjs" "$PROFILE/chrome/JS/"
  cp "$PAYLOAD/"*.svg "$PROFILE/chrome/resources/zen-notes/" 2>/dev/null
  rm -rf "$PROFILE/chrome/zen-notes"
  rm -rf "$HOME/Library/Caches/zen/Profiles/$(basename "$PROFILE")/startupCache"
  log "Restored profile files in $PROFILE"
fi

exit $status
