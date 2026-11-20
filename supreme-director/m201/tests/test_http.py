"""M201 loopback integration: HTTP, same-origin, finance role boundaries."""
from http.server import ThreadingHTTPServer
from pathlib import Path
import json
import tempfile
import threading
import unittest
from urllib.error import HTTPError
from urllib.request import Request,urlopen

from osgard_m192.runtime import Invalid
from osgard_m201.runtime import Director201
from osgard_m201.server import handler_for,serve


class AlertHttpTests(unittest.TestCase):
    def setUp(self):
        tmp=tempfile.TemporaryDirectory(prefix='m201-http-')
        self.addCleanup(tmp.cleanup)
        self.engine=Director201(Path(tmp.name)/'local.sqlite')
        self.engine.initialize()
        self.owner=self.engine.provision('Test Studio','boss')['token']
        self.operator=self.engine.issue_token(self.owner,'staff','operator')['token']
        self.viewer=self.engine.issue_token(self.owner,'spectator','viewer')['token']
        self.http=ThreadingHTTPServer(('127.0.0.1',0),handler_for(self.engine))
        self.thread=threading.Thread(target=self.http.serve_forever,daemon=True)
        self.thread.start()
        self.addCleanup(lambda:(self.http.shutdown(),self.http.server_close(),
                                self.thread.join(timeout=3)))
        self.origin='http://127.0.0.1:'+str(self.http.server_port)

    def send(self,op,p=None,token=None,idem=None,origin=None):
        content=json.dumps({'operation':op,'payload':p or {},
                            'idempotency_key':idem}).encode()
        req=Request(self.origin+'/v1/execute',data=content,method='POST',headers={
            'Content-Type':'application/json',
            'Authorization':'Bearer '+(token or self.owner),
            'Origin':origin or self.origin
        })
        with urlopen(req,timeout=6) as result:
            return result.status,json.loads(result.read())

    def test_ui_static_files_and_headers(self):
        for path in ('/risks/','/risks/app.js','/risks/styles.css'):
            with self.subTest(path=path),urlopen(self.origin+path,timeout=5) as res:
                self.assertEqual(res.status,200)
                self.assertEqual(res.headers['Cache-Control'],'no-store')
                self.assertIn("default-src 'none'",res.headers['Content-Security-Policy'])
                self.assertEqual(res.headers['X-Content-Type-Options'],'nosniff')
                self.assertTrue(res.read())

    def test_policy_set_and_read_http(self):
        status,result=self.send('commerce.alerts.policy.set',
            {'expected_version':0,'config':{'months':3}},
            idem='m201-http-policy-001')
        self.assertEqual(status,200)
        self.assertEqual(result['result']['version'],1)
        _,saved=self.send('commerce.alerts.policy.get')
        self.assertEqual(saved['result']['config']['months'],3)

    def test_operator_cannot_fetch_financial_policy(self):
        with self.assertRaises(HTTPError) as error:
            self.send('commerce.alerts.policy.get',token=self.operator)
        self.assertEqual(error.exception.code,403)

    def test_operator_only_sees_mine(self):
        status,result=self.send('commerce.alerts.mine',token=self.operator)
        self.assertEqual(status,200)
        self.assertTrue(result['result']['financial_values_redacted'])
        self.assertEqual(result['result']['items'],[])

    def test_viewer_cannot_read_even_mine(self):
        with self.assertRaises(HTTPError) as error:
            self.send('commerce.alerts.mine',token=self.viewer)
        self.assertEqual(error.exception.code,403)

    def test_wrong_origin_denied(self):
        with self.assertRaises(HTTPError) as error:
            self.send('commerce.alerts.mine',token=self.operator,
                      origin='https://untrusted.invalid')
        self.assertEqual(error.exception.code,403)

    def test_wrong_host_denied(self):
        import http.client
        conn=http.client.HTTPConnection('127.0.0.1',self.http.server_port,timeout=6)
        try:
            conn.request('GET','/risks/',headers={'Host':'attacker.invalid'})
            self.assertEqual(conn.getresponse().status,403)
        finally:
            conn.close()

    def test_public_bind_rejected(self):
        with self.assertRaises(Invalid):
            serve(self.engine,bind='0.0.0.0')


if __name__=='__main__':
    unittest.main()
