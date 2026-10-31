#!/bin/sh
# Assemble the GitHub Pages site. Plain shell and Python standard library.
#   /           landing/
#   /releases/  download page + taski.html (single file) and taski.zip
#   /app/       taski.html + taski_src/          (opens the storage picker;
#               its "Web folder" default points at the public demo)
#   /demo/      taski.html + taski_src/ + taski-demo/ (reads the sample workspace over HTTP)
# Usage: scripts/build-site.sh [output-dir]   (default: _site)
set -eu

cd "$(dirname "$0")/.."
out="${1:-_site}"

rm -rf "$out"
mkdir -p "$out/app" "$out/demo"
cp -R landing/. "$out/"
for dir in app demo; do
  cp taski.html "$out/$dir/index.html"
  cp -R taski_src "$out/$dir/taski_src"
done
cp -R taski-demo "$out/demo/taski-demo"
# /app/ has no taski-demo/ next to it, so its default web folder is the public demo.
# Both copies get the Google Drive client ID and API key from TASKI_DRIVE_CLIENT_ID and
# TASKI_DRIVE_API_KEY, if set (CI secrets).
# The downloads below don't: Taski's Google client only allows the published site.
python3 scripts/build-dist.py --publish-config "$out/app/taski_src/config.js"
python3 scripts/build-dist.py --drive-config "$out/demo/taski_src/config.js"

# Downloads, built from the same files, and their details on the releases page.
python3 scripts/build-dist.py "$out/releases" >/dev/null
version=$(cat "$out/releases/VERSION")
kb() { echo "$(( ($(wc -c < "$1") + 1023) / 1024 )) KB"; }
sed -e "s/__TASKI_VERSION__/$version/g" \
    -e "s/__TASKI_HTML_SIZE__/$(kb "$out/releases/taski.html")/g" \
    -e "s/__TASKI_ZIP_SIZE__/$(kb "$out/releases/taski.zip")/g" \
    landing/releases/index.html > "$out/releases/index.html"

# Serve files as they are; no Jekyll processing of underscores or Markdown.
touch "$out/.nojekyll"
find "$out" -name .DS_Store -delete

echo "Built Taski $version site in $out:"
find "$out" -type f | sort | sed "s|^$out/|  |"
