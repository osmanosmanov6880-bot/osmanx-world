"""M205 local-only financial source control panel above full M204 HTTP API."""
from http.server import ThreadingHTTPServer
from pathlib import Path

from osgard_m192.runtime import Invalid
from osgard_m193.server import CSP
from osgard_m204.server import handler_for as parent_handler

WEB=Path(__file__).resolve().parent/"web"
ASSETS={
    "/cost-control":("index.html","text/html; charset=utf-8"),
    "/cost-control/":("index.html","text/html; charset=utf-8"),
    "/cost-control/app.js":("app.js","text/javascript; charset=utf-8"),
    "/cost-control/styles.css":("styles.css","text/css; charset=utf-8"),
}


def handler_for(engine):
    Parent=parent_handler(engine)
    class Handler(Parent):
        server_version="OSGARD-M205-local/1"

        def do_GET(self):
            if not self._host_allowed():
                self._send(403,{"error":"untrusted_host"})
                return
            if self.path in ASSETS:
                filename,mime=ASSETS[self.path]
                body=(WEB/filename).read_bytes()
                self.send_response(200)
                for name,value in (
                    ("Content-Type",mime),
                    ("Content-Length",str(len(body))),
                    ("Cache-Control","no-store"),
                    ("Content-Security-Policy",CSP),
                    ("X-Content-Type-Options","nosniff"),
                    ("X-Frame-Options","DENY"),
                    ("Referrer-Policy","no-referrer"),
                    ("Cross-Origin-Resource-Policy","same-origin"),
                ):
                    self.send_header(name,value)
                self.end_headers()
                self.wfile.write(body)
                return
            return super().do_GET()
    return Handler


def serve(engine,port=8725,bind="127.0.0.1"):
    if bind not in ("127.0.0.1","::1","localhost"):
        raise Invalid("M205 server requires a loopback listener")
    with ThreadingHTTPServer((bind,port),handler_for(engine)) as server:
        server.serve_forever()
