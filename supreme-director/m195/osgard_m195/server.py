"""M195 same-origin, loopback-only Russian Studio on top of M194."""
from __future__ import annotations

from http.server import ThreadingHTTPServer
from pathlib import Path

from osgard_m192.runtime import Invalid
from osgard_m193.server import CSP
from osgard_m194.server import handler_for as parent_handler

WEB=Path(__file__).parent / 'web'
ASSETS={
    '/studio':('index.html','text/html; charset=utf-8'),
    '/studio/':('index.html','text/html; charset=utf-8'),
    '/studio/app.js':('app.js','text/javascript; charset=utf-8'),
    '/studio/styles.css':('styles.css','text/css; charset=utf-8'),
    '/studio/ru.json':('ru.json','application/json; charset=utf-8'),
}

def handler_for(engine):
    Parent=parent_handler(engine)
    class Handler(Parent):
        server_version='OSGARD-M195-local/1'
        def do_GET(self):
            if not self._host_allowed():
                self._send(403,{'error':'untrusted_host'});return
            if self.path in ASSETS:
                filename,ctype=ASSETS[self.path]
                body=(WEB/filename).read_bytes()
                self.send_response(200)
                for name,value in (
                  ('Content-Type',ctype),('Content-Length',str(len(body))),
                  ('Cache-Control','no-store'),('Content-Security-Policy',CSP),
                  ('X-Content-Type-Options','nosniff'),('Referrer-Policy','no-referrer'),
                  ('Cross-Origin-Resource-Policy','same-origin'),('X-Frame-Options','DENY')):
                    self.send_header(name,value)
                self.end_headers();self.wfile.write(body);return
            super().do_GET()
    return Handler

def serve(engine,port=8715,bind='127.0.0.1'):
    if bind not in ('127.0.0.1','::1','localhost'):
        raise Invalid('only loopback binding is permitted')
    with ThreadingHTTPServer((bind,port),handler_for(engine)) as server:
        server.serve_forever()
