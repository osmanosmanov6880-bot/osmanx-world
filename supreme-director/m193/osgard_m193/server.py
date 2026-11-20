"""Same-origin localhost cockpit. Never exposes provisioning on HTTP."""
from __future__ import annotations

from http.server import ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit

from osgard_m192.runtime import Invalid
from osgard_m192.server import make_handler as make_m192_handler

ASSETS = {
    '/studio': ('index.html','text/html; charset=utf-8'),
    '/studio/': ('index.html','text/html; charset=utf-8'),
    '/studio/app.js': ('app.js','text/javascript; charset=utf-8'),
    '/studio/styles.css': ('styles.css','text/css; charset=utf-8'),
}
WEB = Path(__file__).parent / 'web'
CSP = "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'"


def handler_for(engine):
    Parent = make_m192_handler(engine)

    class Handler(Parent):
        server_version = 'OSGARD-M193-local/1'

        def _host_allowed(self):
            host = self.headers.get('Host','')
            try:
                parsed = urlsplit('http://' + host)
                return (parsed.hostname in ('127.0.0.1','localhost','::1')
                        and parsed.port == self.server.server_port)
            except ValueError:
                return False

        def _origin_allowed(self):
            origin = self.headers.get('Origin')
            if origin is None:
                return True
            try:
                p = urlsplit(origin)
                host = urlsplit('http://' + self.headers.get('Host',''))
                return (p.scheme == 'http' and p.username is None and
                        p.hostname == host.hostname and p.port == host.port and
                        not p.path and not p.query and not p.fragment)
            except ValueError:
                return False

        def do_GET(self):
            if not self._host_allowed():
                self._send(403,{'error':'untrusted_host'}); return
            if self.path in ASSETS:
                filename, content_type = ASSETS[self.path]
                content = (WEB / filename).read_bytes()
                self.send_response(200)
                self.send_header('Content-Type',content_type)
                self.send_header('Content-Length',str(len(content)))
                self.send_header('Cache-Control','no-store')
                self.send_header('Content-Security-Policy',CSP)
                self.send_header('X-Content-Type-Options','nosniff')
                self.send_header('Referrer-Policy','no-referrer')
                self.send_header('X-Frame-Options','DENY')
                self.send_header('Cross-Origin-Resource-Policy','same-origin')
                self.end_headers()
                self.wfile.write(content)
                return
            super().do_GET()

        def do_POST(self):
            if not self._host_allowed():
                self._send(403,{'error':'untrusted_host'}); return
            if not self._origin_allowed():
                self._send(403,{'error':'cross_site_origin'}); return
            return super().do_POST()

        def do_OPTIONS(self):
            self._send(405,{'error':'cors_not_supported'})

    return Handler


def serve(engine, port=8713, bind='127.0.0.1'):
    if bind not in ('127.0.0.1','::1','localhost'):
        raise Invalid('only loopback binding is permitted')
    with ThreadingHTTPServer((bind,port),handler_for(engine)) as server:
        server.serve_forever()
