"""M194 offline tenant isolation, CSV safety, concurrency and HTTP checks."""
from __future__ import annotations

import concurrent.futures
from http.server import ThreadingHTTPServer
import http.client
import json
from pathlib import Path
import tempfile
import threading
import unittest
import uuid

from osgard_m192.runtime import Invalid, Conflict, Unauthorized
from osgard_m194.runtime import Director194
from osgard_m194.server import handler_for

CLOCK = 1810000000


class M194Tests(unittest.TestCase):
    def setUp(self):
        folder = tempfile.TemporaryDirectory(prefix='osgard-m194-test-')
        self.addCleanup(folder.cleanup)
        self.app = Director194(Path(folder.name)/'crm.sqlite',clock=lambda: CLOCK)
        self.app.initialize()
        self.owner = self.app.provision('Tenant One','owner')['token']
        self.other = self.app.provision('Tenant Two','other')['token']
        self.viewer = self.app.issue_token(self.owner,'reader','viewer')['token']
        self.operator = self.app.issue_token(self.owner,'operator','operator')['token']

    def call(self, op, payload=None, token=None, key=None):
        return self.app.execute(token or self.owner,op,payload or {},
                                key or ('m194-'+uuid.uuid4().hex))

    def customer(self,name='Alice',contact='alice@ex.test',token=None):
        return self.call('commerce.customers.create',{'name':name,'contact':contact},token=token)

    def activity(self,customer=None,due=None,token=None):
        c=customer or self.customer(token=token)
        p={'customer_id':c['id'],'kind':'call','details':'Follow up'}
        if due is not None:p['due_at']=due
        return self.call('commerce.crm.activities.create',p,token)

    def test_import_preview_and_commit(self):
        source='name,contact\nAlice,alice@example.test\nBob,bob@example.test\n'
        preview=self.call('commerce.crm.import.preview',{'csv':source})
        self.assertEqual((preview['rows'],preview['to_create'],preview['already_exists']),(2,2,0))
        result=self.call('commerce.crm.import.commit',{'csv':source,'preview_sha256':preview['preview_sha256']})
        self.assertEqual(result['created'],2)
        self.assertEqual(len(self.call('commerce.crm.customers.list')['customers']),2)

    def test_import_idempotent_repeat(self):
        raw='name,contact\nAlice,alice@example.test\n'
        digest=self.call('commerce.crm.import.preview',{'csv':raw})['preview_sha256']
        p={'csv':raw,'preview_sha256':digest}
        first=self.call('commerce.crm.import.commit',p,key='same-import-0001')
        again=self.call('commerce.crm.import.commit',p,key='same-import-0001')
        self.assertEqual(first,again)
        self.assertEqual(len(self.call('commerce.crm.customers.list')['customers']),1)

    def test_import_idempotency_mismatch(self):
        a='name,contact\nAlice,a@t.test\n';b='name,contact\nBob,b@t.test\n'
        d=self.call('commerce.crm.import.preview',{'csv':a})['preview_sha256']
        self.call('commerce.crm.import.commit',{'csv':a,'preview_sha256':d},key='same-import-0002')
        with self.assertRaises(Conflict):
            self.call('commerce.crm.import.commit',{'csv':b,'preview_sha256':d},key='same-import-0002')

    def test_wrong_import_digest(self):
        with self.assertRaises(Conflict):
            self.call('commerce.crm.import.commit',{'csv':'name,contact\nAlice,a@b.test\n','preview_sha256':'a'*64})

    def test_existing_customer_requires_fresh_preview(self):
        source='name,contact\nAlice,alice@example.test\n'
        p=self.call('commerce.crm.import.preview',{'csv':source})
        self.customer('Alice','alice@example.test')
        q=self.call('commerce.crm.import.preview',{'csv':source})
        self.assertFalse(q['can_commit'])
        self.assertEqual(q['already_exists'],1)
        with self.assertRaises(Conflict):
            self.call('commerce.crm.import.commit',{'csv':source,'preview_sha256':p['preview_sha256']})

    def test_casefold_deduplication(self):
        with self.assertRaises(Invalid):
            self.call('commerce.crm.import.preview',{'csv':'name,contact\nAlice,A@X.Test\nalice,a@x.test\n'})

    def test_tenant_independent_import(self):
        source='name,contact\nAlice,alice@example.test\n'
        digest=self.call('commerce.crm.import.preview',{'csv':source})['preview_sha256']
        self.call('commerce.crm.import.commit',{'csv':source,'preview_sha256':digest})
        preview=self.call('commerce.crm.import.preview',{'csv':source},token=self.other)
        self.assertEqual(preview['to_create'],1)
        self.assertEqual(len(self.call('commerce.crm.customers.list',token=self.other)['customers']),0)

    def test_invalid_headers_or_extra_columns(self):
        for raw in ('first,contact\nAlice,A\n','name,contact\nAlice,A,Extra\n',
                    'name,contact\n', 'name,contact\n,A\n', 'name,contact\nAlice,\n'):
            with self.subTest(raw=raw),self.assertRaises(Invalid):
                self.call('commerce.crm.import.preview',{'csv':raw})

    def test_csv_formula_import_export(self):
        raw='name,contact\n"=SUM(1,2)","  +1+1"\n'
        digest=self.call('commerce.crm.import.preview',{'csv':raw})['preview_sha256']
        self.call('commerce.crm.import.commit',{'csv':raw,'preview_sha256':digest})
        output=self.call('commerce.crm.export.csv')
        self.assertEqual(output['count'],1)
        self.assertIn("'=SUM(1,2)",output['csv'])
        self.assertIn("'+1+1",output['csv'])

    def test_utf8_bom_quotes(self):
        source='\ufeffname,contact\n"Иван, Иванов","+7 912 456 7890"\n'
        result=self.call('commerce.crm.import.preview',{'csv':source})
        self.assertEqual(result['rows'],1)

    def test_reject_csv_controls(self):
        with self.assertRaises(Invalid):
            self.call('commerce.crm.import.preview',{'csv':'name,contact\nA,"Hi\nThere"\n'})
        with self.assertRaises(Invalid):
            self.call('commerce.crm.import.preview',{'csv':'name,contact\nA,hello\x00evil\n'})

    def test_csv_large_and_batch_limit(self):
        with self.assertRaises(Invalid):
            self.call('commerce.crm.import.preview',{'csv':'name,contact\n'+'a'*65536+',b\n'})
        raw='name,contact\n'+''.join(f'C{i},c{i}@t.test\n' for i in range(201))
        with self.assertRaises(Invalid):
            self.call('commerce.crm.import.preview',{'csv':raw})

    def test_export_owner_only_and_tenant_bound(self):
        self.customer('Alice','alice@example.test')
        self.customer('Bob','bob@example.test',token=self.other)
        x=self.call('commerce.crm.export.csv')['csv']
        self.assertIn('Alice',x);self.assertNotIn('Bob',x)
        with self.assertRaises(Unauthorized):
            self.call('commerce.crm.export.csv',token=self.operator)
        with self.assertRaises(Unauthorized):
            self.call('commerce.crm.export.csv',token=self.viewer)

    def test_viewer_cannot_preview_import(self):
        with self.assertRaises(Unauthorized):
            self.call('commerce.crm.import.preview',{'csv':'name,contact\nA,a\n'},token=self.viewer)

    def test_operator_can_import(self):
        raw='name,contact\nA,a\n'
        pre=self.call('commerce.crm.import.preview',{'csv':raw},token=self.operator)
        self.call('commerce.crm.import.commit',{'csv':raw,'preview_sha256':pre['preview_sha256']},token=self.operator)
        self.assertEqual(len(self.call('commerce.crm.customers.list')['customers']),1)

    def test_followups_urgency_and_sorting(self):
        c=self.customer()
        self.activity(c,CLOCK+600)
        self.activity(c,CLOCK-700)
        self.activity(c)
        self.activity(c,CLOCK+86400*50)
        r=self.call('commerce.crm.followups.queue',{'days':30})
        self.assertEqual(r['counts'],{'overdue':1,'upcoming':1,'unscheduled':1,'beyond_horizon':1})
        self.assertEqual([x['urgency'] for x in r['items']],['overdue','upcoming','unscheduled'])
        self.assertFalse(r['truncated'])

    def test_followup_unscheduled_filter_and_limit(self):
        c=self.customer()
        self.activity(c,CLOCK+200);self.activity(c,CLOCK+300);self.activity(c)
        q=self.call('commerce.crm.followups.queue',{'limit':1,'include_unscheduled':False})
        self.assertEqual(len(q['items']),1);self.assertTrue(q['truncated'])
        self.assertNotIn('unscheduled',[x['urgency'] for x in q['items']])

    def test_followup_queue_tenant_isolation(self):
        self.activity()
        self.assertEqual(self.call('commerce.crm.followups.queue',token=self.other)['items'],[])

    def test_followup_filter_validation(self):
        for p in ({'days':True},{'days':91},{'limit':0},{'include_unscheduled':1}):
            with self.subTest(p=p),self.assertRaises(Invalid):
                self.call('commerce.crm.followups.queue',p)

    def test_reschedule_and_optimistic_version(self):
        a=self.activity(due=CLOCK+100)
        p={'activity_id':a['id'],'expected_version':1,'due_at':CLOCK+500}
        x=self.call('commerce.crm.followups.reschedule',p)
        self.assertEqual(x['version'],2)
        with self.assertRaises(Conflict):
            self.call('commerce.crm.followups.reschedule',p)

    def test_reschedule_cannot_change_completed_activity(self):
        a=self.activity()
        self.call('commerce.crm.activities.complete',{'activity_id':a['id'],'expected_version':1})
        with self.assertRaises(Conflict):
            self.call('commerce.crm.followups.reschedule',{'activity_id':a['id'],'expected_version':2,'due_at':None})

    def test_reschedule_other_tenant_rejected(self):
        a=self.activity()
        with self.assertRaises(Invalid):
            self.call('commerce.crm.followups.reschedule',
                      {'activity_id':a['id'],'expected_version':1,'due_at':None},token=self.other)

    def test_bulk_complete_atomic_on_stale(self):
        a=self.activity();b=self.activity()
        with self.assertRaises(Conflict):
            self.call('commerce.crm.followups.bulk_complete',{'activities':[
                {'activity_id':a['id'],'expected_version':1},
                {'activity_id':b['id'],'expected_version':99}]})
        self.assertEqual(len(self.call('commerce.crm.activities.list',{'status':'open'})['activities']),2)

    def test_bulk_complete_idempotent(self):
        a=self.activity();b=self.activity()
        p={'activities':[{'activity_id':x['id'],'expected_version':1} for x in (a,b)]}
        r=self.call('commerce.crm.followups.bulk_complete',p,key='batch-closed-001')
        self.assertEqual(r['completed'],2)
        self.assertEqual(self.call('commerce.crm.followups.bulk_complete',p,key='batch-closed-001'),r)
        self.assertEqual(len(self.call('commerce.crm.activities.list',{'status':'done'})['activities']),2)

    def test_bulk_duplicate_rejected(self):
        a=self.activity()
        with self.assertRaises(Invalid):
            self.call('commerce.crm.followups.bulk_complete',{'activities':[
                {'activity_id':a['id'],'expected_version':1},
                {'activity_id':a['id'],'expected_version':1}]})

    def test_bulk_other_tenant_atomic(self):
        a=self.activity();b=self.activity(token=self.other)
        with self.assertRaises(Invalid):
            self.call('commerce.crm.followups.bulk_complete',{'activities':[
                {'activity_id':a['id'],'expected_version':1},
                {'activity_id':b['id'],'expected_version':1}]})
        self.assertEqual(len(self.call('commerce.crm.activities.list',{'status':'open'})['activities']),1)

    def test_concurrent_complete_one_wins(self):
        a=self.activity()
        def worker(n):
            try:
                self.call('commerce.crm.followups.bulk_complete',{'activities':[
                    {'activity_id':a['id'],'expected_version':1}]},key=f'concurrent-m194-{n:06d}')
                return 'won'
            except Conflict:
                return 'conflict'
        with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
            result=list(pool.map(worker,range(8)))
        self.assertEqual(result.count('won'),1)
        self.assertEqual(result.count('conflict'),7)

    def test_metrics_pipeline_and_rate(self):
        c=self.customer()
        for i,stage in enumerate(('new','qualified','proposal','won','lost')):
            self.call('commerce.deals.create',{'customer_id':c['id'],'title':f'Sale {i}',
                'amount_minor':(i+1)*1000,'stage':stage})
        m=self.call('commerce.crm.pipeline.metrics')
        self.assertEqual(m['total_deals'],5)
        self.assertEqual(m['active_amount_minor'],6000)
        self.assertEqual(m['won_amount_minor'],4000)
        self.assertEqual(m['win_rate_percent'],50.0)
        self.assertEqual(m['closed_deals'],2)

    def test_metrics_no_closed_and_tenant(self):
        c=self.customer();self.call('commerce.deals.create',
            {'customer_id':c['id'],'title':'New','amount_minor':10000,'stage':'new'})
        self.assertIsNone(self.call('commerce.crm.pipeline.metrics')['win_rate_percent'])
        self.assertEqual(self.call('commerce.crm.pipeline.metrics',token=self.other)['total_deals'],0)

    def test_failed_import_is_atomic_no_audit(self):
        self.customer('Alice','a.test')
        initial=len(self.call('titan.audit.list')['audit'])
        csv='name,contact\nAlice,a.test\nBob,b.test\n'
        sha=self.call('commerce.crm.import.preview',{'csv':csv})['preview_sha256']
        with self.assertRaises(Conflict):
            self.call('commerce.crm.import.commit',{'csv':csv,'preview_sha256':sha})
        self.assertEqual(len(self.call('commerce.crm.customers.list')['customers']),1)
        self.assertEqual(len(self.call('titan.audit.list')['audit']),initial)


class StudioHTTPTests(unittest.TestCase):
    def setUp(self):
        temp=tempfile.TemporaryDirectory(prefix='osgard-m194-server-');self.addCleanup(temp.cleanup)
        app=Director194(Path(temp.name)/'db.sqlite');app.initialize()
        token=app.provision('Local','owner')['token']
        self.token=token
        self.server=ThreadingHTTPServer(('127.0.0.1',0),handler_for(app))
        self.thread=threading.Thread(target=self.server.serve_forever,daemon=True)
        self.thread.start()
        self.addCleanup(self.thread.join)
        self.addCleanup(self.server.server_close)
        self.addCleanup(self.server.shutdown)
        self.port=self.server.server_port

    def request(self,method,path,body=None,host=None,origin=None):
        conn=http.client.HTTPConnection('127.0.0.1',self.port,timeout=5)
        headers={'Host':host or f'127.0.0.1:{self.port}'}
        if origin:headers['Origin']=origin
        if body is not None:
            headers['Authorization']='Bearer '+self.token
            headers['Content-Type']='application/json'
        conn.request(method,path,body=body,headers=headers)
        resp=conn.getresponse();payload=resp.read();metadata=dict(resp.getheaders());status=resp.status
        conn.close();return status,metadata,payload

    def test_russian_locale_is_served(self):
        status,meta,body=self.request('GET','/studio/ru.json')
        self.assertEqual(status,200)
        self.assertEqual(meta['Content-Security-Policy'].startswith("default-src 'none'"),True)
        self.assertEqual(json.loads(body)['operations'],'Операции')

    def test_studio_css_js_and_page(self):
        for path in ('/studio/','/studio/app.js','/studio/styles.css'):
            with self.subTest(path=path):
                status,_,payload=self.request('GET',path)
                self.assertEqual(status,200);self.assertTrue(payload)

    def test_untrusted_host_blocked(self):
        status,_,_=self.request('GET','/studio/ru.json',host=f'evil.example:{self.port}')
        self.assertEqual(status,403)

    def test_origin_guard_blocks_cross_site_post(self):
        status,_,_=self.request('POST','/v1/execute',
            body=json.dumps({'operation':'commerce.crm.pipeline.metrics','payload':{},'idempotency_key':None}),
            origin='https://evil.example')
        self.assertEqual(status,403)

    def test_authenticated_http_metrics(self):
        status,_,body=self.request('POST','/v1/execute',body=json.dumps(
            {'operation':'commerce.crm.pipeline.metrics','payload':{},'idempotency_key':None}))
        self.assertEqual(status,200)
        self.assertEqual(json.loads(body)['result']['total_deals'],0)


if __name__=='__main__':unittest.main()
