#!/bin/bash
# Keeps the Apex Security server running: restarts it a few seconds after it exits,
# appending everything to data/server.log. Start it from a terminal (so it inherits the
# terminal's macOS Local Network permission, which launchd jobs don't get):
#   nohup scripts/run-server.sh >/dev/null 2>&1 &
# Stop it with:  pkill -f run-server.sh; pkill -f "tsx src/index.ts"
cd "$(dirname "$0")/../server" || exit 1
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
LOG=../data/server.log
while true; do
  ./node_modules/.bin/tsx src/index.ts >>"$LOG" 2>&1
  code=$?
  echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) supervisor: server exited with code $code; restarting in 3s" >>"$LOG"
  sleep 3
done
