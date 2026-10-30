#!/bin/bash
# Adds a "Notes" section to Zen's Library and puts your last used tab at the top of
# the ⌘T bar, and keeps both working after Zen updates.
#
# Zen only runs CSS mods on its own, so this sets up fx-autoconfig, a small,
# widely used loader for browser scripts (https://github.com/MrOtherGuy/fx-autoconfig),
# then adds the scripts here (*.uc.mjs, *.sys.mjs) to your Zen profile. Quit Zen before running.
#
# Zen updates replace Zen.app and remove the loader, so this also installs a
# LaunchAgent that puts it back by itself (see repair.sh).
#
#   ./install.sh              install or update
#   ./install.sh --uninstall  remove the auto-repair (the Library tab stays until Zen updates)
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"

SUPPORT="$HOME/Library/Application Support/ZenNotes"
PAYLOAD="$SUPPORT/zen-mod"
APPLET="$SUPPORT/Zen Notes Repair.app"
LABEL="com.rudrachavda.zennotes.repair"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"

if [ "${1:-}" = "--uninstall" ]; then
  launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
  rm -rf "$PLIST" "$APPLET" "$PAYLOAD"
  echo "Removed the Zen Notes auto-repair."
  exit 0
fi

APP=""
for candidate in "/Applications/Zen.app" "/Applications/Zen Browser.app" "$HOME/Applications/Zen.app"; do
  [ -d "$candidate" ] && APP="$candidate" && break
done
[ -n "$APP" ] || { echo "Couldn't find Zen in /Applications." >&2; exit 1; }

if pgrep -xq zen; then
  echo "Please quit Zen first (⌘Q), then run this again." >&2
  exit 1
fi

# 1. Keep a copy of everything outside Downloads, where background jobs can read it.
mkdir -p "$PAYLOAD"
rm -rf "$PAYLOAD/fx-autoconfig"
cp -R "$HERE/fx-autoconfig" "$PAYLOAD/"
rm -f "$PAYLOAD/"*.uc.mjs "$PAYLOAD/"*.sys.mjs
cp "$HERE/"*.uc.mjs "$HERE/"*.sys.mjs "$HERE/repair.sh" "$PAYLOAD/"
rm -f "$PAYLOAD/"*.svg
# notes-sprite.svg is Arc's animated Notes icon (not in the repo; see README).
cp "$HERE/"*.svg "$PAYLOAD/"
chmod +x "$PAYLOAD/repair.sh"

# 2. Put the loader in Zen.app and the script in your profile.
set +e
"$PAYLOAD/repair.sh"
status=$?
set -e
if [ $status -eq 2 ]; then
  echo "Allow Terminal under System Settings > Privacy & Security > App Management," >&2
  echo "then run this again." >&2
  exit 1
fi

# 3. "Zen Notes Repair": a tiny background app that copies the loader back after an
#    update. It's an app (not a script) so macOS can give it App Management permission.
rm -rf "$APPLET"
SCRIPT_DIR="$(mktemp -d)"
SCRIPT="$SCRIPT_DIR/repair.applescript"
cat > "$SCRIPT" <<APPLESCRIPT
try
  do shell script quoted form of "$PAYLOAD/repair.sh"
on error errText number errNum
  if errNum is 2 then
    display dialog "macOS stopped Zen Notes Repair from updating Zen, so Notes won't show in the Library. Allow it under Privacy & Security > App Management, then quit and reopen Zen." with title "Zen Notes" buttons {"Later", "Open Settings"} default button 2
    if button returned of result is "Open Settings" then open location "x-apple.systempreferences:com.apple.preference.security?Privacy_AppBundles"
  end if
end try
APPLESCRIPT
/usr/bin/osacompile -o "$APPLET" "$SCRIPT"
rm -rf "$SCRIPT_DIR"
/usr/bin/plutil -replace LSUIElement -bool true "$APPLET/Contents/Info.plist"
/usr/bin/plutil -replace CFBundleIdentifier -string "$LABEL" "$APPLET/Contents/Info.plist"
/usr/bin/codesign --force --deep -s - "$APPLET" 2>/dev/null

# 4. Run the check whenever Zen.app changes, at login, and hourly as a backstop.
mkdir -p "$(dirname "$PLIST")"
cat > "$PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>$PAYLOAD/repair.sh</string>
    <string>--check</string>
  </array>
  <key>WatchPaths</key>
  <array>
    <string>/Applications</string>
    <string>$APP/Contents/Resources</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>StartInterval</key><integer>3600</integer>
  <key>ThrottleInterval</key><integer>30</integer>
</dict>
</plist>
PLIST
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"

# 5. Ask for App Management permission now rather than after the next update.
echo
echo "One more step: macOS may ask whether \"Zen Notes Repair\" can change apps."
echo "Allow it (System Settings > Privacy & Security > App Management), so Notes"
echo "comes back on its own after Zen updates."
/usr/bin/open -g "$APPLET"

echo
echo "Done. Open Zen: the Library has a Notes section, and ⌘T then Enter jumps back"
echo "to your last used tab."
