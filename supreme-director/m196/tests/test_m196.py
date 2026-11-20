"""Adversarial tests for local M196 project delivery; all data synthetic."""
from __future__ import annotations
from concurrent.futures import ThreadPoolExecutor
from contextlib import closing
from http.server import ThreadingHTTPServer
import json
from pathlib import Path
import sqlite3
import tempfile
import threading
import unittest
from urllib.error import HTTPError
from urllib.request import Request, urlopen
import uuid

from osgard_m192.runtime import Conflict, Invalid, Unauthorized
from osgard_m195.runtime import Director195
from osgard_m196.runtime import Director196
from osgard_m196.server import handler_for, serve


def key(): return 'm196-' + uuid.uuid4().hex


class ProjectsTests(unittest.TestCase):
    def setUp(self):
        folder=tempfile.TemporaryDirectory(prefix='osgard-m196-tests-')
        self.addCleanup(folder.cleanup)
        self.path=Path(folder.name)/'local.sqlite'
        self.now=[1_800_000_000]
        self.app=Director196(self.path,clock=lambda:self.now[0])
        self.app.initialize()
        self.owner=self.app.provision('First Company','lead')['token']
        self.member=self.app.issue_token(self.owner,'engineer','operator')['token']
        self.other_member=self.app.issue_token(self.owner,'specialist','operator')['token']
        self.viewer=self.app.issue_token(self.owner,'observer','viewer')['token']
        self.other=self.app.provision('Second Company','foreign')['token']
        self.customer=self.call('commerce.customers.create',{'name':'Customer A','contact':'example.invalid'},write=True)['id']
        self.deal=self.call('commerce.deals.create',{'customer_id':self.customer,'title':'Platform','amount_minor':500000,'stage':'new'},write=True)['id']

    def call(self,op,payload=None,token=None,write=False,idem=None):
        return self.app.execute(token or self.owner,op,{} if payload is None else payload,
                                idem if idem is not None else (key() if write else None))
    def project(self, **kw):
        return self.call('commerce.projects.create',{'deal_id':self.deal,'title':'Implementation',**kw},write=True)
    def stage(self,project,title='Prototype'):
        return self.call('commerce.projects.stage.add',
                         {'project_id':project['id'],'expected_version':project['version'],'title':title},write=True)
    def activated(self):
        p=self.project()
        s=self.stage(p)
        active=self.call('commerce.projects.status',
                         {'project_id':p['id'],'expected_version':s['project_version'],'state':'active'},write=True)
        return p,s,active
    def work(self,actor='engineer',activity=None):
        payload={'title':'Build API','assignee':actor}
        if activity:payload['crm_activity_id']=activity
        return self.call('titan.work.create',payload,write=True)
    def link(self,p,s,w,token=None):
        return self.call('titan.work.project.link',
                         {'work_id':w['id'],'expected_version':w['version'],
                          'project_id':p['id'],'stage_id':s['id']},token,True)

    def test_schema_is_additive_to_old_m195_database(self):
        with tempfile.TemporaryDirectory() as d:
            path=Path(d)/'old.sqlite';old=Director195(path)
            old.initialize(); owner=old.provision('Old','legacy')['token']
            client=old.execute(owner,'commerce.customers.create',{'name':'Old Client','contact':'contact'},key())
            new=Director196(path);new.initialize()
            self.assertEqual(new.execute(owner,'commerce.customers.list',{})['customers'][0]['id'],client['id'])
            self.assertEqual(new.execute(owner,'commerce.projects.list',{})['items'],[])

    def test_new_project_binds_customer_to_deal(self):
        p=self.project()
        row=self.call('commerce.projects.get',{'project_id':p['id']})['project']
        self.assertEqual(row['customer_id'],self.customer)
        self.assertEqual(row['deal_id'],self.deal)
        self.assertEqual(row['state'],'planned')
        self.assertEqual(row['version'],1)
    def test_missing_deal_rejected(self):
        with self.assertRaises(Invalid):
            self.call('commerce.projects.create',{'deal_id':'0'*32,'title':'Wrong'},write=True)
    def test_cross_tenant_deal_rejected(self):
        with self.assertRaises(Invalid):
            self.call('commerce.projects.create',{'deal_id':self.deal,'title':'Steal'},self.other,True)
    def test_viewer_can_read_cannot_write(self):
        p=self.project()
        self.assertEqual(len(self.call('commerce.projects.list',token=self.viewer)['items']),1)
        with self.assertRaises(Unauthorized):
            self.call('commerce.projects.create',{'deal_id':self.deal,'title':'No'},self.viewer,True)
    def test_project_creator_can_add_stage(self):
        p=self.call('commerce.projects.create',{'deal_id':self.deal,'title':'Owner'},self.member,True)
        s=self.call('commerce.projects.stage.add',
                    {'project_id':p['id'],'expected_version':1,'title':'Stage'},self.member,True)
        self.assertEqual(s['rank'],1)
    def test_other_operator_cannot_change_project(self):
        p=self.call('commerce.projects.create',{'deal_id':self.deal,'title':'Owner'},self.member,True)
        with self.assertRaises(Unauthorized):
            self.call('commerce.projects.stage.add',
                      {'project_id':p['id'],'expected_version':1,'title':'Stage'},self.other_member,True)
    def test_idempotent_create(self):
        payload={'deal_id':self.deal,'title':'Idempotent'}; idem=key()
        a=self.call('commerce.projects.create',payload,write=True,idem=idem)
        b=self.call('commerce.projects.create',payload,write=True,idem=idem)
        self.assertEqual(a,b)
        self.assertEqual(len(self.call('commerce.projects.list')['items']),1)
    def test_idempotency_key_collision(self):
        idem=key()
        self.call('commerce.projects.create',{'deal_id':self.deal,'title':'A'},write=True,idem=idem)
        with self.assertRaises(Conflict):
            self.call('commerce.projects.create',{'deal_id':self.deal,'title':'B'},write=True,idem=idem)
    def test_writes_without_key_rejected(self):
        with self.assertRaises(Invalid):
            self.app.execute(self.owner,'commerce.projects.create',{'deal_id':self.deal,'title':'A'})
    def test_strict_payload_rejected(self):
        with self.assertRaises(Invalid):
            self.call('commerce.projects.create',{'deal_id':self.deal,'title':'A','admin':True},write=True)
    def test_stage_ordering_and_optimistic_version(self):
        p=self.project();first=self.stage(p,'One');second=self.stage({'id':p['id'],'version':2},'Two')
        self.assertEqual((first['rank'],second['rank']), (1,2))
        with self.assertRaises(Conflict):self.stage(p,'Stale')
        self.assertEqual(len(self.call('commerce.projects.get',{'project_id':p['id']})['stages']),2)
    def test_cannot_activate_without_stages(self):
        p=self.project()
        with self.assertRaises(Conflict):
            self.call('commerce.projects.status',{'project_id':p['id'],'expected_version':1,'state':'active'},write=True)
    def test_project_version_conflict(self):
        p,s,a=self.activated()
        with self.assertRaises(Conflict):
            self.call('commerce.projects.status',{'project_id':p['id'],'expected_version':1,'state':'completed'},write=True)
    def test_cannot_complete_unfinished_stage(self):
        p,s,a=self.activated()
        with self.assertRaises(Conflict):
            self.call('commerce.projects.status',{'project_id':p['id'],'expected_version':a['version'],'state':'completed'},write=True)
    def test_predecessor_must_finish_before_next_stage(self):
        p=self.project();s1=self.stage(p);s2=self.stage({'id':p['id'],'version':2},'Second')
        self.call('commerce.projects.status',{'project_id':p['id'],'expected_version':3,'state':'active'},write=True)
        with self.assertRaises(Conflict):
            self.call('commerce.projects.stage.status',
                      {'project_id':p['id'],'stage_id':s2['id'],'expected_version':1,'status':'active'},write=True)
        self.call('commerce.projects.stage.status',
                  {'project_id':p['id'],'stage_id':s1['id'],'expected_version':1,'status':'active'},write=True)
        self.call('commerce.projects.stage.status',
                  {'project_id':p['id'],'stage_id':s1['id'],'expected_version':2,'status':'done'},write=True)
        x=self.call('commerce.projects.stage.status',
                    {'project_id':p['id'],'stage_id':s2['id'],'expected_version':1,'status':'active'},write=True)
        self.assertEqual(x['status'],'active')
    def test_links_visible_and_audited(self):
        p,s,a=self.activated();w=self.work();result=self.link(p,s,w)
        self.assertEqual(result['version'],2)
        view=self.call('commerce.projects.get',{'project_id':p['id']})
        self.assertEqual(view['stages'][0]['linked_total'],1)
        self.assertEqual(view['stages'][0]['tasks'][0]['id'],w['id'])
        self.assertEqual(self.call('titan.work.history',{'id':w['id']})['events'][-1]['action'],'project_linked')
        self.assertEqual(self.call('commerce.projects.events',{'project_id':p['id']})['total'],4)
    def test_project_viewer_no_employee_details(self):
        p,s,a=self.activated();w=self.work();self.link(p,s,w)
        view=self.call('commerce.projects.get',{'project_id':p['id']},self.viewer)
        self.assertEqual(view['stages'][0]['linked_total'],1)
        self.assertEqual(view['stages'][0]['tasks'],[])
        self.assertTrue(view['stages'][0]['tasks_filtered_by_permissions'])
    def test_other_operator_no_hidden_employee_details(self):
        p,s,a=self.activated();w=self.work();self.link(p,s,w)
        view=self.call('commerce.projects.get',{'project_id':p['id']},self.other_member)
        self.assertEqual(view['stages'][0]['tasks'],[])
    def test_cross_tenant_work_rejected(self):
        p,s,a=self.activated();w=self.work()
        other_p=self.call('commerce.projects.create',{'deal_id':self.deal,'title':'Other'},write=True)
        with self.assertRaises(Invalid):
            self.call('titan.work.project.link',{'work_id':w['id'],'expected_version':1,
              'project_id':p['id'],'stage_id':s['id']},self.other,True)
    def test_cross_tenant_stage_rejected(self):
        p,s,a=self.activated();other=self.project();s2=self.stage(other);w=self.work()
        with self.assertRaises(Invalid):
            self.call('titan.work.project.link',{'work_id':w['id'],'expected_version':1,
              'project_id':p['id'],'stage_id':s2['id']},write=True)
    def test_operator_only_assignee_may_link(self):
        p,s,a=self.activated();w=self.work()
        with self.assertRaises(Unauthorized):self.link(p,s,w,self.other_member)
        response=self.link(p,s,w,self.member)
        self.assertEqual(response['version'],2)
    def test_wrong_activity_customer_rejected(self):
        other_customer=self.call('commerce.customers.create',{'name':'Different','contact':'else'},write=True)['id']
        activity=self.call('commerce.crm.activities.create',
            {'customer_id':other_customer,'kind':'call','details':'Phone'},write=True)
        p,s,a=self.activated();w=self.work(activity=activity['id'])
        with self.assertRaises(Conflict):self.link(p,s,w)
    def test_wrong_activity_deal_rejected(self):
        different=self.call('commerce.deals.create',
            {'customer_id':self.customer,'title':'Second','amount_minor':10,'stage':'new'},write=True)['id']
        activity=self.call('commerce.crm.activities.create',
            {'customer_id':self.customer,'deal_id':different,'kind':'call','details':'Phone'},write=True)
        p,s,a=self.activated();w=self.work(activity=activity['id'])
        with self.assertRaises(Conflict):self.link(p,s,w)
    def test_link_same_stage_rejected(self):
        p,s,a=self.activated();w=self.work();self.link(p,s,w)
        with self.assertRaises(Conflict):
            self.call('titan.work.project.link',{'work_id':w['id'],'expected_version':2,
                       'project_id':p['id'],'stage_id':s['id']},write=True)
    def test_link_other_project_rejected(self):
        p,s,a=self.activated();another=self.project();second=self.stage(another)
        w=self.work();self.link(p,s,w)
        with self.assertRaises(Conflict):
            self.call('titan.work.project.link',{'work_id':w['id'],'expected_version':2,
                       'project_id':another['id'],'stage_id':second['id']},write=True)
    def test_unlink_and_relink(self):
        p,s,a=self.activated();w=self.work();self.link(p,s,w)
        unlinked=self.call('titan.work.project.unlink',{'work_id':w['id'],'expected_version':2},write=True)
        self.assertEqual(unlinked['version'],3)
        self.assertEqual(self.call('commerce.projects.get',{'project_id':p['id']})['stages'][0]['linked_total'],0)
        self.link(p,s,{'id':w['id'],'version':3})
        self.assertEqual(self.call('commerce.projects.get',{'project_id':p['id']})['stages'][0]['linked_total'],1)
    def test_cannot_link_closed_task(self):
        p,s,a=self.activated();w=self.work()
        self.call('titan.work.status',{'id':w['id'],'expected_version':1,'status':'done'},write=True)
        with self.assertRaises(Conflict):self.link(p,s,{'id':w['id'],'version':2})
    def test_incomplete_task_blocks_stage_close(self):
        p,s,a=self.activated();w=self.work();linked=self.link(p,s,w)
        self.call('commerce.projects.stage.status',
                  {'project_id':p['id'],'stage_id':s['id'],'expected_version':1,'status':'active'},write=True)
        with self.assertRaises(Conflict):
            self.call('commerce.projects.stage.status',
                      {'project_id':p['id'],'stage_id':s['id'],'expected_version':2,'status':'done'},write=True)
        self.call('titan.work.status',{'id':w['id'],'expected_version':linked['version'],'status':'done'},write=True)
        done=self.call('commerce.projects.stage.status',
              {'project_id':p['id'],'stage_id':s['id'],'expected_version':2,'status':'done'},write=True)
        self.assertEqual(done['status'],'done')
    def test_completed_project_only_after_all_stages(self):
        p,s,a=self.activated()
        self.call('commerce.projects.stage.status',{'project_id':p['id'],'stage_id':s['id'],
                  'expected_version':1,'status':'active'},write=True)
        self.call('commerce.projects.stage.status',{'project_id':p['id'],'stage_id':s['id'],
                  'expected_version':2,'status':'done'},write=True)
        done=self.call('commerce.projects.status',
                    {'project_id':p['id'],'expected_version':a['version'],'state':'completed'},write=True)
        self.assertEqual(done['state'],'completed')
        with self.assertRaises(Conflict):
            self.call('commerce.projects.stage.add',
                     {'project_id':p['id'],'expected_version':done['version'],'title':'Too late'},write=True)
    def test_project_progress_is_derived_from_real_stages(self):
        p,s,a=self.activated()
        view=self.call('commerce.projects.get',{'project_id':p['id']})
        self.assertEqual(view['progress_percent'],0)
        self.call('commerce.projects.stage.status',
                  {'project_id':p['id'],'stage_id':s['id'],'expected_version':1,'status':'active'},write=True)
        self.call('commerce.projects.stage.status',
                  {'project_id':p['id'],'stage_id':s['id'],'expected_version':2,'status':'done'},write=True)
        self.assertEqual(self.call('commerce.projects.get',{'project_id':p['id']})['progress_percent'],100)
    def test_history_tamper_is_detected(self):
        p=self.project()
        self.assertEqual(self.call('commerce.projects.events',{'project_id':p['id']})['total'],1)
        with closing(sqlite3.connect(self.path)) as db:
            with self.assertRaises(sqlite3.IntegrityError):
                db.execute('UPDATE delivery_events SET actor=? WHERE project_id=?',('attack',p['id']))
        with closing(sqlite3.connect(self.path)) as db:
            db.execute('DROP TRIGGER delivery_events_immutable_update')
            db.execute('UPDATE delivery_events SET actor=? WHERE project_id=?',('attack',p['id']))
            db.commit()
        with self.assertRaises(Conflict):
            self.call('commerce.projects.events',{'project_id':p['id']})
    def test_read_project_events_requires_project_owner(self):
        p=self.call('commerce.projects.create',{'deal_id':self.deal,'title':'Creator'},self.member,True)
        with self.assertRaises(Unauthorized):
            self.call('commerce.projects.events',{'project_id':p['id']},self.other_member)
        self.assertEqual(self.call('commerce.projects.events',{'project_id':p['id']},self.member)['total'],1)
    def test_project_list_strict_filter(self):
        self.project()
        self.assertEqual(self.call('commerce.projects.list',{'state':'active'})['items'],[])
        with self.assertRaises(Invalid):self.call('commerce.projects.list',{'limit':True})
    def test_concurrent_same_expected_project_version_single_winner(self):
        p=self.project()
        def worker(_):
            try:
                return self.call('commerce.projects.stage.add',
                    {'project_id':p['id'],'expected_version':1,'title':'Concurrent'},write=True)
            except Conflict:
                return 'conflict'
        with ThreadPoolExecutor(max_workers=8) as pool:
            results=list(pool.map(worker,range(8)))
        self.assertEqual(sum(isinstance(r,dict) for r in results),1)
        self.assertEqual(self.call('commerce.projects.get',{'project_id':p['id']})['project']['version'],2)
    def test_replay_same_idempotency_key_concurrent(self):
        payload={'deal_id':self.deal,'title':'One created'};idem=key()
        with ThreadPoolExecutor(max_workers=8) as pool:
            result=list(pool.map(lambda _:self.call('commerce.projects.create',payload,write=True,idem=idem),range(8)))
        self.assertEqual(len({r['id'] for r in result}),1)
    def test_work_version_reflects_project_link(self):
        p,s,a=self.activated();w=self.work()
        self.link(p,s,w)
        with self.assertRaises(Conflict):
            self.call('titan.work.status',{'id':w['id'],'expected_version':1,'status':'done'},write=True)
    def test_project_close_cannot_reopen(self):
        p,s,a=self.activated()
        self.call('commerce.projects.status',{'project_id':p['id'],'expected_version':a['version'],'state':'cancelled'},write=True)
        with self.assertRaises(Conflict):
            self.call('commerce.projects.status',{'project_id':p['id'],'expected_version':a['version']+1,'state':'active'},write=True)


class ProjectHttpTests(ProjectsTests):
    def setUp(self):
        super().setUp()
        server=ThreadingHTTPServer(('127.0.0.1',0),handler_for(self.app))
        self.addCleanup(server.server_close)
        worker=threading.Thread(target=server.serve_forever,daemon=True)
        worker.start()
        self.addCleanup(lambda:(server.shutdown(),worker.join(3)))
        self.base=f'http://127.0.0.1:{server.server_port}'

    def post(self,operation,payload=None,token=None,keyval=None,host=None,origin=None):
        content=json.dumps({'operation':operation,'payload':{} if payload is None else payload,
                            'idempotency_key':keyval}).encode()
        headers={'Authorization':'Bearer '+(token or self.owner),'Content-Type':'application/json'}
        if host:headers['Host']=host
        if origin:headers['Origin']=origin
        req=Request(self.base+'/v1/execute',data=content,headers=headers,method='POST')
        try:
            with urlopen(req,timeout=5) as response:return response.status,json.load(response)
        except HTTPError as e:return e.code,json.load(e)
    def test_http_project_crud_and_detail(self):
        status,created=self.post('commerce.projects.create',{'deal_id':self.deal,'title':'Local API'},keyval=key())
        self.assertEqual(status,200)
        code,data=self.post('commerce.projects.get',{'project_id':created['result']['id']})
        self.assertEqual(code,200)
        self.assertEqual(data['result']['project']['title'],'Local API')
    def test_http_requires_bearer(self):
        code,data=self.post('commerce.projects.list',token='invalid')
        self.assertIn(code,(401,403))
    def test_http_host_protection(self):
        code,data=self.post('commerce.projects.list',host='evil.example')
        self.assertEqual(code,403)
    def test_http_origin_protection(self):
        code,data=self.post('commerce.projects.list',origin='https://evil.example')
        self.assertEqual(code,403)
    def test_ui_routes_and_no_store_headers(self):
        for route in ['/studio/','/studio/app.js','/studio/styles.css','/studio/ru.json']:
            with urlopen(self.base+route,timeout=5) as response:
                self.assertEqual(response.status,200)
                self.assertEqual(response.headers['Cache-Control'],'no-store')
                self.assertEqual(response.headers['Content-Security-Policy'].split(';')[0],"default-src 'none'")
    def test_no_lan_bind(self):
        with self.assertRaises(Invalid):serve(self.app,port=0,bind='0.0.0.0')
