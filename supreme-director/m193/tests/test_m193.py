"""M193 role, tenant, CRM, concurrency, HTTP and security regression tests."""
from __future__ import annotations

import concurrent.futures
import http.client
import json
from pathlib import Path
import sqlite3
import tempfile
import threading
import unittest

from http.server import ThreadingHTTPServer
from osgard_m192.runtime import Director, Conflict, Invalid, Unauthorized
from osgard_m193.runtime import Director193
from osgard_m193.server import handler_for

CLOCK = 1_800_000_000


class CRMTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.db = Path(self.tmp.name) / 'director.sqlite'
        self.app = Director193(self.db,clock=lambda:CLOCK)
        self.app.initialize()
        self.owner = self.app.provision('Company One','first_owner')['token']
        self.operator = self.app.issue_token(self.owner,'colleague','operator')['token']
        self.viewer = self.app.issue_token(self.owner,'observer','viewer')['token']
        self.other = self.app.provision('Company Two','other_owner')['token']
        self.seq = 0

    def call(self,op,payload=None,token=None,key=None):
        self.seq += 1
        iswrite = op.endswith(('.create','.update','.complete')) or op in {
            'commerce.customers.create','commerce.deals.create'}
        return self.app.execute(token or self.owner,op,payload or {},
                                key or ('m193-test-%08d'%self.seq if iswrite else None))

    def customer(self,token=None):
        return self.call('commerce.customers.create',{'name':'First Customer','contact':'contact@example.invalid'},token)

    def deal(self, customer=None, token=None):
        c = customer or self.customer(token)
        return self.call('commerce.deals.create',{'customer_id':c['id'],
            'title':'Service','amount_minor':125000,'stage':'new'},token)

    def test_session_is_tenant_and_role_bound(self):
        a = self.call('titan.session.get',token=self.viewer)
        self.assertEqual(a['role'],'viewer')
        self.assertEqual(a['actor'],'observer')
        self.assertNotIn('token',a)
        self.assertNotEqual(a['tenant_id'],self.call('titan.session.get',token=self.other)['tenant_id'])

    def test_existing_m192_customer_visible(self):
        c=self.customer()
        r=self.call('commerce.crm.customers.list')['customers'][0]
        self.assertEqual(r['id'],c['id']);self.assertEqual(r['version'],1)

    def test_customer_updates_and_version(self):
        c=self.customer()
        r=self.call('commerce.crm.customers.update',{'customer_id':c['id'],
            'expected_version':1,'name':'Updated Customer'})
        self.assertEqual(r['version'],2);self.assertEqual(r['contact'],c['contact'])
        self.assertEqual(self.call('commerce.crm.customers.list')['customers'][0]['version'],2)
        with self.assertRaises(Conflict):
            self.call('commerce.crm.customers.update',{'customer_id':c['id'],
                'expected_version':1,'name':'Stale'})

    def test_customer_update_idempotency(self):
        c=self.customer();p={'customer_id':c['id'],'expected_version':1,'name':'New Name'}
        a=self.call('commerce.crm.customers.update',p,key='same-key-customer')
        b=self.call('commerce.crm.customers.update',p,key='same-key-customer')
        self.assertEqual(a,b)
        self.assertEqual(self.call('commerce.crm.customers.list')['customers'][0]['version'],2)

    def test_idempotency_reuse_different_request(self):
        c=self.customer()
        self.call('commerce.crm.customers.update',{'customer_id':c['id'],
            'expected_version':1,'name':'One'},key='same-key-customer')
        with self.assertRaises(Conflict):
            self.call('commerce.crm.customers.update',{'customer_id':c['id'],
                'expected_version':1,'name':'Two'},key='same-key-customer')

    def test_viewer_reads_but_cannot_write(self):
        c=self.customer()
        self.assertEqual(len(self.call('commerce.crm.customers.list',token=self.viewer)['customers']),1)
        with self.assertRaises(Unauthorized):
            self.call('commerce.crm.customers.update',{'customer_id':c['id'],
                'expected_version':1,'contact':'no'},token=self.viewer)
        with self.assertRaises(Unauthorized):
            self.call('commerce.crm.activities.create',{
                'customer_id':c['id'],'kind':'call','details':'note'},token=self.viewer)

    def test_operator_can_write(self):
        c=self.customer()
        x=self.call('commerce.crm.customers.update',{'customer_id':c['id'],
            'expected_version':1,'name':'Operator Edit'},token=self.operator)
        self.assertEqual(x['version'],2)

    def test_cross_tenant_customer_update_rejected(self):
        c=self.customer()
        with self.assertRaises(Invalid):
            self.call('commerce.crm.customers.update',{'customer_id':c['id'],
                'expected_version':1,'name':'Attack'},token=self.other)
        self.assertEqual(self.call('commerce.crm.customers.list',token=self.other)['customers'],[])

    def test_customer_empty_patch_rejected(self):
        c=self.customer()
        with self.assertRaises(Invalid):
            self.call('commerce.crm.customers.update',{'customer_id':c['id'],'expected_version':1})

    def test_invalid_versions_rejected(self):
        c=self.customer()
        for v in (True,0,-1,'1',2**40):
            with self.subTest(v=v),self.assertRaises(Invalid):
                self.call('commerce.crm.customers.update',{'customer_id':c['id'],
                    'expected_version':v,'name':'Test'})

    def test_deal_list_has_customer_and_version(self):
        c=self.customer();d=self.deal(c)
        r=self.call('commerce.crm.deals.list')['deals'][0]
        self.assertEqual(r['id'],d['id']);self.assertEqual(r['version'],1)
        self.assertEqual(r['customer_name'],c['name'])

    def test_deal_stage_advances(self):
        d=self.deal();v=1
        for stage in ('qualified','proposal','won'):
            result=self.call('commerce.crm.deals.update',{
                'deal_id':d['id'],'expected_version':v,'stage':stage})
            v+=1;self.assertEqual(result['version'],v)
            self.assertEqual(result['stage'],stage)
        self.assertEqual(self.call('commerce.crm.deals.list')['deals'][0]['stage'],'won')

    def test_deal_stage_skipping_rejected(self):
        d=self.deal()
        with self.assertRaises(Conflict):
            self.call('commerce.crm.deals.update',{
                'deal_id':d['id'],'expected_version':1,'stage':'won'})

    def test_deal_terminal_reopen_rejected(self):
        d=self.deal()
        self.call('commerce.crm.deals.update',{
            'deal_id':d['id'],'expected_version':1,'stage':'lost'})
        with self.assertRaises(Conflict):
            self.call('commerce.crm.deals.update',{
                'deal_id':d['id'],'expected_version':2,'stage':'new'})

    def test_deal_title_and_amount_update(self):
        d=self.deal()
        r=self.call('commerce.crm.deals.update',{'deal_id':d['id'],'expected_version':1,
            'title':'Revised','amount_minor':49900})
        self.assertEqual((r['title'],r['amount_minor'],r['version']),('Revised',49900,2))

    def test_amount_boolean_rejected(self):
        d=self.deal()
        with self.assertRaises(Invalid):
            self.call('commerce.crm.deals.update',{'deal_id':d['id'],
                'expected_version':1,'amount_minor':True})

    def test_deal_cross_tenant_rejected(self):
        d=self.deal()
        with self.assertRaises(Invalid):
            self.call('commerce.crm.deals.update',{'deal_id':d['id'],'expected_version':1,
                'title':'Other'},token=self.other)

    def test_deal_concurrent_optimistic_lock(self):
        d=self.deal()
        def f(i):
            try:
                return self.app.execute(self.owner,'commerce.crm.deals.update',
                    {'deal_id':d['id'],'expected_version':1,'title':f'Variant {i}'},
                    f'm193-concurrent-{i:08d}')['version']
            except Conflict: return 'conflict'
        with concurrent.futures.ThreadPoolExecutor(max_workers=10) as executor:
            result=list(executor.map(f,range(10)))
        self.assertEqual(result.count(2),1)
        self.assertEqual(result.count('conflict'),9)

    def test_activity_create_list_and_complete(self):
        c=self.customer();d=self.deal(c)
        activity=self.call('commerce.crm.activities.create',{
            'customer_id':c['id'],'deal_id':d['id'],
            'kind':'call','details':'Schedule meeting',
            'due_at':CLOCK+3600})
        self.assertEqual(activity['version'],1)
        items=self.call('commerce.crm.activities.list')['activities']
        self.assertEqual(items[0]['deal_id'],d['id'])
        self.assertEqual(items[0]['customer_name'],c['name'])
        result=self.call('commerce.crm.activities.complete',{'activity_id':activity['id'],
            'expected_version':1})
        self.assertEqual(result['version'],2)
        self.assertEqual(self.call('commerce.crm.activities.list',{'status':'done'})['activities'][0]['status'],'done')

    def test_activity_complete_twice_fails(self):
        c=self.customer()
        a=self.call('commerce.crm.activities.create',{
            'customer_id':c['id'],'kind':'note','details':'Documentation'})
        self.call('commerce.crm.activities.complete',{'activity_id':a['id'],'expected_version':1})
        with self.assertRaises(Conflict):
            self.call('commerce.crm.activities.complete',{'activity_id':a['id'],'expected_version':1})

    def test_activity_due_range_and_boolean(self):
        c=self.customer()
        for due in (True,'tomorrow',CLOCK+86400*400):
            with self.subTest(due=due),self.assertRaises(Invalid):
                self.call('commerce.crm.activities.create',{'customer_id':c['id'],
                    'kind':'email','details':'Follow-up','due_at':due})

    def test_activity_wrong_deal_customer(self):
        c1=self.customer();c2=self.customer();d=self.deal(c1)
        with self.assertRaises(Invalid):
            self.call('commerce.crm.activities.create',{'customer_id':c2['id'],
                'deal_id':d['id'],'kind':'call','details':'Wrong'})

    def test_activity_cross_tenant_deal_rejected(self):
        c=self.customer();d=self.deal(c)
        other=self.customer(self.other)
        with self.assertRaises(Invalid):
            self.call('commerce.crm.activities.create',{'customer_id':other['id'],
                'deal_id':d['id'],'kind':'call','details':'Cross-tenant'},token=self.other)

    def test_activity_cross_tenant_complete_rejected(self):
        c=self.customer()
        a=self.call('commerce.crm.activities.create',{'customer_id':c['id'],
            'kind':'note','details':'Secrets'})
        with self.assertRaises(Invalid):
            self.call('commerce.crm.activities.complete',{'activity_id':a['id'],
                'expected_version':1},token=self.other)

    def test_activity_filter_tenant_bounded(self):
        c=self.customer()
        self.call('commerce.crm.activities.create',{'customer_id':c['id'],
            'kind':'call','details':'Mine'})
        self.assertEqual(self.call('commerce.crm.activities.list',token=self.other)['activities'],[])
        self.assertEqual(len(self.call('commerce.crm.activities.list',{'customer_id':c['id']})['activities']),1)

    def test_aggregate_pipeline_and_overdue(self):
        c=self.customer();d=self.deal(c)
        self.call('commerce.crm.deals.update',{'deal_id':d['id'],'expected_version':1,'stage':'qualified'})
        self.call('commerce.crm.activities.create',{'customer_id':c['id'],
            'kind':'call','details':'Overdue','due_at':CLOCK-3600})
        x=self.call('commerce.crm.overview')
        self.assertEqual(x['customers'],1);self.assertEqual(x['deals'],1)
        self.assertEqual(x['pipeline']['qualified']['amount_minor'],125000)
        self.assertEqual(x['pipeline']['new']['count'],0)
        self.assertEqual(x['overdue_activities'],1)
        self.assertFalse(x['simulated'])

    def test_aggregate_is_tenant_scoped(self):
        self.deal()
        self.assertEqual(self.call('commerce.crm.overview',token=self.other)['deals'],0)

    def test_audit_records_only_successful_writes(self):
        c=self.customer()
        before=len(self.call('titan.audit.list')['audit'])
        with self.assertRaises(Invalid):
            self.call('commerce.crm.customers.update',{
                'customer_id':c['id'],'expected_version':1,'name':''})
        self.assertEqual(len(self.call('titan.audit.list')['audit']),before)
        self.call('commerce.crm.customers.update',{
            'customer_id':c['id'],'expected_version':1,'name':'New'})
        self.assertEqual(len(self.call('titan.audit.list')['audit']),before+1)

    def test_old_m192_ops_still_work(self):
        t=self.call('titan.tasks.create',{'title':'Legacy task'})
        self.assertEqual(self.call('titan.tasks.list')['tasks'][0]['id'],t['id'])

    def test_initialize_is_idempotent_and_legacy_upgrade(self):
        self.app.initialize()
        self.assertEqual(self.call('commerce.crm.customers.list')['customers'],[])
        with tempfile.TemporaryDirectory() as tmp:
            old_db=Path(tmp)/'old.sqlite';old=Director(old_db,clock=lambda:CLOCK)
            old.initialize();owner=old.provision('Legacy','owner')['token']
            old.execute(owner,'commerce.customers.create',{'name':'Existing','contact':'X'},'legacy-key-0001')
            upgraded=Director193(old_db,clock=lambda:CLOCK);upgraded.initialize()
            self.assertEqual(upgraded.execute(owner,'commerce.crm.customers.list',{})['customers'][0]['version'],1)


class HTTPTests(unittest.TestCase):
    def setUp(self):
        folder=tempfile.TemporaryDirectory();self.addCleanup(folder.cleanup)
        app=Director193(Path(folder.name)/'app.sqlite',clock=lambda:CLOCK)
        app.initialize();self.token=app.provision('One','owner')['token']
        self.server=ThreadingHTTPServer(('127.0.0.1',0),handler_for(app))
        self.worker=threading.Thread(target=self.server.serve_forever,daemon=True)
        self.worker.start()
        self.addCleanup(self.server.server_close);self.addCleanup(self.server.shutdown)

    def request(self,method,path,body=None,headers=None):
        port=self.server.server_port
        conn=http.client.HTTPConnection('127.0.0.1',port,timeout=6)
        headers=headers or {}
        if body is not None:
            headers.setdefault('Content-Type','application/json')
            body=json.dumps(body)
        conn.request(method,path,body=body,headers=headers)
        res=conn.getresponse();content=res.read();status=res.status;hd=dict(res.getheaders())
        conn.close();return status,content,hd

    def test_static_studio_served(self):
        code,html,headers=self.request('GET','/studio/')
        self.assertEqual(code,200)
        self.assertIn(b'/studio/app.js',html)
        self.assertIn(b"frame-ancestors 'none'",headers['Content-Security-Policy'].encode())

    def test_javascript_and_css_served(self):
        for path,expect in [('/studio/app.js','javascript'),('/studio/styles.css','css')]:
            with self.subTest(path=path):
                code,data,hd=self.request('GET',path)
                self.assertEqual(code,200)
                self.assertIn(expect,hd['Content-Type'])
                self.assertTrue(data)

    def test_path_traversal_not_served(self):
        code,_,_=self.request('GET','/studio/../../runtime.py')
        self.assertEqual(code,404)

    def test_invalid_host_blocked(self):
        code,_,_=self.request('GET','/studio/',headers={'Host':'attacker.invalid'})
        self.assertEqual(code,403)

    def test_cross_origin_blocked(self):
        body={'operation':'titan.session.get','payload':{},'idempotency_key':None}
        code,_,_=self.request('POST','/v1/execute',body,headers={
            'Authorization':'Bearer '+self.token,'Origin':'https://attacker.invalid'})
        self.assertEqual(code,403)

    def test_same_origin_json_request(self):
        body={'operation':'titan.session.get','payload':{},'idempotency_key':None}
        port=self.server.server_port
        code,raw,_=self.request('POST','/v1/execute',body,headers={
            'Authorization':'Bearer '+self.token,
            'Origin':f'http://127.0.0.1:{port}'})
        self.assertEqual(code,200)
        self.assertEqual(json.loads(raw)['result']['role'],'owner')

    def test_no_cors_preflight(self):
        code,_,_=self.request('OPTIONS','/v1/execute')
        self.assertEqual(code,405)

    def test_cannot_provision_through_http(self):
        body={'operation':'titan.provision','payload':{},'idempotency_key':'invalid-op-0001'}
        code,_,_=self.request('POST','/v1/execute',body,headers={
            'Authorization':'Bearer '+self.token})
        self.assertEqual(code,422)

    def test_crm_http_new_and_read(self):
        create={'operation':'commerce.customers.create',
                'payload':{'name':'A','contact':'B'},'idempotency_key':'test-http-create-0001'}
        code,raw,_=self.request('POST','/v1/execute',create,headers={
            'Authorization':'Bearer '+self.token})
        self.assertEqual(code,200)
        result=json.loads(raw)['result']
        listbody={'operation':'commerce.crm.customers.list','payload':{},'idempotency_key':None}
        code,raw,_=self.request('POST','/v1/execute',listbody,headers={
            'Authorization':'Bearer '+self.token})
        self.assertEqual(code,200)
        self.assertEqual(json.loads(raw)['result']['customers'][0]['id'],result['id'])

if __name__=='__main__':
    unittest.main()
