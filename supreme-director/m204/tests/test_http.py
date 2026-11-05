"""M204 real loopback HTTP regression with role separation and same-origin."""
from http.server import ThreadingHTTPServer
from pathlib import Path
import http.client
import json
import tempfile
import threading
import unittest
from urllib.error import HTTPError
from urllib.request import Request,urlopen

from osgard_m192.runtime import Invalid
from osgard_m204.runtime import Director204
from osgard_m204.server import handler_for,serve


class LocalEconomicsHTTPTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory(prefix="m204-http-")
        self.addCleanup(self.tmp.cleanup)
        self.app=Director204(Path(self.tmp.name)/"database.sqlite")
        self.app.initialize()
        self.owner=self.app.provision("HTTP Tenant","boss")["token"]
        self.staff=self.app.issue_token(self.owner,"worker","operator")["token"]
        self.viewer=self.app.issue_token(self.owner,"observer","viewer")["token"]
        self.http=ThreadingHTTPServer(("127.0.0.1",0),handler_for(self.app))
        self.thread=threading.Thread(target=self.http.serve_forever,daemon=True)
        self.thread.start()
        self.addCleanup(lambda:(
            self.http.shutdown(),self.http.server_close(),
            self.thread.join(timeout=5)
        ))
        self.root="http://127.0.0.1:"+str(self.http.server_port)

    def request(self,op,p=None,token=None,origin=None,idem=None):
        req=Request(self.root+"/v1/execute",data=json.dumps({
            "operation":op,"payload":p or {},"idempotency_key":idem
        }).encode(),method="POST",headers={
            "Content-Type":"application/json",
            "Authorization":"Bearer "+(token or self.owner),
            "Origin":origin or self.root,
        })
        with urlopen(req,timeout=6) as res:
            return res.status,json.loads(res.read())

    def test_static_local_ui_assets_csp(self):
        for path in ("/economics/","/economics/app.js",
                     "/economics/styles.css"):
            with self.subTest(path=path),urlopen(self.root+path,timeout=5) as res:
                self.assertEqual(res.status,200)
                self.assertEqual(res.headers["Cache-Control"],"no-store")
                self.assertIn("default-src 'none'",
                              res.headers["Content-Security-Policy"])
                self.assertEqual(res.headers["X-Content-Type-Options"],"nosniff")
                self.assertTrue(res.read())

    def test_owner_can_read_empty_portfolio(self):
        status,data=self.request("commerce.economics.portfolio")
        self.assertEqual(status,200)
        self.assertEqual(data["result"]["plans_total"],0)
        self.assertFalse(data["result"]["bank_verified"])

    def test_owner_can_read_empty_board(self):
        status,data=self.request("commerce.economics.priority.board")
        self.assertEqual(status,200)
        self.assertEqual(data["result"]["items"],[])

    def test_operator_cannot_read_economics(self):
        with self.assertRaises(HTTPError) as response:
            self.request("commerce.economics.portfolio",token=self.staff)
        self.assertEqual(response.exception.code,403)

    def test_viewer_cannot_read_economics(self):
        with self.assertRaises(HTTPError) as response:
            self.request("commerce.economics.priority.board",token=self.viewer)
        self.assertEqual(response.exception.code,403)

    def test_untrusted_origin_blocked(self):
        with self.assertRaises(HTTPError) as response:
            self.request("commerce.economics.portfolio",
                         origin="https://unauthorized.invalid")
        self.assertEqual(response.exception.code,403)

    def test_host_header_rejected(self):
        con=http.client.HTTPConnection("127.0.0.1",self.http.server_port,timeout=6)
        try:
            con.request("GET","/economics/",headers={"Host":"attacker.invalid"})
            self.assertEqual(con.getresponse().status,403)
        finally:con.close()

    def test_public_bind_rejected(self):
        with self.assertRaises(Invalid):
            serve(self.app,bind="0.0.0.0")

    def test_missing_token_denied(self):
        req=Request(self.root+"/v1/execute",data=json.dumps({
            "operation":"commerce.economics.portfolio","payload":{}
        }).encode(),method="POST",headers={
            "Content-Type":"application/json","Origin":self.root,
        })
        with self.assertRaises(HTTPError) as response:
            urlopen(req,timeout=6)
        self.assertEqual(response.exception.code,401)


if __name__=="__main__":
    unittest.main()
