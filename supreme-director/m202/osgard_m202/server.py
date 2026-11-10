"""Loopback-only M202 monitoring console sharing authenticated M201 API."""
from http.server import ThreadingHTTPServer
from pathlib import Path
from osgard_m192.runtime import Invalid
from osgard_m193.server import CSP
from osgard_m201.server import handler_for as parent_handler

WEB=Path(__file__).resolve().parent/"web"
ASSETS={
    "/watch":("index.html","text/html; charset=utf-8"),
    "/watch/":("index.html","text/html; charset=utf-8"),
    "/watch/app.js":("app.js","text/javascript; charset=utf-8"),
    "/watch/styles.css":("styles.css","text/css; charset=utf-8"),
}

def handler_for(engine):
    Parent=parent_handler(engine)
    class Handler(Parent):
        server_version="OSGARD-M202-local/1"
        def do_GET(self):
            if not self._host_allowed():
                self._send(403,{"error":"untrusted_host"})
                return
            if self.path in ASSETS:
                file,mime=ASSETS[self.path]
                contents=(WEB/file).read_bytes()
                self.send_response(200)
                for name,value in (
                    ("Content-Type",mime),
                    ("Content-Length",str(len(contents))),
                    ("Cache-Control","no-store"),
                    ("Content-Security-Policy",CSP),
                    ("X-Content-Type-Options","nosniff"),
                    ("X-Frame-Options","DENY"),
                    ("Referrer-Policy","no-referrer"),
                    ("Cross-Origin-Resource-Policy","same-origin"),
                ):
                    self.send_header(name,value)
                self.end_headers()
                self.wfile.write(contents)
                return
            return super().do_GET()
    return Handler

def serve(engine,port=8722,bind="127.0.0.1"):
    if bind not in ("127.0.0.1","::1","localhost"):
        raise Invalid("M202 may only bind on loopback")
    with ThreadingHTTPServer((bind,port),handler_for(engine)) as http:
        http.serve_forever()
