#!/usr/bin/env bash
# Serve the onboarding copy preview and accept its Save.
#
#   ./serve.sh              # http://127.0.0.1:5173 (falls forward if the port is taken)
#   ./serve.sh 8080         # a port of your choice
#   ./serve.sh 8080 0.0.0.0 # any interface — needed to open it from another machine
#
# `python3 -m http.server` is not enough: it answers 501 to POST, and Save is a POST so that the
# browser does not add an Origin header problem to a file that must also work from file://.
# The server below serves index.html from this directory and writes POST /save to copy.json here.
# It binds 127.0.0.1 unless a host is given: pass `0.0.0.0` (or the tailnet address) to reach it
# from the Mac, and remember there is no authentication on that endpoint.
set -euo pipefail

cd "$(dirname "$0")"

if ! command -v python3 >/dev/null 2>&1; then
  echo "serve.sh needs python3 on PATH." >&2
  exit 1
fi

exec python3 - "${1:-}" "${2:-}" <<'PY'
import json
import os
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ROOT = os.path.dirname(os.path.abspath(__file__))
TARGET = os.path.join(ROOT, "copy.json")
PREFERRED = int(sys.argv[1]) if len(sys.argv) > 1 and sys.argv[1].isdigit() else 5173
HOST = sys.argv[2] if len(sys.argv) > 2 and sys.argv[2] else "127.0.0.1"


class PreviewHandler(BaseHTTPRequestHandler):
    """Static files from this directory, plus POST /save → copy.json."""

    def _send(self, status, body, content_type="text/plain; charset=utf-8"):
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        path = self.path.split("?", 1)[0].split("#", 1)[0]
        if path in ("/", "/index.html"):
            path = "/index.html"
        relative = os.path.normpath(path.lstrip("/")).replace(os.sep, "/")
        candidate = os.path.join(ROOT, relative)
        if relative.startswith("..") or not os.path.isfile(candidate):
            return self._send(404, b"not found\n")
        content_type = {
            ".html": "text/html; charset=utf-8",
            ".json": "application/json; charset=utf-8",
            ".js": "text/javascript; charset=utf-8",
            ".css": "text/css; charset=utf-8",
        }.get(os.path.splitext(candidate)[1], "application/octet-stream")
        with open(candidate, "rb") as handle:
            self._send(200, handle.read(), content_type)

    def do_POST(self):
        if self.path.split("?", 1)[0] != "/save":
            return self._send(404, b"only POST /save is handled\n")
        try:
            length = int(self.headers.get("Content-Length") or 0)
            if length <= 0 or length > 2_000_000:
                raise ValueError("missing or oversized body")
            data = json.loads(self.rfile.read(length).decode("utf-8"))
            if not isinstance(data, dict) or not isinstance(data.get("_note"), str):
                raise ValueError("expected the preview tool's object with a _note key")
        except (ValueError, UnicodeDecodeError) as problem:
            return self._send(400, ("invalid JSON body: %s\n" % problem).encode("utf-8"))

        # The page already sorts and indents; re-serialising keeps the file stable even when the
        # body arrived minified or through a proxy.
        text = json.dumps(data, indent=2, sort_keys=True, ensure_ascii=False) + "\n"
        temporary = TARGET + ".tmp"
        with open(temporary, "w", encoding="utf-8") as handle:
            handle.write(text)
        os.replace(temporary, TARGET)
        body = json.dumps({"ok": True, "path": TARGET, "keys": len(data)}).encode("utf-8")
        self._send(200, body, "application/json; charset=utf-8")

    def log_message(self, fmt, *args):
        sys.stderr.write("%s %s\n" % (self.address_string(), fmt % args))


def start():
    port = PREFERRED
    for _ in range(20):
        try:
            return ThreadingHTTPServer((HOST, port), PreviewHandler), port
        except OSError:
            port += 1
    raise SystemExit("could not find a free port starting at %d" % PREFERRED)


server, port = start()
print("Onboarding copy preview: http://%s:%d/" % ("127.0.0.1" if HOST == "0.0.0.0" else HOST, port))
print("Save writes %s" % TARGET)
print("Ctrl-C stops it.")
try:
    server.serve_forever()
except KeyboardInterrupt:
    print()
finally:
    server.server_close()
PY
