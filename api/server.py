"""Standard-library HTTP adapter. Local runs and the front end's dev proxy.

    python3 -m api.server --db nzc.sqlite --port 8765

Not for production traffic: single-threaded, no TLS, and the organisation
comes from a header. The point is that nothing above this file knows any
of that.
"""

from __future__ import annotations

import argparse
import json
import mimetypes
from datetime import date
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from typing import Optional
from urllib.parse import parse_qs, urlparse

WEB_DIST = Path(__file__).resolve().parent.parent / "web" / "dist"

from store import Store

from .handlers import Context, handle
from .router import match

__all__ = ["make_server", "serve"]


def make_server(store: Store, host: str = "127.0.0.1", port: int = 8765, *,
                today: Optional[date] = None, default_org: Optional[str] = None,
                static_dir: Optional[Path] = None) -> HTTPServer:
    """`static_dir` is the built front end; anything not under /api is served
    from it, with unknown paths falling back to index.html for the SPA."""
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, fmt, *args):  # quiet
            pass

        def _dispatch(self, method: str) -> None:
            url = urlparse(self.path)
            if static_dir is not None and method == "GET" and not url.path.startswith("/api/"):
                return self._static(url.path)
            found = match(method, url.path)
            if found is None:
                return self._send(404, {"error": "no such route"})
            name, params = found
            params.update({k: v[-1] for k, v in parse_qs(url.query).items()})
            body: dict = {}
            length = int(self.headers.get("Content-Length") or 0)
            if length:
                try:
                    body = json.loads(self.rfile.read(length) or b"{}")
                except json.JSONDecodeError:
                    return self._send(400, {"error": "body is not JSON"})
            org = self.headers.get("X-Org-Id") or default_org
            if not org:
                return self._send(401, {"error": "X-Org-Id header is required"})
            ctx = Context(store=store, org_id=org, actor=self.headers.get("X-Actor") or "anonymous",
                          today=today or date.today())
            status, payload = handle(name, ctx, params, body)
            self._send(status, payload)

        def _send(self, status: int, payload) -> None:
            raw = json.dumps(payload).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(raw)))
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("Access-Control-Allow-Headers", "Content-Type, X-Org-Id, X-Actor")
            self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
            self.end_headers()
            self.wfile.write(raw)

        def _static(self, path: str) -> None:
            target = (static_dir / path.lstrip("/")).resolve()
            if not str(target).startswith(str(static_dir.resolve())) or not target.is_file():
                target = static_dir / "index.html"
            if not target.is_file():
                return self._send(404, {"error": "front end is not built; run npm run build in web/"})
            raw = target.read_bytes()
            self.send_response(200)
            self.send_header("Content-Type", mimetypes.guess_type(str(target))[0] or "application/octet-stream")
            self.send_header("Content-Length", str(len(raw)))
            self.end_headers()
            self.wfile.write(raw)

        def do_GET(self):
            self._dispatch("GET")

        def do_POST(self):
            self._dispatch("POST")

        def do_OPTIONS(self):
            self._send(204, {})

    return HTTPServer((host, port), Handler)


def serve(argv: Optional[list[str]] = None) -> None:
    ap = argparse.ArgumentParser(description="NZC AI Scope 3 API (local)")
    ap.add_argument("--db", default=":memory:")
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=8765)
    ap.add_argument("--org", default=None, help="default organisation when no X-Org-Id header")
    ap.add_argument("--seed", action="store_true", help="load the Welcome-shaped demo fixtures")
    ap.add_argument("--static", action="store_true", help="also serve the built front end from web/dist")
    args = ap.parse_args(argv)
    store = Store.open(args.db)
    if args.seed:
        from .seed import seed
        seed(store)
    httpd = make_server(store, args.host, args.port, default_org=args.org or ("org_welcome_shaped" if args.seed else None),
                        static_dir=WEB_DIST if args.static else None)
    print(f"NZC AI API on http://{args.host}:{args.port}  db={args.db}")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    serve()
