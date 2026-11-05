#!/bin/sh
# Runs on the Kindle. If the panel image hasn't been refreshed for 5 minutes (PC off, asleep, loop dead),
# draw the "PC offline" banner over the Now Playing box. The panel's clock stays frozen at the
# last update, so it reads as "offline since". The next real push redraws the whole screen and clears it.
IMG=/tmp/agents.png
BANNER=/mnt/us/panel-offline.png
# banner position, filled in by run.js on upload (it sits exactly over the Now Playing box)
X=__X__
Y=__Y__
STALE=300
shown=0
while true; do
  if [ -f "$IMG" ] && [ -f "$BANNER" ]; then
    age=$(( $(date +%s) - $(stat -c %Y "$IMG") ))
    if [ "$age" -gt "$STALE" ]; then
      if [ "$shown" = 0 ]; then eips -g "$BANNER" -x "$X" -y "$Y" >/dev/null 2>&1 && shown=1; fi
    else
      shown=0
    fi
  fi
  sleep 60
done
