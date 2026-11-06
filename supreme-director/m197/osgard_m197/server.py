"""Same-origin project-card page, keeping M196 CRM studio unchanged."""
from http.server import ThreadingHTTPServer
from pathlib import Path
from osgard_m192.runtime import Invalid
from osgard_m193.server import CSP
from osgard_m196.server import handler_for as previous_handler

WEB=Path(__file__).resolve().parent/'web'
ASSETS={
 '/projects/':('index.html','text/html; charset=utf-8'),
 '/projects':('index.html','text/html; charset=utf-8'),
 '/projects/app.js':('app.js','text/javascript; charset=utf-8'),
 '/projects/styles.css':('styles.css','text/css; charset=utf-8'),
}

def handler_for(engine):
    Parent=previous_handler(engine)
    class Handler(Parent):
        server_version='OSGARD-M197-local/1'
        def do_GET(self):
            if not self._host_allowed():
                self._send(403,{'error':'untrusted_host'});return
            if self.path in ASSETS:
                filename, content_type=ASSETS[self.path]
                body=(WEB/filename).read_bytes()
                self.send_response(200)
                for key,value in (('Content-Type',content_type),('Content-Length',str(len(body))),
                    ('Cache-Control','no-store'),('Content-Security-Policy',CSP),
                    ('X-Content-Type-Options','nosniff'),('Referrer-Policy','no-referrer'),
                    ('Cross-Origin-Resource-Policy','same-origin'),('X-Frame-Options','DENY')):
                    self.send_header(key,value)
                self.end_headers()
                self.wfile.write(body)
                return
            return super().do_GET()
    return Handler


def serve(engine, port=8717, bind='127.0.0.1'):
    if bind not in ('127.0.0.1','::1','localhost'):
        raise Invalid('loopback binding required')
    with ThreadingHTTPServer((bind,port),handler_for(engine)) as server:
        server.serve_forever()
