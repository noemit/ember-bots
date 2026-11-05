#!/bin/sh
# Cap the memory agents' own processes may use, so a runaway job is killed instead of the host.
#
# Hearth runs every agent command in a transient scope under `hearth-agents.slice` (see
# `src/shell.ts`), which is a sibling of `hearth.service` rather than a child of it. That is what
# stops systemd-oomd charging an agent's dev server or browser to Hearth — but until the slice has a
# limit, nothing stops those processes from using the whole machine.
#
# This installs a **user** drop-in (no sudo): `MemoryHigh` throttles and pressures the slice,
# `MemoryMax` makes systemd kill inside it. Both are the agents' processes only; Hearth, Ember and
# the desktop are untouched. Pick numbers that leave the machine usable: a 16 GB box with 4 GB high
# and 6 GB max has room for the desktop and a conversation.
#
#   scripts/hearth-agents-slice.sh            # 4G high, 6G max
#   scripts/hearth-agents-slice.sh 2G 3G      # tighter
#   scripts/hearth-agents-slice.sh off        # remove the cap
#
# Applies to scopes started after it (a scope already running keeps the limits it started with).
set -eu

HIGH=${1:-4G}
DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/hearth-agents.slice.d"

if [ "$HIGH" = "off" ]; then
  rm -f "$DIR/limits.conf"
  rmdir "$DIR" 2>/dev/null || true
  systemctl --user daemon-reload 2>/dev/null || true
  echo "Removed the memory cap on hearth-agents.slice."
  exit 0
fi

MAX=${2:-6G}
mkdir -p "$DIR"
cat > "$DIR/limits.conf" <<EOF
# Written by scripts/hearth-agents-slice.sh — the ceiling on processes agents start.
# MemoryHigh throttles this slice first; MemoryMax is where systemd starts killing inside it.
[Slice]
MemoryHigh=$HIGH
MemoryMax=$MAX
EOF
systemctl --user daemon-reload 2>/dev/null || true

echo "Agent processes are capped at $MAX (throttled from $HIGH)."
echo "  file:  $DIR/limits.conf"
echo "  check: systemctl --user show hearth-agents.slice -p MemoryHigh -p MemoryMax"
echo "  undo:  scripts/hearth-agents-slice.sh off"
