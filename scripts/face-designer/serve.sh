#!/usr/bin/env bash
# Serve the Mosaic face designer and accept its Save.
#
#   ./serve.sh              # http://127.0.0.1:5182 (falls forward if the port is taken)
#   ./serve.sh 8080         # a port of your choice
#   ./serve.sh 8080 0.0.0.0 # any interface — needed to open it from another machine
#   ./serve.sh --dist       # serve /dist instead of building; already-built page, faster
#
# The designer is a Vite page (`face-designer.html`), and Vite's own dev server cannot accept a POST
# to a file, so Save needs a server of its own. This one does two things: it serves the built page
# from `dist/` and the assets it pulls in, and it writes `POST /save` to `drawings.json` beside this
# script. That is the whole point — a drawing that only exists in `localStorage` cannot leave the
# browser except by copy-paste, and copy-paste is how the earlier bench lost drawings.
#
# It builds first because the page mounts through a module graph Vite only assembles properly when
# it starts; serving `dist/` from here keeps the save endpoint and the page on one origin, which is
# what stops the POST becoming a cross-origin request the browser refuses. Pass `--dist` to skip the
# build when one is already there.
#
# It binds 127.0.0.1 unless a host is given: `/save` has no authentication, so reaching it from the
# Mac means anyone on that network can overwrite the drawings file. Pass `0.0.0.0` deliberately.
set -euo pipefail

cd "$(dirname "$0")"

ROOT="$(cd ../.. && pwd)"
OUT="$(pwd)/drawings.json"
BUILD=1
ARGS=()
for arg in "$@"; do
  case "$arg" in
    --dist) BUILD=0 ;;
    *) ARGS+=("$arg") ;;
  esac
done

if ! command -v python3 >/dev/null 2>&1; then
  echo "serve.sh needs python3 on PATH." >&2
  exit 1
fi

if [ "$BUILD" = 1 ]; then
  echo "Building the designer page (bunx vite build)…"
  ( cd "$ROOT" && bunx vite build --logLevel warn )
fi

if [ ! -f "$ROOT/dist/face-designer.html" ]; then
  echo "No dist/face-designer.html — run without --dist so the page gets built." >&2
  exit 1
fi

exec python3 - "$ROOT/dist" "$OUT" "${ARGS[0]:-}" "${ARGS[1]:-}" <<'PY'
import json
import os
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ROOT = os.path.abspath(sys.argv[1])
TARGET = sys.argv[2]
PREFERRED = int(sys.argv[3]) if len(sys.argv) > 3 and sys.argv[3].isdigit() else 5182
HOST = sys.argv[4] if len(sys.argv) > 4 and sys.argv[4] else "127.0.0.1"
PAGE = "/face-designer.html"
# Vite emits `base: './'`, so the page's module and CSS links are relative to its own directory —
# which for `dist/face-designer.html` is the document root. Nothing to rewrite.
LIMIT = 8_000_000


class DesignerHandler(BaseHTTPRequestHandler):
    """Static files from dist/, plus POST /save → drawings.json beside this script."""

    def _send(self, status, body, content_type="text/plain; charset=utf-8"):
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        # The page is often re-served while a drawing is in flight; a stale module graph shows an
        # editor without the button that was just added, which reads as a broken save.
        self.send_header("Pragma", "no-cache")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        path = self.path.split("?", 1)[0].split("#", 1)[0]
        # `/` is the designer, not a directory listing: this server exists for that one page.
        if path in ("/", "/index.html", PAGE):
            path = PAGE
        # The drawings file lives beside this script, not in dist/, so it needs its own route.
        # Without it, Load 404s against the server that just wrote the file — which reads as a save
        # that did not happen.
        if path == "/drawings.json":
            relative = None
            candidate = TARGET
        else:
            relative = os.path.normpath(path.lstrip("/")).replace(os.sep, "/")
            candidate = os.path.join(ROOT, relative)
        if relative is not None and relative.startswith(".."):
            return self._send(404, b"not found\n")
        if not os.path.isfile(candidate):
            return self._send(404, b"not found\n")
        content_type = {
            ".html": "text/html; charset=utf-8",
            ".json": "application/json; charset=utf-8",
            ".js": "text/javascript; charset=utf-8",
            ".mjs": "text/javascript; charset=utf-8",
            ".css": "text/css; charset=utf-8",
            ".svg": "image/svg+xml",
            ".woff2": "font/woff2",
            ".png": "image/png",
            ".webp": "image/webp",
        }.get(os.path.splitext(candidate)[1], "application/octet-stream")
        with open(candidate, "rb") as handle:
            self._send(200, handle.read(), content_type)

    def do_POST(self):
        if self.path.split("?", 1)[0] != "/save":
            return self._send(404, b"only POST /save is handled\n")
        try:
            length = int(self.headers.get("Content-Length") or 0)
            if length <= 0 or length > LIMIT:
                raise ValueError("missing or oversized body")
            body = json.loads(self.rfile.read(length).decode("utf-8"))
            if not isinstance(body, dict) or not isinstance(body.get("drawings"), dict):
                raise ValueError("expected an object with a drawings map")
        except (ValueError, UnicodeDecodeError) as problem:
            return self._send(400, ("invalid JSON body: %s\n" % problem).encode("utf-8"))

        # Merge rather than replace. Saving one drawing while reviewing another must not erase the
        # second: the file is the collection, and the page only ever sends what it changed.
        existing = {"_note": "", "drawings": {}, "bodies": {}, "bodiesAt": None}
        if os.path.exists(TARGET):
            try:
                with open(TARGET, encoding="utf-8") as handle:
                    previous = json.load(handle)
                if isinstance(previous, dict):
                    existing.update(previous)
            except (ValueError, OSError):
                # A corrupt file is worth replacing, not worth failing the save over — the browser
                # still holds the drawing, so nothing is lost that the next save cannot restore.
                pass
        drawings = existing.get("drawings")
        if not isinstance(drawings, dict):
            drawings = {}
        drawings.update(body["drawings"])
        existing["drawings"] = drawings

        # Body assignments travel with the drawings so the exported file describes the whole set,
        # not just the art. A save without them (an old page, a hand-written POST) keeps what is
        # already there rather than blanking it.
        if isinstance(body.get("bodies"), dict):
            existing["bodies"] = body["bodies"]
            existing["bodiesAt"] = body.get("bodiesAt")
        existing["_note"] = body.get("_note") or "The Mosaic face designer's saved drawings and body assignments."

        # Sorted and indented here as well as in the page: the body may arrive minified or through a
        # proxy, and the file is meant to be read and diffed by a person.
        text = json.dumps(existing, indent=2, sort_keys=True, ensure_ascii=False) + "\n"
        temporary = TARGET + ".tmp"
        with open(temporary, "w", encoding="utf-8") as handle:
            handle.write(text)
        os.replace(temporary, TARGET)
        reply = json.dumps({"ok": True, "path": TARGET, "drawings": len(drawings)}).encode("utf-8")
        self._send(200, reply, "application/json; charset=utf-8")

    def log_message(self, fmt, *args):
        sys.stderr.write("%s %s\n" % (self.address_string(), fmt % args))


def start():
    port = PREFERRED
    for _ in range(20):
        try:
            return ThreadingHTTPServer((HOST, port), DesignerHandler), port
        except OSError:
            port += 1
    raise SystemExit("could not find a free port starting at %d" % PREFERRED)


server, port = start()
shown = "127.0.0.1" if HOST == "0.0.0.0" else HOST
print("Mosaic face designer: http://%s:%d/face-designer.html" % (shown, port))
print("Save writes %s" % TARGET)
print("Ctrl-C stops it.")
try:
    server.serve_forever()
except KeyboardInterrupt:
    print()
finally:
    server.server_close()
PY
