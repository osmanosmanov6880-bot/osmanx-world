"""M206 real local HTTP tests: static UI, owner role, same-origin, host."""
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
from osgard_m206.runtime import Director206
from osgard_m206.server import handler_for,serve


class AssuranceHTTPTests(unittest.TestCase):
    def setUp(self):
        temporary=tempfile.TemporaryDirectory(prefix="m206-http-")
        self.addCleanup(temporary.cleanup)
        self.engine=Director206(Path(temporary.name)/"db.sqlite")
        self.engine.initialize()
        self.owner=self.engine.provision("M206 HTTP Tenant","boss")["token"]
        self.staff=self.engine.issue_token(self.owner,"analyst","operator")["token"]
        self.viewer=self.engine.issue_token(self.owner,"reader","viewer")["token"]
        self.http=ThreadingHTTPServer(("127.0.0.1",0),handler_for(self.engine))
        self.thread=threading.Thread(target=self.http.serve_forever,daemon=True)
        self.thread.start()
        self.addCleanup(lambda:(
            self.http.shutdown(),self.http.server_close(),
            self.thread.join(timeout=4)
        ))
        self.base="http://127.0.0.1:"+str(self.http.server_port)

    def request(self,operation,payload=None,token=None,origin=None,idem=None):
        req=Request(self.base+"/v1/execute",data=json.dumps({
            "operation":operation,"payload":payload if payload is not None else {},
            "idempotency_key":idem
        }).encode(),method="POST",headers={
            "Content-Type":"application/json",
            "Authorization":"Bearer "+(token or self.owner),
            "Origin":origin or self.base,
        })
        with urlopen(req,timeout=6) as result:
            return result.status,json.loads(result.read())

    def test_static_assurance_assets_and_csp(self):
        for path in ("/assurance/","/assurance/app.js","/assurance/styles.css"):
            with self.subTest(path=path),urlopen(self.base+path,timeout=6) as r:
                self.assertEqual(r.status,200)
                self.assertEqual(r.headers["Cache-Control"],"no-store")
                self.assertEqual(r.headers["X-Content-Type-Options"],"nosniff")
                self.assertIn("default-src 'none'",
                              r.headers["Content-Security-Policy"])
                self.assertTrue(r.read())

    def test_prior_m205_static_ui_still_works(self):
        with urlopen(self.base+"/cost-control/",timeout=6) as r:
            self.assertEqual(r.status,200)

    def test_owner_can_read_empty_portfolio(self):
        status,response=self.request("commerce.assurance.portfolio")
        self.assertEqual(status,200)
        self.assertEqual(response["result"]["plans_total"],0)
        self.assertFalse(response["result"]["bank_verified"])

    def test_employee_cannot_read_portfolio(self):
        with self.assertRaises(HTTPError) as err:
            self.request("commerce.assurance.portfolio",token=self.staff)
        self.assertEqual(err.exception.code,403)

    def test_viewer_cannot_read_portfolio(self):
        with self.assertRaises(HTTPError) as err:
            self.request("commerce.assurance.portfolio",token=self.viewer)
        self.assertEqual(err.exception.code,403)

    def test_bad_origin_rejected(self):
        with self.assertRaises(HTTPError) as err:
            self.request("commerce.assurance.portfolio",
                         origin="https://external.invalid")
        self.assertEqual(err.exception.code,403)

    def test_host_header_rejected(self):
        conn=http.client.HTTPConnection("127.0.0.1",self.http.server_port,timeout=5)
        try:
            conn.request("GET","/assurance/",headers={"Host":"forbidden.invalid"})
            self.assertEqual(conn.getresponse().status,403)
        finally:
            conn.close()

    def test_public_listener_refused(self):
        with self.assertRaises(Invalid):
            serve(self.engine,bind="0.0.0.0")

    def test_request_without_token_rejected(self):
        req=Request(self.base+"/v1/execute",data=json.dumps({
            "operation":"commerce.assurance.portfolio","payload":{}
        }).encode(),method="POST",headers={
            "Content-Type":"application/json","Origin":self.base
        })
        with self.assertRaises(HTTPError) as err:
            urlopen(req,timeout=6)
        self.assertEqual(err.exception.code,401)

    def test_mutation_without_idempotency_rejected_as_422(self):
        with self.assertRaises(HTTPError) as err:
            self.request("commerce.assurance.scan",{"plan_id":"a"*32})
        self.assertEqual(err.exception.code,422)


if __name__=="__main__":
    unittest.main()
