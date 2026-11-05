#!/usr/bin/env bash
# Hearth control script. Runs on Linux, macOS, and Windows Git Bash.
#
#   scripts/hearth.sh start|stop|restart|update|status|url|token|logs
#
# Environment:
#   HEARTH_HOME           data dir (default: /root/.pi on Linux, ~/.hearth elsewhere)
#   HEARTH_PORT           listen port. Default: $HEARTH_HOME/port, else 3002 on Linux, else 3005.
#   HEARTH_LAUNCHD_LABEL  macOS launchd label (default: dev.ember.hearth)
#
# **A device launcher owns Hearth where one is installed.** On macOS that is the launchd agent
# `${HEARTH_LAUNCHD_LABEL:-dev.ember.hearth}` on port 3005; on native Windows it is the `Hearth`
# scheduled task on port 3011. `start`/`stop`/`restart` delegate to that launcher instead of
# spawning a second process on the script's default port — doing both is how a host ends up with
# two Hearths, one of them on a port nothing expects. Pass HEARTH_SUPERVISOR=none to force the
# script's own supervisor; a Linux container with no launcher always uses it.
#
# Linux uses setsid (a real process-group supervisor). macOS/Windows have no setsid, so
# start falls back to nohup + disown. For a service that survives reboot, install the device
# launcher: scripts/install-windows.ps1 on Windows, or a macOS launchd LaunchAgent with KeepAlive.
set -euo pipefail

HEARTH_DIR="$(cd "$(dirname "$0")/.." && pwd)"
LAUNCHD_LABEL="${HEARTH_LAUNCHD_LABEL:-dev.ember.hearth}"
if [ -z "${HEARTH_HOME:-}" ]; then
  case "$(uname -s)" in
    Linux) HEARTH_HOME=/root/.pi ;;
    *) HEARTH_HOME="$HOME/.hearth" ;;
  esac
fi
# The port belongs to the device, not to this script: a launcher writes it to $HEARTH_HOME/port,
# and the per-platform default matches what those launchers are documented to use.
if [ -z "${HEARTH_PORT:-}" ] && [ -f "$HEARTH_HOME/port" ]; then
  HEARTH_PORT="$(tr -d '[:space:]' <"$HEARTH_HOME/port")"
fi
if [ -z "${HEARTH_PORT:-}" ]; then
  case "$(uname -s)" in
    Linux) HEARTH_PORT=3002 ;;
    *) HEARTH_PORT=3005 ;;
  esac
fi
PIDFILE="$HEARTH_HOME/hearth.pid"
LOG="$HEARTH_HOME/hearth.log"
TOKEN_FILE="$HEARTH_HOME/hearth.token"
mkdir -p "$HEARTH_HOME"

health() {
  local token=""
  [ -f "$TOKEN_FILE" ] && token="$(cat "$TOKEN_FILE")"
  curl -fsS --max-time 2 -H "Authorization: Bearer $token" "http://127.0.0.1:$HEARTH_PORT/health" >/dev/null 2>&1
}

# Report a start that never became healthy. A bare "did not come up" sends the reader hunting, so
# say who was asked, on which port, quote the end of the log (the reason is almost always there),
# and name the two things they can do from this terminal.
failed_to_start() {
  local who="$1" port="$HEARTH_PORT"
  {
    echo "hearth did not answer on http://127.0.0.1:$port/health after $who was asked to start it."
    echo "Either it is still coming up cold (up to 90s), or it stopped: the end of $LOG says which."
    if [ -s "$LOG" ]; then
      echo "--- last lines of $LOG ---"
      tail -n 15 "$LOG"
      echo "---"
    else
      echo "($LOG is empty — the process never got far enough to write anything.)"
    fi
    echo "Full log: tail -n 100 -f $LOG"
    echo "Check by hand: curl -s -H \"Authorization: Bearer \$(cat $TOKEN_FILE)\" http://127.0.0.1:$port/health"
    if [ "$who" = launchd ]; then
      echo "Is the agent loaded? launchctl list $LAUNCHD_LABEL (a non-zero second column is its last exit)."
    fi
  } >&2
}

# Which device launcher manages Hearth here, if any: "launchd", "windows", or "" (none).
supervisor_kind() {
  case "${HEARTH_SUPERVISOR:-auto}" in
    none) echo ""; return 0 ;;
    launchd|windows) echo "$HEARTH_SUPERVISOR"; return 0 ;;
  esac
  case "$(uname -s)" in
    Darwin)
      launchctl list "$LAUNCHD_LABEL" >/dev/null 2>&1 && echo launchd
      ;;
    *)
      if command -v schtasks >/dev/null 2>&1 && schtasks /query /tn Hearth >/dev/null 2>&1; then echo windows; fi
      ;;
  esac
}

# Delegate to the owning launcher. It restarts with its own environment and port, so this path
# never guesses the port — the reason `restart` used to start a stray second Hearth on 3002.
supervised() {
  local kind="$1" action="$2"
  case "$kind:$action" in
    launchd:stop) launchctl stop "$LAUNCHD_LABEL" ;;
    launchd:restart) launchctl stop "$LAUNCHD_LABEL" && launchctl start "$LAUNCHD_LABEL" ;;
    launchd:start) launchctl start "$LAUNCHD_LABEL" ;;
    windows:stop) schtasks /end /tn Hearth >/dev/null ;;
    windows:restart) schtasks /end /tn Hearth >/dev/null; schtasks /run /tn Hearth >/dev/null ;;
    windows:start) schtasks /run /tn Hearth >/dev/null ;;
  esac
}

running_pid() {
  [ -f "$PIDFILE" ] || return 1
  local pid
  pid="$(cat "$PIDFILE" 2>/dev/null || true)"
  [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null && echo "$pid"
}

start() {
  local kind
  if kind="$(supervisor_kind)" && [ -n "$kind" ]; then
    echo "hearth is managed by the $kind launcher; starting it there (port ${HEARTH_PORT})"
    supervised "$kind" start
    # Cold boots can take ~20s (model catalog restore + sqlite), well past the old 10s window.
    # Wait up to 90s rather than reporting a false failure and making a watchdog retry.
    for _ in $(seq 1 360); do health && break; sleep 0.25; done
    health || { failed_to_start "$kind"; return 1; }
    echo "hearth started → $(url 2>/dev/null || true)"
    return 0
  fi
  if health; then
    echo "hearth already healthy on :$HEARTH_PORT (supervisor pid $(running_pid || echo '?'))"
    return 0
  fi
  # Windows/Git Bash and macOS have no setsid; the fallback is a plain nohup detach.
  # `setsid` without -f keeps the pid (it only forks when it is already a group leader),
  # so the pidfile stays accurate while the supervisor still gets its own session.
  local detach
  if command -v setsid >/dev/null 2>&1; then
    detach="setsid"
  else
    detach="nohup"
  fi
  $detach bash -c '
    cd "'"$HEARTH_DIR"'"
    while true; do
      HEARTH_HOME="'"$HEARTH_HOME"'" HEARTH_PORT="'"$HEARTH_PORT"'" bun run src/index.ts
      code=$?
      echo "[supervisor] hearth exited ($code); restarting in 3s" >&2
      sleep 3
    done
  ' >>"$LOG" 2>&1 </dev/null &
  local pid=$!
  echo "$pid" >"$PIDFILE"
  disown 2>/dev/null || true
  # Container cold-boots can take ~20s, so the old 10s window reported failure on every start and
  # a container watchdog retried forever. Wait up to 90s.
  for _ in $(seq 1 360); do health && break; sleep 0.25; done
  if health; then
    echo "hearth started (supervisor pid $pid) → $(url 2>/dev/null || true)"
  else
    failed_to_start "this script's supervisor (pid $pid)"
    return 1
  fi
}

stop() {
  local kind
  if kind="$(supervisor_kind)" && [ -n "$kind" ]; then
    echo "hearth is managed by the $kind launcher; stopping it there"
    supervised "$kind" stop
    return 0
  fi
  local pid
  if pid="$(running_pid)"; then
    # A setsid supervisor is a process-group leader: signal the group so the bun child
    # goes too. Without setsid, fall back to the supervisor plus its children.
    kill -TERM -- "-$pid" 2>/dev/null || {
      pkill -TERM -P "$pid" 2>/dev/null || true
      kill -TERM "$pid" 2>/dev/null || true
    }
    sleep 1
    kill -KILL -- "-$pid" 2>/dev/null || { pkill -KILL -P "$pid" 2>/dev/null || true; kill -KILL "$pid" 2>/dev/null || true; }
    echo "hearth stopped (was pid $pid)"
  else
    echo "hearth is not running"
  fi
  rm -f "$PIDFILE"
}

# Pull the latest commit, install dependencies, and restart — the whole deploy in one command.
# (With HEARTH_AUTORELOAD the restart is usually automatic after a pull; `update` is the explicit
# path that also handles dependency changes, which auto-reload deliberately leaves alone.)
update() {
  echo "hearth: pulling $HEARTH_DIR"
  git -C "$HEARTH_DIR" pull --ff-only
  ( cd "$HEARTH_DIR" && bun install --frozen-lockfile )
  restart
}

# Age-out policy: drop old image payloads and archive idle conversations.
# Dry-run unless --apply, so `hearth.sh prune` on its own only reports.
# Stop Hearth first for a real run: a turn mid-write must not race row moves.
prune() {
  command -v python3 >/dev/null 2>&1 || { echo "python3 is required for prune" >&2; return 1; }
  HEARTH_HOME="$HEARTH_HOME" python3 "$HEARTH_DIR/scripts/hearth-prune.py" --home "$HEARTH_HOME" "$@"
}

status() {
  local kind
  kind="$(supervisor_kind)"
  if [ -n "$kind" ]; then
    echo "supervisor: $kind (port $HEARTH_PORT)"
  fi
  if health; then
    echo "hearth: running on :$HEARTH_PORT (supervisor pid $(running_pid || echo '?'))"
  elif running_pid >/dev/null; then
    echo "hearth: supervisor up, server not answering on :$HEARTH_PORT"
  else
    echo "hearth: stopped"
  fi
}

url() {
  local host="${HEARTH_URL_HOST:-}"
  if [ -z "$host" ] && command -v tailscale >/dev/null 2>&1; then
    host="$(tailscale ip -4 2>/dev/null | head -1 || true)"
  fi
  if [ -z "$host" ]; then
    case "$(uname -s)" in
      Darwin) host="$(ipconfig getifaddr en0 2>/dev/null || true)" ;;
      Linux) host="$(hostname -I 2>/dev/null | awk '{print $1}')" ;;
      *) host="" ;;
    esac
  fi
  if [ -z "$host" ]; then
    echo "note: set HEARTH_URL_HOST to the address other devices reach this one at" >&2
    host="127.0.0.1"
  fi
  echo "http://${host}:$HEARTH_PORT"
}

token() {
  [ -f "$TOKEN_FILE" ] || { echo "no token yet — start hearth first" >&2; exit 1; }
  cat "$TOKEN_FILE"
}

# Manage provider credentials through the running Hearth.
provider() {
  bun run "$HEARTH_DIR/scripts/provider.ts" "$@"
}

case "${1:-status}" in
  start) start ;;
  stop) stop ;;
  restart)
    if kind="$(supervisor_kind)" && [ -n "$kind" ]; then
      echo "hearth is managed by the $kind launcher; restarting it there (port ${HEARTH_PORT})"
      supervised "$kind" restart
      for _ in $(seq 1 360); do health && break; sleep 0.25; done
      health || { failed_to_start "$kind (restart)"; exit 1; }
      echo "hearth restarted → $(url 2>/dev/null || true)"
    else
      stop; start
    fi
    ;;
  update) update ;;
  prune) shift; prune "$@" ;;
  status) status ;;
  url) url ;;
  token) token ;;
  provider) shift; provider "$@" ;;
  logs) tail -n 40 -f "$LOG" ;;
  *)
    echo "usage: $0 start|stop|restart|update|prune|status|url|token|provider|logs" >&2
    exit 2
    ;;
esac
