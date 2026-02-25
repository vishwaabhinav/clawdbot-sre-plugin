#!/bin/bash
LOCKFILE="/tmp/nomie-sre-poll.lock"

# Exit if another instance is still running
if [ -f "$LOCKFILE" ]; then
  OLDPID=$(cat "$LOCKFILE")
  if kill -0 "$OLDPID" 2>/dev/null; then
    echo "$(date -u +%FT%TZ) Poll already running (pid $OLDPID), skipping" >> /tmp/nomie-sre.log
    exit 0
  fi
  rm -f "$LOCKFILE"
fi

cd ~/clawd/skills/nomie-sre
source .env

# Run with a 4-minute timeout (cron fires every 5min) so it never accumulates
timeout 240 ~/.bun/bin/bun run dist/index.js poll >> /tmp/nomie-sre.log 2>&1 &
POLL_PID=$!
echo "$POLL_PID" > "$LOCKFILE"
wait "$POLL_PID"
rm -f "$LOCKFILE"
