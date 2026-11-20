"""Loopback-only finance studio served from the existing authenticated API."""
from http.server import ThreadingHTTPServer
from pathlib import Path
from osgard_m192.runtime import Invalid
from osgard_m193.server import CSP
from osgard_m197.server import handler_for as parent_handler

WEB = Path(__file__).resolve().parent / 'web'
ASSETS = {
    '/finance': ('index.html','text/html; charset=utf-8'),
    '/finance/': ('index.html','text/html; charset=utf-8'),
    '/finance/app.js': ('app.js','text/javascript; charset=utf-8'),
    '/finance/styles.css': ('styles.css','text/css; charset=utf-8'),
}


def handler_for(engine):
    Parent = parent_handler(engine)
    class Handler(Parent):
        server_version='OSGARD-M198-local/1'
        def do_GET(self):
            if not self._host_allowed():
                self._send(403,{'error':'untrusted_host'});return
            if self.path in ASSETS:
                filename,mime=ASSETS[self.path]
                content=(WEB/filename).read_bytes()
                self.send_response(200)
                for name,value in (
                    ('Content-Type',mime),('Content-Length',str(len(content))),
                    ('Content-Security-Policy',CSP),('Cache-Control','no-store'),
                    ('X-Content-Type-Options','nosniff'),('X-Frame-Options','DENY'),
                    ('Referrer-Policy','no-referrer'),('Cross-Origin-Resource-Policy','same-origin')):
                    self.send_header(name,value)
                self.end_headers();self.wfile.write(content);return
            return super().do_GET()
    return Handler


def serve(engine, port=8718, bind='127.0.0.1'):
    if bind not in ('127.0.0.1','::1','localhost'):
        raise Invalid('only loopback binding permitted')
    with ThreadingHTTPServer((bind,port),handler_for(engine)) as server:
        server.serve_forever()
