"""M197 real local SQLite/API tests; no network outside loopback."""
from concurrent.futures import ThreadPoolExecutor
from contextlib import closing
from http.server import ThreadingHTTPServer
from io import BytesIO
from pathlib import Path
from urllib.error import HTTPError
from urllib.request import Request, urlopen
import base64
import hashlib
import json
import sqlite3
import tempfile
import threading
import unittest
import uuid

from osgard_m192.runtime import Conflict, Invalid, Unauthorized
from osgard_m196.runtime import Director196
from osgard_m197.runtime import Director197
from osgard_m197.server import handler_for


def key(): return 'm197-' + uuid.uuid4().hex

def b64(data): return base64.b64encode(data).decode('ascii')


class ProjectCardTests(unittest.TestCase):
    def setUp(self):
        temp=tempfile.TemporaryDirectory(prefix='osgard-m197-')
        self.addCleanup(temp.cleanup)
        self.path=Path(temp.name)/'local.sqlite'
        self.now=[1_800_000_000]
        self.app=Director197(self.path,clock=lambda:self.now[0])
        self.app.initialize()
        self.owner=self.app.provision('First Tenant','owner')['token']
        self.operator=self.app.issue_token(self.owner,'editor','operator')['token']
        self.other_operator=self.app.issue_token(self.owner,'other-editor','operator')['token']
        self.viewer=self.app.issue_token(self.owner,'viewer','viewer')['token']
        self.foreign=self.app.provision('Second Tenant','outsider')['token']
        self.customer=self.call('commerce.customers.create',{'name':'Test Customer','contact':'email'},write=True)['id']
        self.deal=self.call('commerce.deals.create',{'customer_id':self.customer,
            'title':'Large contract','amount_minor':250000,'stage':'new'},write=True)['id']
        self.project=self.call('commerce.projects.create',{'deal_id':self.deal,'title':'Delivery'},write=True)

    def call(self,op,p=None,token=None,write=False,idem=None):
        return self.app.execute(token or self.owner,op,p or {}, idem if idem is not None else (key() if write else None))

    def add_doc(self,name='Contract.md',data=b'# Draft contract',mime='text/markdown',**extra):
        project=self.call('commerce.projects.get',{'project_id':self.project['id']})['project']
        return self.call('commerce.projects.documents.add',{'project_id':self.project['id'],
            'expected_project_version':project['version'], 'name':name,'mime':mime,
            'base64':b64(data),**extra},write=True)

    def add_obligation(self,title='Send report',stage_id=None,due_at=None,token=None):
        project=self.call('commerce.projects.get',{'project_id':self.project['id']})['project']
        p={'project_id':self.project['id'], 'expected_project_version':project['version'],
           'title':title}
        if stage_id: p['stage_id']=stage_id
        if due_at is not None: p['due_at']=due_at
        return self.call('commerce.projects.obligations.add',p,token,True)

    def stage(self):
        project=self.call('commerce.projects.get',{'project_id':self.project['id']})['project']
        return self.call('commerce.projects.stage.add',{'project_id':self.project['id'],
            'expected_version':project['version'],'title':'Stage'},write=True)

    def activate(self):
        project=self.call('commerce.projects.get',{'project_id':self.project['id']})['project']
        return self.call('commerce.projects.status',{'project_id':self.project['id'],
            'expected_version':project['version'],'state':'active'},write=True)

    def resolve(self,item,status='fulfilled',token=None,**extra):
        p={'project_id':self.project['id'],'obligation_id':item['id'],
           'expected_version':item['version'],'status':status,**extra}
        return self.call('commerce.projects.obligations.resolve',p,token,True)

    def test_migration_from_previous_version(self):
        with tempfile.TemporaryDirectory() as folder:
            database=Path(folder)/'previous.sqlite'
            old=Director196(database);old.initialize()
            owner=old.provision('Legacy','legacy')['token']
            before=old.execute(owner,'commerce.projects.list',{})
            new=Director197(database);new.initialize()
            self.assertEqual(new.execute(owner,'commerce.projects.list',{}),before)
            with new.connect() as db:
                self.assertIn('delivery_document_versions',
                    {r[0] for r in db.execute("SELECT name FROM sqlite_master WHERE type='table'")})

    def test_empty_card_and_source(self):
        card=self.call('commerce.projects.card',{'project_id':self.project['id']})
        self.assertEqual(card['documents'],[])
        self.assertEqual(card['obligations'],[])
        self.assertEqual(card['delivery_health']['status'],'ON_TRACK')
        self.assertEqual(card['project']['deal_id'],self.deal)
        self.assertFalse(card['delivery_health']['independent_customer_acceptance'])

    def test_document_round_trip_hash_and_versions(self):
        doc=self.add_doc();p={'project_id':self.project['id'],'document_id':doc['id']}
        saved=self.call('commerce.projects.documents.content',p)
        self.assertEqual(base64.b64decode(saved['base64']),b'# Draft contract')
        self.assertEqual(saved['sha256'],hashlib.sha256(b'# Draft contract').hexdigest())
        rev=self.call('commerce.projects.documents.revise',
            {**p,'expected_version':1,'base64':b64(b'# Signed locally')},write=True)
        self.assertEqual(rev['version'],2)
        self.assertEqual(base64.b64decode(self.call('commerce.projects.documents.content',
            {**p,'version':1})['base64']), b'# Draft contract')
        self.assertEqual(base64.b64decode(self.call('commerce.projects.documents.content',p)['base64']),
                         b'# Signed locally')
        self.assertEqual(self.call('commerce.projects.documents.list',
            {'project_id':self.project['id']})['items'][0]['version'],2)

    def test_pdf_header_and_binary_roundtrip(self):
        data=b'%PDF-1.7\nlocal private file\n%%EOF'
        doc=self.add_doc(name='Report.pdf',mime='application/pdf',data=data)
        payload=self.call('commerce.projects.documents.content',{'project_id':self.project['id'],
                                                                  'document_id':doc['id']})
        self.assertEqual(base64.b64decode(payload['base64']),data)

    def test_reject_malformed_base64(self):
        with self.assertRaises(Invalid):
            self.call('commerce.projects.documents.add',{'project_id':self.project['id'],
                'expected_project_version':1,'name':'A.txt','mime':'text/plain','base64':'!!!'},write=True)

    def test_reject_oversized_content(self):
        with self.assertRaises(Invalid):self.add_doc(data=b'x'*49153)

    def test_reject_empty_content(self):
        with self.assertRaises(Invalid):self.add_doc(data=b'')

    def test_reject_invalid_utf8(self):
        with self.assertRaises(Invalid):self.add_doc(data=b'\xff',mime='text/plain')

    def test_reject_pdf_without_magic(self):
        with self.assertRaises(Invalid):self.add_doc(data=b'fake',mime='application/pdf',name='fake.pdf')

    def test_reject_filename_traversal(self):
        for name in ('../a.txt','/tmp.txt','folder\\file.txt','.hidden','C:a.txt'):
            with self.subTest(name=name),self.assertRaises(Invalid):self.add_doc(name=name)

    def test_reject_unknown_mime(self):
        with self.assertRaises(Invalid):self.add_doc(mime='text/html')

    def test_unauthorized_cross_tenant_document(self):
        doc=self.add_doc()
        with self.assertRaises(Invalid):self.call('commerce.projects.documents.content',
            {'project_id':self.project['id'],'document_id':doc['id']},self.foreign)

    def test_viewer_redacted_and_content_denied(self):
        doc=self.add_doc()
        view=self.call('commerce.projects.card',{'project_id':self.project['id']},self.viewer)
        self.assertEqual(view['documents'],[])
        self.assertEqual(view['delivery_health']['documents_total'],1)
        self.assertTrue(view['details_redacted'])
        with self.assertRaises(Unauthorized):self.call('commerce.projects.documents.content',
            {'project_id':self.project['id'],'document_id':doc['id']},self.viewer)

    def test_other_operator_restricted_documents(self):
        self.add_doc()
        with self.assertRaises(Unauthorized):self.call('commerce.projects.documents.list',
            {'project_id':self.project['id']},self.other_operator)

    def test_document_write_idempotent(self):
        p={'project_id':self.project['id'],'expected_project_version':1,'name':'Memo.txt',
           'mime':'text/plain','base64':b64(b'hello')};k=key()
        one=self.call('commerce.projects.documents.add',p,write=True,idem=k)
        two=self.call('commerce.projects.documents.add',p,write=True,idem=k)
        self.assertEqual(one,two)
        self.assertEqual(len(self.call('commerce.projects.documents.list',
            {'project_id':self.project['id']})['items']),1)

    def test_document_duplicate_payload_new_key_conflict(self):
        p={'project_id':self.project['id'],'expected_project_version':1,'name':'Memo.txt',
           'mime':'text/plain','base64':b64(b'hello')}
        self.call('commerce.projects.documents.add',p,write=True)
        with self.assertRaises(Conflict):self.call('commerce.projects.documents.add',p,write=True)

    def test_document_version_concurrency(self):
        doc=self.add_doc()
        def attempt(n):
            try:
                self.call('commerce.projects.documents.revise',{'project_id':self.project['id'],
                    'document_id':doc['id'],'expected_version':1,'base64':b64(('v'+str(n)).encode())},write=True)
                return 'ok'
            except Conflict: return 'conflict'
        with ThreadPoolExecutor(max_workers=8) as pool:
            replies=list(pool.map(attempt,range(8)))
        self.assertEqual(replies.count('ok'),1)
        self.assertEqual(replies.count('conflict'),7)

    def test_immutable_document_version_trigger(self):
        self.add_doc()
        with closing(sqlite3.connect(self.path)) as db:
            with self.assertRaises(sqlite3.IntegrityError):
                db.execute('UPDATE delivery_document_versions SET sha256=?',('f'*64,))
            with self.assertRaises(sqlite3.IntegrityError):
                db.execute('DELETE FROM delivery_document_versions')

    def test_document_corruption_detected_on_read(self):
        doc=self.add_doc()
        with closing(sqlite3.connect(self.path)) as db:
            db.execute('DROP TRIGGER delivery_doc_versions_no_update')
            db.execute('UPDATE delivery_document_versions SET sha256=?',('0'*64,))
            db.commit()
        with self.assertRaises(Conflict):self.call('commerce.projects.documents.content',
            {'project_id':self.project['id'],'document_id':doc['id']})

    def test_obligation_stage_link_and_health(self):
        stage=self.stage();o=self.add_obligation(stage_id=stage['id'],due_at=self.now[0]+5)
        self.assertEqual(o['status'],'open')
        self.now[0]+=10
        h=self.call('commerce.projects.health',{'project_id':self.project['id']})
        self.assertEqual(h['open_obligations'],1)
        self.assertEqual(h['overdue_obligations'],1)
        self.assertEqual(h['status'],'AT_RISK')

    def test_obligation_fulfill_requires_evidence(self):
        ob=self.add_obligation()
        with self.assertRaises(Invalid):self.resolve(ob)
        doc=self.add_doc();done=self.resolve(ob,evidence_sha256=doc['sha256'])
        self.assertEqual(done['status'],'fulfilled')
        with self.assertRaises(Conflict):self.resolve(ob,evidence_sha256='b'*64)

    def test_arbitrary_fulfillment_hash_rejected(self):
        ob=self.add_obligation()
        with self.assertRaisesRegex(Invalid,'stored project document'):
            self.resolve(ob,evidence_sha256='a'*64)

    def test_proof_from_other_tenant_rejected(self):
        ob=self.add_obligation()
        foreign_client=self.call('commerce.customers.create',{'name':'Outside','contact':'contact'},self.foreign,True)['id']
        foreign_deal=self.call('commerce.deals.create',{'customer_id':foreign_client,'title':'External',
            'amount_minor':1,'stage':'new'},self.foreign,True)['id']
        foreign_project=self.call('commerce.projects.create',{'deal_id':foreign_deal,'title':'Outside'},self.foreign,True)
        other_doc=self.call('commerce.projects.documents.add',{'project_id':foreign_project['id'],
            'expected_project_version':1,'name':'outside.txt','mime':'text/plain','base64':b64(b'foreign proof')},
            self.foreign,True)
        with self.assertRaises(Invalid):self.resolve(ob,evidence_sha256=other_doc['sha256'])

    def test_obligation_waiver_owner_only(self):
        ob=self.add_obligation()
        with self.assertRaises(Unauthorized):self.resolve(ob,'waived',self.operator,waiver_reason='Owner decision')
        waived=self.resolve(ob,'waived',self.owner,waiver_reason='Contract terminated')
        self.assertEqual(waived['status'],'waived')

    def test_waiver_without_reason_rejected(self):
        ob=self.add_obligation()
        with self.assertRaises(Invalid):self.resolve(ob,'waived')

    def test_obligation_stage_blocks_completion(self):
        stage=self.stage();self.add_obligation(stage_id=stage['id']);self.activate()
        first=self.call('commerce.projects.stage.status',
            {'project_id':self.project['id'],'stage_id':stage['id'],
             'expected_version':1,'status':'active'},write=True)
        with self.assertRaises(Conflict):
            self.call('commerce.projects.stage.status',
                {'project_id':self.project['id'],'stage_id':stage['id'],
                 'expected_version':first['version'],'status':'done'},write=True)

    def test_db_trigger_blocks_old_client_bypass(self):
        stage=self.stage();self.add_obligation(stage_id=stage['id']);self.activate()
        self.call('commerce.projects.stage.status',{'project_id':self.project['id'],
            'stage_id':stage['id'],'expected_version':1,'status':'active'},write=True)
        old=Director196(self.path,clock=lambda:self.now[0])
        with self.assertRaises(sqlite3.IntegrityError):
            old.execute(self.owner,'commerce.projects.stage.status',
                {'project_id':self.project['id'],'stage_id':stage['id'],
                 'expected_version':2,'status':'done'},key())

    def test_fulfilled_allows_stage_then_project(self):
        stage=self.stage();ob=self.add_obligation(stage_id=stage['id']);self.activate()
        doc=self.add_doc();self.resolve(ob,evidence_sha256=doc['sha256'])
        first=self.call('commerce.projects.stage.status',
            {'project_id':self.project['id'],'stage_id':stage['id'],
             'expected_version':1,'status':'active'},write=True)
        self.call('commerce.projects.stage.status',
            {'project_id':self.project['id'],'stage_id':stage['id'],
             'expected_version':first['version'],'status':'done'},write=True)
        current=self.call('commerce.projects.get',{'project_id':self.project['id']})['project']
        finished=self.call('commerce.projects.status',{'project_id':self.project['id'],
            'expected_version':current['version'],'state':'completed'},write=True)
        self.assertEqual(finished['state'],'completed')

    def test_project_open_obligation_prevents_completion(self):
        stage=self.stage();ob=self.add_obligation();self.activate()
        self.call('commerce.projects.stage.status',{'project_id':self.project['id'],
            'stage_id':stage['id'],'expected_version':1,'status':'active'},write=True)
        self.call('commerce.projects.stage.status',{'project_id':self.project['id'],
            'stage_id':stage['id'],'expected_version':2,'status':'done'},write=True)
        version=self.call('commerce.projects.get',{'project_id':self.project['id']})['project']['version']
        with self.assertRaises(Conflict):self.call('commerce.projects.status',
            {'project_id':self.project['id'],'expected_version':version,'state':'completed'},write=True)
        doc=self.add_doc();self.resolve(ob,evidence_sha256=doc['sha256'])
        version=self.call('commerce.projects.get',{'project_id':self.project['id']})['project']['version']
        self.call('commerce.projects.status',
            {'project_id':self.project['id'],'expected_version':version,'state':'completed'},write=True)

    def test_cannot_write_closed_project(self):
        stage=self.stage();self.activate()
        self.call('commerce.projects.stage.status',{'project_id':self.project['id'],
            'stage_id':stage['id'],'expected_version':1,'status':'active'},write=True)
        self.call('commerce.projects.stage.status',{'project_id':self.project['id'],
            'stage_id':stage['id'],'expected_version':2,'status':'done'},write=True)
        version=self.call('commerce.projects.get',{'project_id':self.project['id']})['project']['version']
        self.call('commerce.projects.status',{'project_id':self.project['id'],
            'expected_version':version,'state':'completed'},write=True)
        with self.assertRaises(Conflict):self.add_doc()
        with self.assertRaises(Conflict):self.add_obligation()

    def test_stage_cross_project_rejected(self):
        stage=self.stage()
        other=self.call('commerce.projects.create',{'deal_id':self.deal,'title':'Unrelated'},write=True)
        with self.assertRaises(Invalid):self.call('commerce.projects.obligations.add',
            {'project_id':other['id'],'expected_project_version':1,'title':'bad','stage_id':stage['id']},write=True)

    def test_cross_tenant_project_redacted(self):
        with self.assertRaises(Invalid):self.call('commerce.projects.card',
            {'project_id':self.project['id']},self.foreign)

    def test_project_history_tracks_changes(self):
        doc=self.add_doc();ob=self.add_obligation();self.resolve(ob,evidence_sha256=doc['sha256'])
        result=self.call('commerce.projects.events',{'project_id':self.project['id']})
        actions=[e['kind'] for e in result['events']]
        self.assertIn('document_added',actions)
        self.assertIn('obligation_added',actions)
        self.assertIn('obligation_resolved',actions)

    def test_http_studio_assets_and_api(self):
        http=ThreadingHTTPServer(('127.0.0.1',0),handler_for(self.app))
        thread=threading.Thread(target=http.serve_forever,daemon=True)
        thread.start()
        self.addCleanup(http.server_close)
        self.addCleanup(http.shutdown)
        base='http://127.0.0.1:'+str(http.server_port)
        with urlopen(base+'/projects/',timeout=3) as res:
            self.assertIn(b'OSGARD',res.read())
            self.assertIn('nosniff',res.headers['X-Content-Type-Options'])
        with urlopen(base+'/projects/app.js',timeout=3) as res:
            self.assertIn(b'fetch(',res.read())
        body=json.dumps({'operation':'commerce.projects.card',
            'payload':{'project_id':self.project['id']},'idempotency_key':None}).encode()
        request=Request(base+'/v1/execute',data=body,method='POST',headers={
            'Content-Type':'application/json','Authorization':'Bearer '+self.owner,
            'Origin':base})
        with urlopen(request,timeout=3) as res:
            self.assertEqual(json.loads(res.read())['result']['project']['id'],self.project['id'])
        bad=Request(base+'/v1/execute',data=body,method='POST',headers={
            'Authorization':'Bearer '+self.owner,'Origin':'http://evil.invalid'})
        with self.assertRaises(HTTPError) as error:urlopen(bad,timeout=3)
        self.assertEqual(error.exception.code,403)


if __name__=='__main__':unittest.main()
