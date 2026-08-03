#!/bin/sh
# Keep TabDesk running across crashes, without fighting a dying desktop.
#
# tabdesk.sh execs electron, so its exit status is electron's: quitting from
# the tray or the window ends the loop, a crash restarts it. When the X session
# goes away every restart fails instantly, so a run of fast failures is taken
# as "the desktop is gone" rather than something to retry forever.

REPO="$(cd "$(dirname "$0")/.." && pwd)"
LOG="${XDG_CACHE_HOME:-$HOME/.cache}/tabdesk-guard.log"
DELAY=3
FAST=15          # an exit sooner than this counts as a failed start
GIVE_UP=5        # consecutive failed starts before stopping

mkdir -p "$(dirname "$LOG")"
# Keep the log from growing without bound across months of restarts.
[ -f "$LOG" ] && [ "$(wc -c < "$LOG")" -gt 1000000 ] && : > "$LOG"

say() { echo "$(date '+%Y-%m-%d %H:%M:%S') $*" >> "$LOG"; }

fails=0
while :; do
  started=$(date +%s)
  "$REPO/tabdesk.sh" >> "$LOG" 2>&1
  status=$?
  ran=$(( $(date +%s) - started ))

  # A clean exit is the user quitting — nothing to restart. Coming back within
  # seconds means another TabDesk already holds the lock and this one stepped
  # aside; also nothing to restart, but worth saying so plainly in the log.
  if [ "$status" -eq 0 ]; then
    [ "$ran" -lt "$FAST" ] && say "exited at once — another TabDesk is running" \
                           || say "quit cleanly after ${ran}s"
    break
  fi

  if [ "$ran" -lt "$FAST" ]; then
    fails=$((fails + 1))
    say "exit $status after ${ran}s (fast failure $fails/$GIVE_UP)"
    [ "$fails" -ge "$GIVE_UP" ] && { say "giving up — no usable display?"; break; }
  else
    fails=0
    say "exit $status after ${ran}s — restarting"
  fi
  sleep "$DELAY"
done
