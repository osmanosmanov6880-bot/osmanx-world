"""Real M202 same-origin loopback HTTP smoke and authorization tests."""
from http.server import ThreadingHTTPServer
from pathlib import Path
import json
import tempfile
import threading
import unittest
from urllib.error import HTTPError
from urllib.request import Request,urlopen

from osgard_m192.runtime import Invalid
from osgard_m202.runtime import Director202
from osgard_m202.server import handler_for,serve


class MonitorHTTPTests(unittest.TestCase):
    def setUp(self):
        tmp=tempfile.TemporaryDirectory(prefix="m202-http-")
        self.addCleanup(tmp.cleanup)
        self.app=Director202(Path(tmp.name)/"local.sqlite")
        self.app.initialize()
        self.owner=self.app.provision("HTTP Company","boss")["token"]
        self.viewer=self.app.issue_token(self.owner,"visitor","viewer")["token"]
        self.server=ThreadingHTTPServer(("127.0.0.1",0),handler_for(self.app))
        self.thread=threading.Thread(target=self.server.serve_forever,daemon=True)
        self.thread.start()
        self.addCleanup(lambda:(self.server.shutdown(),self.server.server_close(),
                                self.thread.join(timeout=3)))
        self.base="http://127.0.0.1:"+str(self.server.server_port)

    def post(self,token=None,origin=None):
        req=Request(self.base+"/v1/execute",data=json.dumps({
            "operation":"commerce.monitor.schedule.get",
            "payload":{},"idempotency_key":None
        }).encode(),method="POST",headers={
            "Content-Type":"application/json",
            "Authorization":"Bearer "+(token or self.owner),
            "Origin":origin or self.base
        })
        with urlopen(req,timeout=5) as res:
            return json.loads(res.read())

    def test_static_assets(self):
        for path in ["/watch/","/watch/app.js","/watch/styles.css"]:
            with self.subTest(path=path),urlopen(self.base+path,timeout=5) as res:
                self.assertEqual(res.status,200)
                self.assertEqual(res.headers["Cache-Control"],"no-store")
                self.assertIn("default-src 'none'",
                              res.headers["Content-Security-Policy"])
                self.assertEqual(res.headers["X-Content-Type-Options"],"nosniff")
                self.assertTrue(res.read())

    def test_authenticated_schedule_http(self):
        self.assertFalse(self.post()["result"]["enabled"])

    def test_viewer_cannot_read_monitor(self):
        with self.assertRaises(HTTPError) as err:self.post(self.viewer)
        self.assertEqual(err.exception.code,403)

    def test_wrong_origin_denied(self):
        with self.assertRaises(HTTPError) as err:
            self.post(origin="https://example.invalid")
        self.assertEqual(err.exception.code,403)

    def test_host_restriction(self):
        import http.client
        conn=http.client.HTTPConnection("127.0.0.1",self.server.server_port,timeout=5)
        try:
            conn.request("GET","/watch/",headers={"Host":"foreign.invalid"})
            self.assertEqual(conn.getresponse().status,403)
        finally:conn.close()

    def test_public_bind_refused(self):
        with self.assertRaises(Invalid):
            serve(self.app,bind="0.0.0.0")


if __name__=="__main__":unittest.main()
