#!/bin/bash
# start-nanoclaw.sh — Start NanoClaw without systemd
# To stop: kill \$(cat /Users/vitamin/nanoclaw-sandbox-9809/nanoclaw.pid)

set -euo pipefail

cd "/Users/vitamin/nanoclaw-sandbox-9809"

# Stop existing instance if running
if [ -f "/Users/vitamin/nanoclaw-sandbox-9809/nanoclaw.pid" ]; then
  OLD_PID=$(cat "/Users/vitamin/nanoclaw-sandbox-9809/nanoclaw.pid" 2>/dev/null || echo "")
  if [ -n "$OLD_PID" ] && kill -0 "$OLD_PID" 2>/dev/null; then
    echo "Stopping existing NanoClaw (PID $OLD_PID)..."
    kill "$OLD_PID" 2>/dev/null || true
    sleep 2
  fi
fi

echo "Starting NanoClaw..."
nohup "/Users/vitamin/.nvm/versions/node/v24.13.0/bin/node" "/Users/vitamin/nanoclaw-sandbox-9809/dist/index.js" \
  >> "/Users/vitamin/nanoclaw-sandbox-9809/logs/nanoclaw.log" \
  2>> "/Users/vitamin/nanoclaw-sandbox-9809/logs/nanoclaw.error.log" &

echo $! > "/Users/vitamin/nanoclaw-sandbox-9809/nanoclaw.pid"
echo "NanoClaw started (PID $!)"
echo "Logs: tail -f /Users/vitamin/nanoclaw-sandbox-9809/logs/nanoclaw.log"
