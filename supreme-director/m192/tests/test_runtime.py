"""Offline negative/positive tests for actual M192 operations."""
import concurrent.futures
import http.client
import json
from pathlib import Path
import socket
import sys
import tempfile
import threading
import unittest

from http.server import ThreadingHTTPServer

sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from osgard_m192.runtime import Director, Unauthorized, Conflict, Invalid, canonical
from osgard_m192.server import make_handler


class RuntimeTests(unittest.TestCase):
    def setUp(self):
        temp=tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.app=Director(Path(temp.name)/'test.sqlite',clock=lambda:1_800_000_000)
        self.app.initialize()
        self.owner=self.app.provision('Org A','alice')['token']
        self.other=self.app.provision('Org B','bob')['token']
        self.viewer=self.app.issue_token(self.owner,'reader','viewer')['token']
        self.operator=self.app.issue_token(self.owner,'writer','operator')['token']
        self.num=0

    def call(self,op,p=None,token=None,key=None):
        self.num+=1
        return self.app.execute(token or self.owner,op,p if p is not None else {},key or ('operation-%06d'%self.num))

    def customer(self,token=None):
        return self.call('commerce.customers.create',{'name':'One','contact':'contact@example.test'},token=token)

    def test_provisioned_tokens_distinct(self):
        self.assertNotEqual(self.owner,self.other)
        self.assertNotIn(self.owner,str(self.app.database))

    def test_anonymous_rejected(self):
        with self.assertRaises(Unauthorized): self.app.execute('','commerce.customers.list',{})

    def test_expired_token_rejected(self):
        with self.app.connect(transaction=True) as db:
            db.execute('UPDATE api_keys SET expires_at=0')
        with self.assertRaises(Unauthorized): self.call('commerce.customers.list')

    def test_viewer_can_read(self):
        self.assertEqual(self.call('commerce.customers.list',token=self.viewer),{'customers':[]})

    def test_viewer_cannot_create(self):
        with self.assertRaises(Unauthorized): self.customer(token=self.viewer)

    def test_operator_cannot_use_orbital(self):
        with self.assertRaises(Unauthorized): self.call('orbital.emulator.list',token=self.operator)

    def test_operator_can_write_crm(self):
        self.assertEqual(self.customer(token=self.operator)['name'],'One')

    def test_operator_cannot_issue_token(self):
        with self.assertRaises(Unauthorized): self.app.issue_token(self.operator,'evil','owner')

    def test_tenant_customers_isolated(self):
        c=self.customer()
        self.assertEqual(len(self.call('commerce.customers.list',token=self.other)['customers']),0)
        self.assertEqual(self.call('commerce.customers.list')['customers'][0]['id'],c['id'])

    def test_idempotency_reuses_result(self):
        p={'name':'One','contact':'c'}
        a=self.call('commerce.customers.create',p,key='repeat-tenant-A')
        b=self.call('commerce.customers.create',p,key='repeat-tenant-A')
        self.assertEqual(a,b)
        self.assertEqual(len(self.call('commerce.customers.list')['customers']),1)

    def test_idempotency_collision_rejected(self):
        self.call('commerce.customers.create',{'name':'A','contact':'c'},key='repeated-key')
        with self.assertRaises(Conflict): self.call('commerce.customers.create',{'name':'B','contact':'c'},key='repeated-key')

    def test_idempotency_tenant_scoped(self):
        p={'name':'A','contact':'b'}
        a=self.call('commerce.customers.create',p,key='shared-key')
        b=self.call('commerce.customers.create',p,token=self.other,key='shared-key')
        self.assertNotEqual(a['id'],b['id'])

    def test_write_requires_idempotency_key(self):
        with self.assertRaises(Invalid): self.app.execute(self.owner,'commerce.customers.create',{'name':'A','contact':'B'})

    def test_unknown_operation_rejected(self):
        with self.assertRaises(Invalid): self.call('filesystem.delete',{})

    def test_extra_payload_fields_rejected(self):
        with self.assertRaises(Invalid): self.call('commerce.customers.create',{'name':'A','contact':'B','role':'admin'})

    def test_audit_writer_not_viewer(self):
        self.customer()
        audit=self.call('titan.audit.list')['audit']
        self.assertEqual(len(audit),1)
        with self.assertRaises(Unauthorized): self.call('titan.audit.list',token=self.viewer)

    def test_no_raw_token_stored(self):
        self.assertNotIn(self.owner,Path(self.app.database).read_bytes().decode('utf-8',errors='ignore'))

    def test_crm_deal_created(self):
        c=self.customer()
        deal=self.call('commerce.deals.create',{'customer_id':c['id'],'title':'Proposal','amount_minor':9500,'stage':'proposal'})
        self.assertEqual(self.call('commerce.deals.list')['deals'][0]['id'],deal['id'])

    def test_crm_deal_rejects_cross_tenant(self):
        c=self.customer()
        with self.assertRaises(Invalid): self.call('commerce.deals.create',{'customer_id':c['id'],'title':'X','amount_minor':1,'stage':'new'},token=self.other)

    def test_amount_boolean_rejected(self):
        c=self.customer()
        with self.assertRaises(Invalid):self.call('commerce.deals.create',{'customer_id':c['id'],'title':'X','amount_minor':True,'stage':'new'})

    def test_invalid_deal_stage_rejected(self):
        c=self.customer()
        with self.assertRaises(Invalid):self.call('commerce.deals.create',{'customer_id':c['id'],'title':'X','amount_minor':10,'stage':'hack'})

    def test_tasks_list(self):
        x=self.call('titan.tasks.create',{'title':'Build envelope'})
        self.assertEqual(self.call('titan.tasks.list')['tasks'][0]['id'],x['id'])

    def test_booking_overlapping_rejected(self):
        c=self.customer()
        p={'customer_id':c['id'],'resource':'seat1','start_at':1_800_000_100,'end_at':1_800_000_500}
        self.call('experience.book',p)
        with self.assertRaises(Conflict):self.call('experience.book',{**p,'start_at':1_800_000_200})

    def test_adjacent_bookings_allowed(self):
        c=self.customer()
        p={'customer_id':c['id'],'resource':'seat1','start_at':1_800_000_100,'end_at':1_800_000_500}
        self.call('experience.book',p)
        self.call('experience.book',{**p,'start_at':1_800_000_500,'end_at':1_800_000_700})
        self.assertEqual(len(self.call('experience.bookings.list')['bookings']),2)

    def test_booking_cancel_allows_rebook(self):
        c=self.customer()
        p={'customer_id':c['id'],'resource':'seat1','start_at':1_800_000_100,'end_at':1_800_000_500}
        x=self.call('experience.book',p)
        self.call('experience.cancel',{'booking_id':x['id']})
        self.call('experience.book',p)
        self.assertEqual(len(self.call('experience.bookings.list')['bookings']),2)

    def test_cannot_cancel_other_tenant(self):
        c=self.customer()
        x=self.call('experience.book',{'customer_id':c['id'],'resource':'room','start_at':1_800_000_100,'end_at':1_800_000_300})
        with self.assertRaises(Invalid):self.call('experience.cancel',{'booking_id':x['id']},token=self.other)

    def test_booking_concurrency_one_wins(self):
        c=self.customer()
        p={'customer_id':c['id'],'resource':'last-slot','start_at':1_800_000_200,'end_at':1_800_000_300}
        def book(i):
            try:return self.app.execute(self.owner,'experience.book',p,'parallel-key-%06d'%i)['state']
            except Conflict:return 'conflict'
        with concurrent.futures.ThreadPoolExecutor(max_workers=10) as executor:
            results=list(executor.map(book,range(10)))
        self.assertEqual(results.count('confirmed'),1)
        self.assertEqual(results.count('conflict'),9)

    def test_booking_rejected_past(self):
        c=self.customer()
        with self.assertRaises(Invalid):self.call('experience.book',{'customer_id':c['id'],'resource':'a','start_at':1,'end_at':2})

    def test_decision_graph_record(self):
        p={'question':'Choose path','alternatives':['a','b'],'chosen':'b','rationale':'measured impact'}
        self.call('nexus.decisions.create',p)
        self.assertEqual(self.call('nexus.decisions.list')['decisions'][0]['chosen'],'b')

    def test_decision_nonexistent_alternative(self):
        with self.assertRaises(Invalid): self.call('nexus.decisions.create',{'question':'Q','alternatives':['a','b'],'chosen':'c','rationale':'r'})

    def test_decision_tenant_isolation(self):
        self.call('nexus.decisions.create',{'question':'Q','alternatives':['a','b'],'chosen':'a','rationale':'r'})
        self.assertEqual(self.call('nexus.decisions.list',token=self.other)['decisions'],[])

    def test_scene_version_and_history(self):
        p={'scene_id':'lobby','expected_version':0,'nodes':[{'id':'camera','kind':'camera','position':[0,0,5]}]}
        first=self.call('genesis.scenes.save',p)
        second=self.call('genesis.scenes.save',{**p,'expected_version':1,'nodes':[]})
        self.assertEqual((first['version'],second['version']),(1,2))
        self.assertEqual(len(self.call('genesis.scenes.get',{'scene_id':'lobby','version':1})['scene']['nodes']),1)
        self.assertEqual(len(self.call('genesis.scenes.get',{'scene_id':'lobby'})['scene']['nodes']),0)

    def test_scene_stale_version_rejected(self):
        p={'scene_id':'test','expected_version':0,'nodes':[]}
        self.call('genesis.scenes.save',p)
        with self.assertRaises(Conflict):self.call('genesis.scenes.save',p)

    def test_scene_unbounded_position_rejected(self):
        with self.assertRaises(Invalid):self.call('genesis.scenes.save',{'scene_id':'bad','expected_version':0,'nodes':[{'id':'x','kind':'mesh','position':[float('inf'),0,0]}]})

    def test_scene_wrong_tenant_rejected(self):
        self.call('genesis.scenes.save',{'scene_id':'a','expected_version':0,'nodes':[]})
        with self.assertRaises(Invalid):self.call('genesis.scenes.get',{'scene_id':'a'},token=self.other)

    def test_orbital_simulator_refuses_operator(self):
        with self.assertRaises(Unauthorized):self.call('orbital.emulator.enqueue',{'terminal':'t','nonce':'nonce-123456','expires_at':1_800_000_200,'command':'noop'},token=self.operator)

    def test_orbital_nonce_replay(self):
        p={'terminal':'test','nonce':'nonce-123456','expires_at':1_800_000_200,'command':'probe'}
        self.call('orbital.emulator.enqueue',p)
        with self.assertRaises(Conflict):self.call('orbital.emulator.enqueue',p)

    def test_orbital_ack_must_follow_transport(self):
        p={'terminal':'test','nonce':'nonce-123456','expires_at':1_800_000_200,'command':'probe'}
        x=self.call('orbital.emulator.enqueue',p)
        with self.assertRaises(Conflict):self.call('orbital.emulator.ack',{'command_id':x['id'],'phase':'execution'})
        self.call('orbital.emulator.ack',{'command_id':x['id'],'phase':'transport'})
        self.call('orbital.emulator.ack',{'command_id':x['id'],'phase':'execution'})
        self.assertEqual(self.call('orbital.emulator.list')['commands'][0]['execution_ack'],1)

    def test_orbital_expiry_refused(self):
        p={'terminal':'test','nonce':'nonce-123456','expires_at':1_800_000_000,'command':'probe'}
        with self.assertRaises(Invalid):self.call('orbital.emulator.enqueue',p)

    def test_request_rollback_on_conflict(self):
        c=self.customer()
        p={'customer_id':c['id'],'resource':'room','start_at':1_800_000_200,'end_at':1_800_000_500}
        self.call('experience.book',p)
        before=len(self.call('titan.audit.list')['audit'])
        with self.assertRaises(Conflict):self.call('experience.book',p)
        after=len(self.call('titan.audit.list')['audit'])
        self.assertEqual(before,after)


class HTTPTests(unittest.TestCase):
    def setUp(self):
        temp=tempfile.TemporaryDirectory();self.addCleanup(temp.cleanup)
        self.app=Director(Path(temp.name)/'local.sqlite',clock=lambda:1_800_000_000)
        self.app.initialize()
        self.token=self.app.provision('local','owner')['token']
        self.server=ThreadingHTTPServer(('127.0.0.1',0),make_handler(self.app))
        self.thread=threading.Thread(target=self.server.serve_forever,daemon=True)
        self.thread.start()
        self.addCleanup(self.server.server_close)
        self.addCleanup(self.server.shutdown)
    def post(self,body,token=None):
        c=http.client.HTTPConnection('127.0.0.1',self.server.server_address[1],timeout=5)
        headers={'Content-Type':'application/json'}
        if token is not None: headers['Authorization']='Bearer '+token
        c.request('POST','/v1/execute',json.dumps(body),headers)
        r=c.getresponse();data=json.loads(r.read());status=r.status;c.close()
        return status,data
    def test_healthz(self):
        c=http.client.HTTPConnection('127.0.0.1',self.server.server_address[1],timeout=5)
        c.request('GET','/healthz');r=c.getresponse();body=json.loads(r.read());c.close()
        self.assertEqual((r.status,body['production']),(200,False))
    def test_http_requires_token(self):
        code,_=self.post({'operation':'commerce.customers.list','payload':{},'idempotency_key':None})
        self.assertEqual(code,401)
    def test_http_create_customer(self):
        code,body=self.post({'operation':'commerce.customers.create','payload':{'name':'A','contact':'C'},'idempotency_key':'customer-1'},self.token)
        self.assertEqual(code,200)
        self.assertEqual(body['result']['name'],'A')
    def test_http_unknown_operation(self):
        code,body=self.post({'operation':'exec','payload':{},'idempotency_key':'remote-unknown'},self.token)
        self.assertEqual(code,422)
    def test_http_idempotency_conflict(self):
        a={'operation':'commerce.customers.create','payload':{'name':'A','contact':'C'},'idempotency_key':'customer-1'}
        self.post(a,self.token)
        a['payload']['name']='B'
        code,_=self.post(a,self.token)
        self.assertEqual(code,409)
    def test_http_does_not_accept_client_role(self):
        code,_=self.post({'operation':'commerce.customers.list','payload':{},'idempotency_key':None,'role':'owner'},self.token)
        self.assertEqual(code,400)

if __name__=='__main__':
    unittest.main()
