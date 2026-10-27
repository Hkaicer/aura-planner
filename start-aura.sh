#!/usr/bin/env bash
# AURA launcher for macOS and Linux: checks Node.js, installs dependencies the
# first time, builds the interface, starts the local server and opens AURA.
# Close this window (or press Ctrl+C) to stop AURA.
set -euo pipefail
cd "$(dirname "$0")"

port=4317
open_mode=browser
if [ -f .env ]; then
  while IFS='=' read -r key value; do
    value="${value//$'\r'/}"
    case "$key" in
      AURA_PORT) port="$value" ;;
      AURA_OPEN) open_mode="$value" ;;
    esac
  done < <(grep -E '^(AURA_PORT|AURA_OPEN)=' .env || true)
fi
url="http://127.0.0.1:${port}"

pause() {
  read -r -p "Press Enter to close this window." _ || true
}

if ! command -v node >/dev/null 2>&1; then
  echo
  echo " Node.js is not installed. Install Node.js 22.13 or newer from https://nodejs.org"
  echo " then run this file again."
  echo
  pause
  exit 1
fi

if ! node -e 'const [a, b] = process.versions.node.split(".").map(Number); process.exit(a > 22 || (a === 22 && b >= 13) ? 0 : 1)'; then
  echo
  echo " AURA needs Node.js 22.13 or newer (found $(node -v)). Update it from https://nodejs.org"
  echo
  pause
  exit 1
fi

open_aura() {
  [ "$open_mode" = "none" ] && return 0
  if [ "$(uname)" = "Darwin" ]; then
    # "app" opens a window without tabs or address bar when Edge or Chrome is installed.
    if [ "$open_mode" = "app" ]; then
      for app in "Microsoft Edge" "Google Chrome"; do
        if open -Ra "$app" 2>/dev/null; then
          open -na "$app" --args --app="$1"
          return 0
        fi
      done
    fi
    open "$1"
  elif command -v xdg-open >/dev/null 2>&1; then
    xdg-open "$1" >/dev/null 2>&1 &
  else
    echo " Open $1 in your browser."
  fi
}

# Already running? Just open it.
if curl -fs -m 2 "$url/api/health" >/dev/null 2>&1; then
  echo "AURA is already running at $url"
  open_aura "$url"
  exit 0
fi

if [ ! -d node_modules ]; then
  echo "Installing dependencies (first launch only)..."
  npm install --no-audit --no-fund
fi

echo "Building the interface..."
npm run build --silent

# Open AURA as soon as the server answers.
(
  for _ in $(seq 1 60); do
    if curl -fs -m 1 "$url/api/health" >/dev/null 2>&1; then
      open_aura "$url"
      break
    fi
    sleep 0.5
  done
) &

echo
echo " AURA is starting at $url (this computer only)"
echo " Keep this window open while you use AURA. Close it to stop."
echo
exec npm start
