#!/bin/sh
# Open the single-file build from disk (file://) in headless Chrome and check
# that the app starts: no server, nothing but the one file.
# Usage: scripts/check-single-file.sh [dist-dir] [chrome-binary]
set -eu

cd "$(dirname "$0")/.."
dist="${1:-dist}"
chrome="${2:-google-chrome}"
file="$(cd "$dist" && pwd)/taski.html"
version=$(cat "$dist/VERSION")

dom=$("$chrome" --headless=new --disable-gpu --no-sandbox --no-first-run \
  --virtual-time-budget=10000 --dump-dom "file://$file")

# Check the visible text only: the single file contains these phrases in its own
# source code too, so searching the raw HTML would pass even if nothing rendered.
text=$(printf '%s\n' "$dom" | python3 -c 'import re,sys; t=re.sub(r"(?s)<!--.*?-->|<(script|style)\b.*?</\1>|<[^>]+>", " ", sys.stdin.read()); print(" ".join(t.split()))')

for expected in "Open a Taski workspace" "You opened Taski as a file on this computer" \
    "Folder on this computer" "Not available here" "Google sign-in needs a web address" \
    "python3 -m http.server" "Taski $version"; do
  if ! printf '%s\n' "$text" | grep -qF "$expected"; then
    echo "Single file did not start: missing \"$expected\"" >&2
    echo "Visible text Chrome saw:" >&2
    printf '%s\n' "$text" | head -c 1500 >&2
    echo >&2
    exit 1
  fi
done
echo "Single file starts from disk: Taski $version"
