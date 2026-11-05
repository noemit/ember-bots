#!/usr/bin/env bash
# Back-compat alias: the control script replaced this. Use scripts/hearth.sh.
exec "$(cd "$(dirname "$0")" && pwd)/hearth.sh" start
