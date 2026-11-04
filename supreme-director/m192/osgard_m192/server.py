"""Localhost-only JSON API. Requests are authorized by provisioned bearer tokens.

No role or tenant is ever accepted from client-provided payloads.
"""
from __future__ import annotations

from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any
import json
from .runtime import Director, DirectorError, Invalid

MAX_BODY = 128 * 1024


def make_handler(engine: Director):
    class Handler(BaseHTTPRequestHandler):
        server_version = 'OSGARD-M192-local/1'
        def _send(self, code: int, data: dict):
            payload = json.dumps(data, ensure_ascii=True, allow_nan=False).encode()
            self.send_response(code)
            self.send_header('Content-Type','application/json; charset=utf-8')
            self.send_header('Cache-Control','no-store')
            self.send_header('X-Content-Type-Options','nosniff')
            self.send_header('Content-Security-Policy',"default-src 'none'")
            self.send_header('Content-Length',str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)
        def do_GET(self):
            if self.path == '/healthz':
                self._send(200, {'service':'OSGARD SUPREME DIRECTOR M192', 'status':'local', 'production':False})
            else:
                self._send(404, {'error':'not_found'})
        def do_POST(self):
            if self.path != '/v1/execute':
                self._send(404, {'error':'not_found'}); return
            length = self.headers.get('Content-Length','')
            if not length.isascii() or not length.isdecimal() or not 0 < int(length) <= MAX_BODY:
                self._send(413, {'error':'invalid_request_size'}); return
            auth = self.headers.get('Authorization','')
            if not auth.startswith('Bearer ') or len(auth) > 160:
                self._send(401, {'error':'bearer_token_required'}); return
            try:
                body = json.loads(self.rfile.read(int(length)))
                if not isinstance(body,dict) or set(body) != {'operation','payload','idempotency_key'}:
                    self._send(400, {'error':'invalid_envelope'}); return
                result = engine.execute(auth[len('Bearer '):],body['operation'],body['payload'],body['idempotency_key'])
                self._send(200, {'ok':True,'result':result,'environment':'LOCAL_ONLY'})
            except (ValueError, TypeError) as exc:
                self._send(400, {'error':'invalid_json_or_types'})
            except DirectorError as exc:
                self._send(exc.status, {'error':exc.__class__.__name__,'message':str(exc)})
        def log_message(self,fmt,*args):
            # Never log request bodies or bearer credentials.
            pass
    return Handler


def serve(engine: Director, port: int=8712, bind: str='127.0.0.1'):
    if bind not in ('127.0.0.1','::1','localhost'):
        raise Invalid('only loopback binding is permitted')
    with ThreadingHTTPServer((bind,port),make_handler(engine)) as httpd:
        httpd.serve_forever()
