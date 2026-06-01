#!/bin/zsh

set -u

cd "$(dirname "$0")"

PORT="${PORT:-4173}"
URL="http://127.0.0.1:${PORT}"

clear
echo "ChatVisualizer"
echo

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js 20 or newer is required."
  echo
  echo "Install the LTS version from:"
  echo "https://nodejs.org/"
  echo
  echo "After installing Node.js, double-click this file again."
  echo
  read -r "?Press Return to close this window."
  exit 1
fi

NODE_MAJOR="$(node -p "Number(process.versions.node.split('.')[0])" 2>/dev/null || echo 0)"
if [[ "${NODE_MAJOR}" -lt 20 ]]; then
  echo "Your Node.js version is too old."
  echo
  echo "Installed: $(node --version)"
  echo "Required:  v20 or newer"
  echo
  echo "Install the current LTS version from:"
  echo "https://nodejs.org/"
  echo
  read -r "?Press Return to close this window."
  exit 1
fi

if ! command -v sqlite3 >/dev/null 2>&1; then
  echo "Note: sqlite3 was not found."
  echo "Cursor and Antigravity history may not be indexed until sqlite3 is installed."
  echo
fi

if ! command -v rg >/dev/null 2>&1; then
  echo "Note: ripgrep was not found."
  echo "Deep search may be limited, but normal browsing will still work."
  echo
fi

if command -v lsof >/dev/null 2>&1 && lsof -nP -iTCP:"${PORT}" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "ChatVisualizer already appears to be running."
  echo "Opening ${URL}"
  open "${URL}"
  echo
  read -r "?Press Return to close this window."
  exit 0
fi

echo "Starting ChatVisualizer..."
echo "Opening ${URL}"
echo
echo "Leave this window open while using the app."
echo "To stop ChatVisualizer, close this window or press Control-C."
echo

(sleep 1 && open "${URL}") &
node server.js

STATUS=$?
echo
echo "ChatVisualizer stopped."
read -r "?Press Return to close this window."
exit "${STATUS}"
