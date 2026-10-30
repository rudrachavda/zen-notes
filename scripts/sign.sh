#!/bin/bash
# Signs Zen Notes with Mozilla as a self-distributed ("unlisted") add-on, so it
# stays installed across restarts. Needs Node.js (for npx) and an AMO API key
# from https://addons.mozilla.org/developers/addon/api/key/
# The secret is read without echoing and never written to disk or shell history.
set -euo pipefail
cd "$(dirname "$0")/.."

if ! command -v npx >/dev/null; then
  echo "npx not found. Install Node.js first, e.g. with: brew install node" >&2
  exit 1
fi

read -r -p "AMO JWT issuer (looks like user:12345:678): " AMO_KEY
read -r -s -p "AMO JWT secret (hidden): " AMO_SECRET
echo

WEB_EXT_API_KEY="$AMO_KEY" WEB_EXT_API_SECRET="$AMO_SECRET" \
  npx -y web-ext@8 sign \
    --channel unlisted \
    --source-dir extension \
    --artifacts-dir signed

echo
echo "Done. The signed add-on is in: $(pwd)/signed"
echo "Install it in Zen: about:addons > gear icon > Install Add-on From File..."
