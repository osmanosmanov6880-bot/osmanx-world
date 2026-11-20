"""Local HTTP finance studio and authenticated operations, no public networking."""
import json
from http.server import ThreadingHTTPServer
from pathlib import Path
import tempfile
import threading
import unittest
from urllib.error import HTTPError
from urllib.request import Request, urlopen

from osgard_m198.runtime import Director198
from osgard_m198.server import handler_for


class FinanceHTTPTests(unittest.TestCase):
    def setUp(self):
        temporary=tempfile.TemporaryDirectory();self.addCleanup(temporary.cleanup)
        app=Director198(Path(temporary.name)/'db.sqlite');app.initialize()
        self.owner=app.provision('HTTP Tenant','boss')['token']
        self.viewer=app.issue_token(self.owner,'reader','viewer')['token']
        self.customer=app.execute(self.owner,'commerce.customers.create',{'name':'One','contact':'x'},'create-customer1')['id']
        self.deal=app.execute(self.owner,'commerce.deals.create',{'customer_id':self.customer,'title':'Build','amount_minor':200000,'stage':'new'},'create-deal1')['id']
        self.project=app.execute(self.owner,'commerce.projects.create',{'deal_id':self.deal,'title':'Finance project'},'create-project1')['id']
        self.http=ThreadingHTTPServer(('127.0.0.1',0),handler_for(app))
        self.thread=threading.Thread(target=self.http.serve_forever,daemon=True);self.thread.start()
        self.addCleanup(self.http.server_close)
        self.addCleanup(self.http.shutdown)
        self.origin='http://127.0.0.1:'+str(self.http.server_port)

    def query(self,token=None,op='commerce.finance.snapshot',payload=None,write=False,origin=None,host=None):
        body=json.dumps({'operation':op,'payload':payload or {'project_id':self.project},'idempotency_key':'test-http-write1' if write else None}).encode()
        headers={'Authorization':'Bearer '+(token or self.owner),'Content-Type':'application/json','Origin':origin or self.origin}
        if host:headers['Host']=host
        req=Request(self.origin+'/v1/execute',data=body,headers=headers,method='POST')
        with urlopen(req,timeout=4) as r:return json.loads(r.read())

    def test_page_has_m198_live_ui(self):
        with urlopen(self.origin+'/finance/',timeout=4) as r:
            text=r.read().decode('utf8')
            self.assertIn('Финансовый контроль',text)
            self.assertIn('/finance/app.js',text)
            self.assertEqual(r.headers.get('X-Content-Type-Options'),'nosniff')
            self.assertIn("default-src 'none'",r.headers.get('Content-Security-Policy'))

    def test_server_owns_russian_js_and_css(self):
        for path,piece in [('/finance/app.js',b'commerce.finance.snapshot'),('/finance/styles.css',b'.metric')]:
            with self.subTest(path=path),urlopen(self.origin+path,timeout=4) as r:self.assertIn(piece,r.read())

    def test_api_budget_round_trip(self):
        payload={'project_id':self.project,'expected_version':0,'budget_minor':123456}
        out=self.query(op='commerce.finance.budget.set',payload=payload,write=True)['result']
        self.assertEqual(out['version'],1)
        snapshot=self.query()['result']['summary']
        self.assertEqual(snapshot['budget_minor'],123456)
        self.assertFalse(snapshot['production_authorized'])

    def test_viewer_denied_financials(self):
        with self.assertRaises(HTTPError) as error:self.query(token=self.viewer)
        self.assertEqual(error.exception.code,403)

    def test_cross_site_post_rejected(self):
        with self.assertRaises(HTTPError) as error:self.query(origin='http://evil.invalid')
        self.assertEqual(error.exception.code,403)

    def test_host_validation_rejects_external_hostname(self):
        req=Request(self.origin+'/finance/',headers={'Host':'malicious.example'})
        with self.assertRaises(HTTPError) as error:urlopen(req,timeout=4)
        self.assertEqual(error.exception.code,403)

    def test_no_public_bind(self):
        from osgard_m198.server import serve
        from osgard_m192.runtime import Invalid
        with self.assertRaises(Invalid):serve(None,bind='0.0.0.0')


if __name__=='__main__':unittest.main()
