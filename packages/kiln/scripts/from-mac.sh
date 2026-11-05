#!/usr/bin/env bash
# Start/stop/inspect Hearth on a remote device over SSH.
#
#   scripts/from-mac.sh my-host start
#   scripts/from-mac.sh my-host status
#   scripts/from-mac.sh my-host restart
#   scripts/from-mac.sh my-host url           # prints the address Ember should use
#   scripts/from-mac.sh my-host token         # prints the bearer token
#
# Configure with env vars (or a positional host arg):
#   HEARTH_SSH_HOST=remote-host HEARTH_SSH_PORT=22 HEARTH_SSH_USER=root HEARTH_PORT=3002
#   scripts/from-mac.sh restart
#
# Note: `url` uses the SSH config's real HostName, and HEARTH_PORT is the *Hearth*
# port — not the SSH port.
set -euo pipefail

HOST="${HEARTH_SSH_HOST:-}"
SSH_PORT="${HEARTH_SSH_PORT:-22}"
HEARTH_PORT="${HEARTH_PORT:-3002}"
USER="${HEARTH_SSH_USER:-root}"
REMOTE_DIR="${HEARTH_REMOTE_DIR:-/workspace/hearth}"

# A first positional arg that is not a known command is treated as the host.
case "${1:-}" in
  start|stop|restart|update|status|url|token|logs) COMMAND="${1:-status}" ;;
  '') COMMAND=status ;;
  *) HOST="$1"; COMMAND="${2:-status}" ;;
esac

if [ -z "$HOST" ]; then
  echo "usage: HEARTH_SSH_HOST=<host> $0 [command] | $0 <host> [command]" >&2
  exit 2
fi

# From the client machine, the device's own address is the SSH host — that is the URL Ember uses.
if [ "$COMMAND" = "url" ]; then
  URL_HOST="${HEARTH_URL_HOST:-$(ssh -G "$HOST" 2>/dev/null | awk '/^hostname /{print $2; exit}')}"
  echo "http://${URL_HOST:-$HOST}:$HEARTH_PORT"
  exit 0
fi

ssh -p "$SSH_PORT" -o ConnectTimeout=8 "$USER@$HOST" \
  "HEARTH_PORT='$HEARTH_PORT' $REMOTE_DIR/scripts/hearth.sh $COMMAND"
