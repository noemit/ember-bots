#!/usr/bin/env bash
# Fan-out health check across every Hearth device. Prints one line per endpoint and exits
# non-zero if any is down.
#
#   scripts/health.sh [endpoints-file]
#
# The endpoints file defaults to $HEARTH_HOME/endpoints (or ~/.hearth/endpoints) and holds
# one endpoint per line:
#     <label>  <url>  <token|@tokenfile>
# Blank lines and # comments are ignored. `@file` reads the token from that file, so the
# container's own token can be referenced directly.
#
# Example:
#     Container  http://100.64.0.1:3002  @/root/.pi/hearth.token
#     Windows    http://100.64.0.1:3011  @~/.hearth/hearth.token
#     Local      http://127.0.0.1:3005   @~/.hearth/hearth.token
set -euo pipefail

FILE="${1:-${HEARTH_ENDPOINTS:-${HEARTH_HOME:-$HOME/.hearth}/endpoints}}"
if [ ! -f "$FILE" ]; then
  echo "no endpoints file at $FILE" >&2
  echo "create one with lines: <label> <url> <token|@tokenfile>" >&2
  exit 2
fi

failures=0
while IFS=$' \t' read -r label url tokenref; do
  [ -z "${label:-}" ] && continue
  case "$label" in \#*) continue ;; esac
  token="$tokenref"
  case "$tokenref" in @*) token="$(cat "${tokenref#@}" 2>/dev/null || true)" ;; esac
  if curl -fsS --max-time 3 -H "Authorization: Bearer $token" "${url%/}/health" >/dev/null 2>&1; then
    printf 'up    %-10s %s\n' "$label" "$url"
  else
    printf 'DOWN  %-10s %s\n' "$label" "$url"
    failures=$((failures + 1))
  fi
done <"$FILE"

if [ "$failures" -gt 0 ]; then
  echo "$failures endpoint(s) down" >&2
  exit 1
fi
echo "all endpoints up"
