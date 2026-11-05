"""M203 local HTTP regression: UI assets, origin/host barriers, auth and RBAC."""
from http.server import ThreadingHTTPServer
from pathlib import Path
import json
import tempfile
import threading
import unittest
from urllib.error import HTTPError
from urllib.request import Request,urlopen

from osgard_m192.runtime import Invalid
from osgard_m203.runtime import Director203
from osgard_m203.server import handler_for,serve


class HTTPTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory(prefix="m203-http-")
        self.addCleanup(self.tmp.cleanup)
        self.app=Director203(Path(self.tmp.name)/"db.sqlite")
        self.app.initialize()
        self.owner=self.app.provision("HTTP Tenant","owner")["token"]
        self.operator=self.app.issue_token(self.owner,"staff","operator")["token"]
        self.viewer=self.app.issue_token(self.owner,"reader","viewer")["token"]
        self.http=ThreadingHTTPServer(("127.0.0.1",0),handler_for(self.app))
        self.thread=threading.Thread(target=self.http.serve_forever,daemon=True)
        self.thread.start()
        self.addCleanup(lambda:(
            self.http.shutdown(),self.http.server_close(),self.thread.join(timeout=5)
        ))
        self.root="http://127.0.0.1:"+str(self.http.server_port)

    def post(self,operation,token=None,origin=None):
        req=Request(self.root+"/v1/execute",data=json.dumps({
            "operation":operation,"payload":{},"idempotency_key":None
        }).encode(),method="POST",headers={
            "Content-Type":"application/json",
            "Authorization":"Bearer "+(token or self.owner),
            "Origin":origin or self.root,
        })
        with urlopen(req,timeout=6) as response:
            return response.status,json.loads(response.read())

    def test_russian_ui_js_css_served_no_cache(self):
        for path in ["/actions/","/actions/app.js","/actions/styles.css"]:
            with self.subTest(path=path),urlopen(self.root+path,timeout=6) as result:
                self.assertEqual(result.status,200)
                self.assertEqual(result.headers["Cache-Control"],"no-store")
                self.assertIn("default-src 'none'",
                              result.headers["Content-Security-Policy"])
                self.assertEqual(result.headers["X-Content-Type-Options"],"nosniff")
                self.assertTrue(result.read())

    def test_authenticated_owner_report(self):
        code,result=self.post("commerce.actions.report")
        self.assertEqual(code,200)
        self.assertEqual(result["result"]["plan_count"],0)
        self.assertFalse(result["result"]["bank_verified"])

    def test_operator_only_own_tasks(self):
        code,result=self.post("commerce.actions.mine",token=self.operator)
        self.assertEqual(code,200)
        self.assertEqual(result["result"]["items"],[])
        self.assertTrue(result["result"]["financial_metrics_redacted"])

    def test_operator_denied_full_report(self):
        with self.assertRaises(HTTPError) as err:
            self.post("commerce.actions.report",token=self.operator)
        self.assertEqual(err.exception.code,403)

    def test_viewer_denied(self):
        with self.assertRaises(HTTPError) as err:
            self.post("commerce.actions.mine",token=self.viewer)
        self.assertEqual(err.exception.code,403)

    def test_cross_origin_denied(self):
        with self.assertRaises(HTTPError) as err:
            self.post("commerce.actions.report",origin="https://other.invalid")
        self.assertEqual(err.exception.code,403)

    def test_foreign_host_denied(self):
        import http.client
        conn=http.client.HTTPConnection("127.0.0.1",self.http.server_port,timeout=6)
        try:
            conn.request("GET","/actions/",headers={"Host":"foreign.invalid"})
            self.assertEqual(conn.getresponse().status,403)
        finally:
            conn.close()

    def test_public_bind_refused(self):
        with self.assertRaises(Invalid):
            serve(self.app,bind="0.0.0.0")


if __name__=="__main__":
    unittest.main()
