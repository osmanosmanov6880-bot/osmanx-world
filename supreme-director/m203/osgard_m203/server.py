"""M203 same-origin local UI over complete M192-M202 authenticated API."""
from http.server import ThreadingHTTPServer
from pathlib import Path

from osgard_m192.runtime import Invalid
from osgard_m193.server import CSP
from osgard_m202.server import handler_for as parent_handler

WEB=Path(__file__).resolve().parent/"web"
ASSETS={
    "/actions":("index.html","text/html; charset=utf-8"),
    "/actions/":("index.html","text/html; charset=utf-8"),
    "/actions/app.js":("app.js","text/javascript; charset=utf-8"),
    "/actions/styles.css":("styles.css","text/css; charset=utf-8"),
}


def handler_for(engine):
    Parent=parent_handler(engine)
    class Handler(Parent):
        server_version="OSGARD-M203-local/1"
        def do_GET(self):
            if not self._host_allowed():
                self._send(403,{"error":"untrusted_host"})
                return
            if self.path in ASSETS:
                name,mime=ASSETS[self.path]
                data=(WEB/name).read_bytes()
                self.send_response(200)
                for header,value in (
                    ("Content-Type",mime),
                    ("Content-Length",str(len(data))),
                    ("Cache-Control","no-store"),
                    ("Content-Security-Policy",CSP),
                    ("X-Content-Type-Options","nosniff"),
                    ("X-Frame-Options","DENY"),
                    ("Referrer-Policy","no-referrer"),
                    ("Cross-Origin-Resource-Policy","same-origin"),
                ):
                    self.send_header(header,value)
                self.end_headers()
                self.wfile.write(data)
                return
            return super().do_GET()
    return Handler


def serve(engine,port=8723,bind="127.0.0.1"):
    if bind not in ("127.0.0.1","::1","localhost"):
        raise Invalid("M203 server must bind to loopback only")
    with ThreadingHTTPServer((bind,port),handler_for(engine)) as http:
        http.serve_forever()
