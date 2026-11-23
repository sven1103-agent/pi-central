#!/usr/bin/env bash
# Runs checkpoint-b.mjs while sampling the process table and sockets, then reports whether Chrome's updater ran,
# where its helper's parent is (1 = launchd, i.e. outside the sidecar's process tree), and what it connected to.
set -u
cd "$(dirname "$0")"
OUT="$(mktemp -d)"
( while true; do
    date +%s.%N >> "$OUT/ps.log"
    ps -axo pid,ppid,user,command | grep -i 'GoogleUpdater' | grep -v grep >> "$OUT/ps.log"
    for pid in $(pgrep -f GoogleUpdater 2>/dev/null); do
      lsof -nP -i -a -p "$pid" 2>/dev/null | tail -n +2 >> "$OUT/net.log"
    done
    sleep 0.3
  done ) &
WATCH=$!
node checkpoint-b.mjs
STATUS=$?
kill "$WATCH" 2>/dev/null
echo
echo "=============== updater measurement ==============="
if ! grep -q GoogleUpdater "$OUT/ps.log" 2>/dev/null; then
  echo "RESULT: no GoogleUpdater process was seen during this run."
  echo "        (one clean run is not proof; run it twice, and once after Chrome updates)"
else
  echo "RESULT: GoogleUpdater ran. Distinct processes (pid ppid user command), newest sample last:"
  grep -v '^[0-9.]*$' "$OUT/ps.log" | sort -u | cut -c1-230
  echo
  echo "Sockets they held (empty means none seen):"
  sort -u "$OUT/net.log" 2>/dev/null | cut -c1-200
fi
echo "raw samples kept in: $OUT"
exit $STATUS
