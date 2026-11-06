"""M200 loopback HTTP, same-origin protections and actual forecast endpoint."""
from http.server import ThreadingHTTPServer
from pathlib import Path
import json
import tempfile
import threading
import unittest
from urllib.error import HTTPError
from urllib.request import Request, urlopen

from osgard_m192.runtime import Invalid
from osgard_m200.runtime import Director200
from osgard_m200.server import handler_for, serve


class HttpTests(unittest.TestCase):
    def setUp(self):
        tmp=tempfile.TemporaryDirectory(prefix='m200-http-')
        self.addCleanup(tmp.cleanup)
        self.engine=Director200(Path(tmp.name)/'db.sqlite')
        self.engine.initialize()
        self.owner=self.engine.provision('HTTP Demo','owner')['token']
        self.viewer=self.engine.issue_token(self.owner,'reader','viewer')['token']
        self.http=ThreadingHTTPServer(('127.0.0.1',0),handler_for(self.engine))
        self.worker=threading.Thread(target=self.http.serve_forever,daemon=True)
        self.worker.start()
        self.addCleanup(self.worker.join)
        self.addCleanup(self.http.server_close)
        self.addCleanup(self.http.shutdown)
        self.root='http://127.0.0.1:'+str(self.http.server_port)

    def post(self, token=None, origin=None):
        body=json.dumps({'operation':'commerce.cashflow.forecast',
                         'payload':{'months':3},'idempotency_key':None}).encode()
        req=Request(self.root+'/v1/execute',data=body,method='POST',headers={
            'Content-Type':'application/json',
            'Authorization':'Bearer '+(token or self.owner),
            'Origin':origin or self.root,
        })
        with urlopen(req,timeout=5) as response:
            return response.status,json.loads(response.read())

    def test_local_static_ui(self):
        for path in ['/cashflow/','/cashflow/app.js','/cashflow/styles.css']:
            with self.subTest(path=path),urlopen(self.root+path,timeout=5) as response:
                self.assertEqual(response.status,200)
                self.assertEqual(response.headers['Cache-Control'],'no-store')
                self.assertIn("default-src 'none'",response.headers['Content-Security-Policy'])
                self.assertTrue(response.read())

    def test_authenticated_forecast(self):
        status,data=self.post()
        self.assertEqual(status,200)
        self.assertEqual(len(data['result']['buckets']),3)
        self.assertFalse(data['result']['bank_verified'])

    def test_viewer_denied(self):
        with self.assertRaises(HTTPError) as context:
            self.post(self.viewer)
        self.assertEqual(context.exception.code,403)

    def test_cross_origin_denied(self):
        with self.assertRaises(HTTPError) as context:
            self.post(origin='https://untrusted.example')
        self.assertEqual(context.exception.code,403)

    def test_malicious_host_denied(self):
        import http.client
        con=http.client.HTTPConnection('127.0.0.1',self.http.server_port,timeout=5)
        try:
            con.request('GET','/cashflow/',headers={'Host':'evil.example'})
            self.assertEqual(con.getresponse().status,403)
        finally:
            con.close()

    def test_public_bind_refused(self):
        with self.assertRaises(Invalid):
            serve(self.engine,bind='0.0.0.0')


if __name__=='__main__':
    unittest.main()
