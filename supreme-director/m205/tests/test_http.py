"""M205 actual loopback HTTP authorization, host and CSP tests."""
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
from osgard_m205.runtime import Director205
from osgard_m205.server import handler_for,serve


class HTTPTests(unittest.TestCase):
    def setUp(self):
        temp=tempfile.TemporaryDirectory(prefix="m205-http-")
        self.addCleanup(temp.cleanup)
        self.app=Director205(Path(temp.name)/"db.sqlite")
        self.app.initialize()
        self.owner=self.app.provision("Owner Company","boss")["token"]
        self.worker=self.app.issue_token(self.owner,"employee","operator")["token"]
        self.viewer=self.app.issue_token(self.owner,"reader","viewer")["token"]
        self.http=ThreadingHTTPServer(("127.0.0.1",0),handler_for(self.app))
        self.thread=threading.Thread(target=self.http.serve_forever,daemon=True)
        self.thread.start()
        self.addCleanup(lambda:(self.http.shutdown(),
                                self.http.server_close(),
                                self.thread.join(timeout=4)))
        self.root="http://127.0.0.1:"+str(self.http.server_port)

    def request(self,op,p=None,token=None,origin=None,idem=None):
        req=Request(self.root+"/v1/execute",data=json.dumps({
            "operation":op,"payload":p or {},"idempotency_key":idem
        }).encode(),method="POST",headers={
            "Content-Type":"application/json",
            "Authorization":"Bearer "+(token or self.owner),
            "Origin":origin or self.root,
        })
        with urlopen(req,timeout=6) as response:
            return response.status,json.loads(response.read())

    def test_static_panel_assets_with_csp(self):
        for uri in ("/cost-control/","/cost-control/app.js",
                    "/cost-control/styles.css"):
            with self.subTest(path=uri),urlopen(self.root+uri,timeout=5) as res:
                self.assertEqual(res.status,200)
                self.assertEqual(res.headers["Cache-Control"],"no-store")
                self.assertIn("default-src 'none'",
                              res.headers["Content-Security-Policy"])
                self.assertEqual(res.headers["X-Content-Type-Options"],"nosniff")
                self.assertTrue(res.read())

    def test_existing_m204_ui_still_accessible(self):
        with urlopen(self.root+"/economics/",timeout=6) as res:
            self.assertEqual(res.status,200)

    def test_owner_empty_portfolio(self):
        status,body=self.request("commerce.reconcile.portfolio")
        self.assertEqual(status,200)
        self.assertEqual(body["result"]["plans_total"],0)
        self.assertFalse(body["result"]["bank_verified"])

    def test_staff_denied_economic_portfolio(self):
        with self.assertRaises(HTTPError) as err:
            self.request("commerce.reconcile.portfolio",token=self.worker)
        self.assertEqual(err.exception.code,403)

    def test_viewer_denied_economic_portfolio(self):
        with self.assertRaises(HTTPError) as err:
            self.request("commerce.reconcile.portfolio",token=self.viewer)
        self.assertEqual(err.exception.code,403)

    def test_cross_origin_denied(self):
        with self.assertRaises(HTTPError) as err:
            self.request("commerce.reconcile.portfolio",
                         origin="https://unauthorized.invalid")
        self.assertEqual(err.exception.code,403)

    def test_bad_host_denied(self):
        conn=http.client.HTTPConnection("127.0.0.1",
                                        self.http.server_port,timeout=5)
        try:
            conn.request("GET","/cost-control/",headers={"Host":"evil.invalid"})
            self.assertEqual(conn.getresponse().status,403)
        finally:conn.close()

    def test_public_listener_refused(self):
        with self.assertRaises(Invalid):
            serve(self.app,bind="0.0.0.0")

    def test_without_token_rejected(self):
        req=Request(self.root+"/v1/execute",data=json.dumps({
            "operation":"commerce.reconcile.portfolio","payload":{}
        }).encode(),method="POST",headers={
            "Content-Type":"application/json","Origin":self.root,
        })
        with self.assertRaises(HTTPError) as err:
            urlopen(req,timeout=5)
        self.assertEqual(err.exception.code,401)

    def test_missing_idempotency_key_denied_for_mutation(self):
        with self.assertRaises(HTTPError) as err:
            self.request("commerce.recurring.add")
        self.assertEqual(err.exception.code,422)


if __name__=="__main__":
    unittest.main()
