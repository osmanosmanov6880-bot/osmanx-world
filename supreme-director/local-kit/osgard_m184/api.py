"""Authenticated localhost HTTP service for OSGARD Director Studio.

Not externally accessible, not a production service, no accounts/SSO, and no
permission to merge, deploy, accept original tasks or move money.
"""
from __future__ import annotations

import hmac
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
import re
import secrets
from urllib.parse import parse_qs, urlsplit

from .storage import DirectorDB

LIMIT = 16_384
API_PREFIX = "/api/v1/"
IDENT = re.compile(r"[A-Za-z0-9_-]{1,80}\Z")


class LocalServer(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True

    def __init__(self, address, database, token, asset_root):
        if address[0] != "127.0.0.1":
            raise ValueError("loopback-only server")
        if not isinstance(token, str) or len(token) < 24:
            raise ValueError("strong ephemeral bearer token required")
        self.database = database
        self.token = token
        self.asset_root = Path(asset_root)
        super().__init__(address, make_handler())


def make_handler():
    class Handler(BaseHTTPRequestHandler):
        server_version = "OSGARD-Local-M184"
        sys_version = ""
        protocol_version = "HTTP/1.1"

        def log_message(self, fmt, *args):
            # No auth secrets or bodies in logs.
            pass

        def _security_headers(self, mimetype="application/json; charset=utf-8"):
            self.send_header("Content-Type", mimetype)
            self.send_header("X-Content-Type-Options", "nosniff")
            self.send_header("Cache-Control", "no-store")
            self.send_header("Referrer-Policy", "no-referrer")
            self.send_header("X-Frame-Options", "DENY")
            self.send_header("Content-Security-Policy", "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'")

        def _send(self, status, obj):
            raw = json.dumps(obj, sort_keys=True, ensure_ascii=False).encode("utf-8")
            self.send_response(status)
            self._security_headers()
            self.send_header("Content-Length", str(len(raw)))
            self.end_headers()
            self.wfile.write(raw)

        def _static(self, name, mime):
            root = self.server.asset_root
            p = root / name
            if not p.is_file() or p.is_symlink():
                return self._send(404, {"error": "not_found"})
            data = p.read_bytes()
            self.send_response(200)
            self._security_headers(mime)
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def _is_same_origin(self):
            host = self.headers.get("Host", "")
            expected = {f"127.0.0.1:{self.server.server_port}", f"localhost:{self.server.server_port}"}
            if host not in expected:
                return False
            origin = self.headers.get("Origin")
            if origin and origin not in {f"http://{h}" for h in expected}:
                return False
            site = self.headers.get("Sec-Fetch-Site")
            if site and site not in {"same-origin", "none"}:
                return False
            return True

        def _authorize(self):
            if not self._is_same_origin():
                self._send(403, {"error": "origin_denied"})
                return False
            header = self.headers.get("Authorization", "")
            expected = "Bearer " + self.server.token
            if not hmac.compare_digest(header, expected):
                self._send(401, {"error": "invalid_or_missing_local_token"})
                return False
            return True

        def _do_get(self, path, query):
            db = self.server.database
            if path == "/api/v1/summary": return db.summary()
            if path == "/api/v1/doctor": return db.doctor()
            if path == "/api/v1/tasks":
                team = query.get("team", [None])[0]
                search = query.get("q", [None])[0]
                return db.tasks(team, search)
            if path == "/api/v1/conflicts": return db.conflicts()
            if path == "/api/v1/contracts": return db.contracts()
            if path == "/api/v1/sources": return db.observations()
            if path == "/api/v1/audit": return db.audit()
            if path == "/api/v1/notes": return db.notes(query.get("kind", [None])[0], query.get("target", [None])[0])
            raise LookupError("route not found")

        def _do_post(self, path, data):
            db = self.server.database
            if path == "/api/v1/notes":
                return db.add_note(data.get("kind"), data.get("target"), data.get("actor"), data.get("note"))
            if path == "/api/v1/sources":
                return db.observe_source(data.get("repo"), data.get("branch"), data.get("sha"), data.get("actor"))
            match = re.fullmatch(r"/api/v1/conflicts/([A-Za-z0-9_-]{1,80})/triage", path)
            if match:
                return db.triage_conflict(match.group(1), data.get("status"), data.get("actor"), data.get("note"))
            raise LookupError("route not found")

        def do_GET(self):
            if not self._is_same_origin():
                return self._send(403, {"error": "origin_denied"})
            url = urlsplit(self.path)
            if url.path == "/": return self._static("studio.html", "text/html; charset=utf-8")
            if url.path == "/assets/studio.css": return self._static("studio.css", "text/css; charset=utf-8")
            if url.path == "/assets/studio.js": return self._static("studio.js", "text/javascript; charset=utf-8")
            if url.path == "/api/v1/health": return self._send(200, {"service": "M184_LOCAL_ONLY", "live": True, "release": "PRODUCTION_NO_GO"})
            if url.path.startswith(API_PREFIX):
                if not self._authorize(): return
                try:
                    return self._send(200, {"data": self._do_get(url.path, parse_qs(url.query, max_num_fields=6))})
                except LookupError:
                    return self._send(404, {"error": "not_found"})
                except ValueError:
                    return self._send(400, {"error": "invalid_request"})
                except Exception:
                    return self._send(500, {"error": "internal_failure"})
            return self._send(404, {"error": "not_found"})

        def do_POST(self):
            if not self._authorize(): return
            url = urlsplit(self.path)
            if url.query:
                return self._send(400, {"error": "unexpected_query"})
            media = self.headers.get("Content-Type", "").split(";")[0].strip().lower()
            if media != "application/json":
                return self._send(415, {"error": "json_required"})
            raw_len = self.headers.get("Content-Length", "")
            try: size = int(raw_len)
            except (ValueError, TypeError): size = -1
            if size < 2 or size > LIMIT:
                self.close_connection = True
                return self._send(413, {"error": "invalid_body_size"})
            data = self.rfile.read(size)
            try:
                obj = json.loads(data)
                if not isinstance(obj, dict) or len(obj) > 16:
                    raise ValueError("invalid JSON shape")
                result = self._do_post(url.path, obj)
                return self._send(201, {"data": result})
            except LookupError:
                return self._send(404, {"error": "not_found"})
            except (ValueError, UnicodeDecodeError, TypeError):
                return self._send(400, {"error": "invalid_request_or_transition"})
            except Exception:
                return self._send(500, {"error": "internal_failure"})

        def do_OPTIONS(self):
            return self._send(405, {"error": "no_cross_origin_requests"})

    return Handler


def serve(db_path, asset_root, port=8765, token=None):
    if not 0 <= port <= 65535:
        raise ValueError("port invalid")
    db = DirectorDB(db_path)
    if db.doctor()["health"] != "LOCAL_INTEGRITY_PASS":
        raise ValueError("doctor failed, refusing HTTP startup")
    token = token or secrets.token_urlsafe(32)
    http = LocalServer(("127.0.0.1", port), db, token, asset_root)
    return http, token
