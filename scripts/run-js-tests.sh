#!/bin/sh
# Run tests/tests.html in headless Chrome against server.py and check the result.
# Usage: scripts/run-js-tests.sh [chrome-binary]   (default: google-chrome)
# Set TASKI_TEST_PORT to use another port (default: 8799).
set -eu

cd "$(dirname "$0")/.."
chrome="${1:-google-chrome}"
port="${TASKI_TEST_PORT:-8799}"

python3 server.py --port "$port" >/dev/null 2>&1 &
server=$!
trap 'kill "$server" 2>/dev/null || true' EXIT

ready=
for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do
  if curl -sf "http://127.0.0.1:$port/api/ping" | grep -q '^taski'; then ready=1; break; fi
  sleep 0.5
done
if [ -z "$ready" ]; then
  echo "server.py did not start on port $port (is the port in use?)" >&2
  exit 1
fi

dom=$("$chrome" --headless=new --disable-gpu --no-sandbox --no-first-run \
  --virtual-time-budget=20000 --dump-dom "http://127.0.0.1:$port/tests/tests.html")

# Print each test line, then the summary.
printf '%s\n' "$dom" | grep -oE '<li class="(pass|fail)">[^<]*' | sed 's/<li class="[a-z]*">/  /'
printf '%s\n' "$dom" | grep -oE '<pre>[^<]*' | sed 's/<pre>/      /' || true
summary=$(printf '%s\n' "$dom" | grep -oE 'id="summary"[^>]*>[^<]*' | sed 's/.*>//')
echo "$summary"
printf '%s\n' "$dom" | grep -qE 'id="summary" class="pass">All [0-9]+ passed'
