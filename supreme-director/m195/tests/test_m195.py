"""M195 adversarial local integration tests. All user data synthetic."""
from __future__ import annotations
from collections import Counter
from concurrent.futures import ThreadPoolExecutor
from contextlib import closing
import json
from pathlib import Path
import sqlite3
import tempfile
import threading
import unittest
from http.server import ThreadingHTTPServer
from urllib.error import HTTPError
from urllib.request import Request, urlopen
import uuid

from osgard_m192.runtime import Invalid, Unauthorized, Conflict
from osgard_m195.runtime import Director195, HISTORY_GENESIS
from osgard_m195.server import handler_for


def key():return 'm195-' + uuid.uuid4().hex


class TeamTests(unittest.TestCase):
    def setUp(self):
        temp=tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.clock=[1_800_000_000]
        self.db=Path(temp.name)/'team.sqlite'
        self.app=Director195(self.db,clock=lambda:self.clock[0])
        self.app.initialize()
        self.owner=self.app.provision('Company A','owner-a')['token']
        self.operator=self.app.issue_token(self.owner,'operator-a','operator')['token']
        self.operator_b=self.app.issue_token(self.owner,'operator-b','operator')['token']
        self.viewer=self.app.issue_token(self.owner,'viewer-a','viewer')['token']
        self.other=self.app.provision('Company B','owner-b')['token']
        self.other_operator=self.app.issue_token(self.other,'operator-c','operator')['token']

    def exec(self,op,p=None,token=None,write=False,idem=None):
        return self.app.execute(token or self.owner,op,p or {},idem or (key() if write else None))

    def create(self,**kw):
        return self.exec('titan.work.create',{'title':'Follow up','assignee':'operator-a',**kw},write=True)

    def test_initial_schema_and_empty_lists(self):
        self.assertEqual(self.exec('titan.work.list')['items'],[])
        self.assertEqual(self.exec('titan.notifications.list')['unread_count'],0)
    def test_members_only_active_and_tenant(self):
        rows=self.exec('titan.team.members.list')['members']
        self.assertEqual({r['actor'] for r in rows},{'owner-a','operator-a','operator-b'})
        self.assertNotIn('operator-c',{r['actor'] for r in rows})
    def test_viewer_denied_members(self):
        with self.assertRaises(Unauthorized): self.exec('titan.team.members.list',token=self.viewer)
    def test_owner_creates_and_notifies_assignee(self):
        task=self.create()
        inbox=self.exec('titan.notifications.list',token=self.operator)
        self.assertEqual(inbox['unread_count'],1)
        self.assertEqual(inbox['items'][0]['work_id'],task['id'])
    def test_operator_self_create(self):
        task=self.exec('titan.work.create',{'title':'Own item'},self.operator,write=True)
        self.assertEqual(task['assignee'],'operator-a')
    def test_operator_cannot_delegate(self):
        with self.assertRaises(Unauthorized):
            self.exec('titan.work.create',{'title':'Cannot','assignee':'operator-b'},self.operator,write=True)
    def test_viewer_cannot_create(self):
        with self.assertRaises(Unauthorized):
            self.exec('titan.work.create',{'title':'Cannot'},self.viewer,write=True)
    def test_cross_tenant_assignee_rejected(self):
        with self.assertRaises(Invalid):self.create(assignee='operator-c')
    def test_cross_tenant_work_is_hidden(self):
        t=self.create()
        self.assertEqual(self.exec('titan.work.list',token=self.other)['items'],[])
        with self.assertRaises(Invalid):self.exec('titan.work.get',{'id':t['id']},self.other)
    def test_revoked_or_expired_actor_is_not_assignable(self):
        self.clock[0]+=86401
        with self.assertRaises(Unauthorized):self.create()
    def test_tenant_actor_inactive_is_rejected(self):
        with self.assertRaises(Invalid): self.create(assignee='missing-person')
    def test_operator_only_own_tasks_visible(self):
        task=self.create()
        self.assertEqual(len(self.exec('titan.work.list',token=self.operator)['items']),1)
        self.assertEqual(self.exec('titan.work.list',token=self.operator_b)['items'],[])
        with self.assertRaises(Unauthorized):
            self.exec('titan.work.get',{'id':task['id']},self.operator_b)
    def test_owner_reassign_and_version(self):
        t=self.create()
        updated=self.exec('titan.work.assign',{'id':t['id'],'expected_version':1,'assignee':'operator-b'},write=True)
        self.assertEqual(updated['version'],2)
        self.assertEqual(updated['assignee'],'operator-b')
        self.assertEqual(self.exec('titan.work.list',token=self.operator)['items'],[])
        self.assertEqual(self.exec('titan.notifications.list',token=self.operator_b)['unread_count'],1)
    def test_operator_cannot_reassign(self):
        t=self.create()
        with self.assertRaises(Unauthorized):
            self.exec('titan.work.assign',{'id':t['id'],'expected_version':1,'assignee':'operator-b'},self.operator,True)
    def test_reassign_same_person_conflicts(self):
        t=self.create()
        with self.assertRaises(Conflict):
            self.exec('titan.work.assign',{'id':t['id'],'expected_version':1,'assignee':'operator-a'},write=True)
    def test_stale_version_fails(self):
        t=self.create()
        self.exec('titan.work.status',{'id':t['id'],'expected_version':1,'status':'in_progress'},self.operator,True)
        with self.assertRaises(Conflict):
            self.exec('titan.work.status',{'id':t['id'],'expected_version':1,'status':'done'},self.operator,True)
    def test_assignee_can_complete(self):
        t=self.create()
        final=self.exec('titan.work.status',{'id':t['id'],'expected_version':1,'status':'done'},self.operator,True)
        self.assertEqual(final['status'],'done')
        self.assertEqual(self.exec('titan.work.sla')['counts']['done'],1)
    def test_operator_not_assigned_cannot_edit(self):
        t=self.create()
        with self.assertRaises(Unauthorized):
            self.exec('titan.work.status',{'id':t['id'],'expected_version':1,'status':'done'},self.operator_b,True)
    def test_terminal_not_reopened(self):
        t=self.create()
        self.exec('titan.work.status',{'id':t['id'],'expected_version':1,'status':'done'},self.operator,True)
        with self.assertRaises(Conflict):
            self.exec('titan.work.status',{'id':t['id'],'expected_version':2,'status':'in_progress'},write=True)
    def test_note_is_versioned_and_in_history(self):
        t=self.create()
        response=self.exec('titan.work.note',{'id':t['id'],'expected_version':1,'message':'Call tomorrow'},self.operator,True)
        self.assertEqual(response['version'],2)
        events=self.exec('titan.work.history',{'id':t['id']},self.operator)['events']
        self.assertEqual([x['action'] for x in events],['created','note'])
        self.assertEqual(events[-1]['payload']['message'],'Call tomorrow')
    def test_history_prev_hash_and_integrity(self):
        t=self.create()
        h=self.exec('titan.work.history',{'id':t['id']})
        self.assertEqual(h['total'],1)
        self.assertNotEqual(h['head'],HISTORY_GENESIS)
        self.assertEqual(h['head'],t['history_head'])
    def test_history_tamper_blocked_by_trigger(self):
        t=self.create()
        with closing(sqlite3.connect(self.db)) as db:
            with self.assertRaises(sqlite3.IntegrityError):
                db.execute('UPDATE work_history SET event_hash=? WHERE work_id=?',('0'*64,t['id']))
    def test_history_tamper_detected_after_trigger_removed(self):
        t=self.create()
        with closing(sqlite3.connect(self.db)) as db:
            db.execute('DROP TRIGGER immutable_work_history_update')
            db.execute('UPDATE work_history SET payload_json=? WHERE work_id=?',('{}',t['id']))
            db.commit()
        with self.assertRaises(Conflict):self.exec('titan.work.history',{'id':t['id']})
    def test_idempotency_replays_identical_create(self):
        ident=key();params={'title':'Idempotent','assignee':'operator-a'}
        a=self.exec('titan.work.create',params,write=True,idem=ident)
        b=self.exec('titan.work.create',params,write=True,idem=ident)
        self.assertEqual(a,b)
        self.assertEqual(len(self.exec('titan.work.list')['items']),1)
    def test_idempotency_rejects_changed_payload(self):
        ident=key();self.exec('titan.work.create',{'title':'One'},write=True,idem=ident)
        with self.assertRaises(Conflict):
            self.exec('titan.work.create',{'title':'Two'},write=True,idem=ident)
    def test_missing_idempotency_key(self):
        with self.assertRaises(Invalid): self.app.execute(self.owner,'titan.work.create',{'title':'Bad'})
    def test_bad_due(self):
        with self.assertRaises(Invalid):self.create(due_at='tomorrow')
    def test_due_sla_tally(self):
        self.create(due_at=self.clock[0]-100)
        self.create(due_at=self.clock[0]+100)
        self.create(due_at=self.clock[0]+4*86400)
        self.create()
        s=self.exec('titan.work.sla')['counts']
        self.assertEqual((s['overdue'],s['due_soon'],s['scheduled_later'],s['unscheduled']), (1,1,1,1))
    def test_refresh_notices_dedup(self):
        self.create(due_at=self.clock[0]+100)
        first=self.exec('titan.notifications.refresh',write=True)
        second=self.exec('titan.notifications.refresh',write=True)
        self.assertEqual(first['matched'],1);self.assertEqual(second['matched'],1)
        rows=self.exec('titan.notifications.list',token=self.operator)['items']
        self.assertEqual(Counter(x['kind'] for x in rows)['due_soon'],1)
    def test_refresh_overdue_category(self):
        self.create(due_at=self.clock[0]-1)
        self.exec('titan.notifications.refresh',write=True)
        self.assertIn('overdue',[x['kind'] for x in self.exec('titan.notifications.list',token=self.operator)['items']])
    def test_ack_not_other_user(self):
        t=self.create()
        ident=self.exec('titan.notifications.list',token=self.operator)['items'][0]['id']
        with self.assertRaises(Invalid):
            self.exec('titan.notifications.ack',{'notification_id':ident},self.operator_b,True)
        self.exec('titan.notifications.ack',{'notification_id':ident},self.operator,True)
        self.assertEqual(self.exec('titan.notifications.list',token=self.operator)['unread_count'],0)
    def test_sla_tenant_scope(self):
        self.create(due_at=self.clock[0]-5)
        self.assertEqual(self.exec('titan.work.sla',token=self.other)['counts']['overdue'],0)
    def test_crm_link_same_tenant(self):
        client=self.exec('commerce.customers.create',{'name':'A person','contact':'a@demo.invalid'},write=True)
        activity=self.exec('commerce.crm.activities.create',{'customer_id':client['id'],'kind':'call','details':'call once'},write=True)
        task=self.create(crm_activity_id=activity['id'])
        self.assertEqual(self.exec('titan.work.get',{'id':task['id']})['item']['crm_activity_id'],activity['id'])
    def test_crm_link_other_tenant_rejected(self):
        customer=self.exec('commerce.customers.create',{'name':'B person','contact':'b@demo.invalid'},self.other,True)
        activity=self.exec('commerce.crm.activities.create',{'customer_id':customer['id'],'kind':'note','details':'private'},self.other,True)
        with self.assertRaises(Invalid):self.create(crm_activity_id=activity['id'])
    def test_history_no_cross_tenant_read(self):
        task=self.create()
        with self.assertRaises(Invalid):self.exec('titan.work.history',{'id':task['id']},self.other)
    def test_actor_notes_cannot_inject_controls(self):
        task=self.create()
        with self.assertRaises(Invalid):
            self.exec('titan.work.note',{'id':task['id'],'expected_version':1,'message':'bad\x00entry'},write=True)
    def test_status_rollback_after_error(self):
        task=self.create()
        with self.assertRaises(Unauthorized):
            self.exec('titan.work.status',{'id':task['id'],'expected_version':1,'status':'done'},self.operator_b,True)
        self.assertEqual(self.exec('titan.work.get',{'id':task['id']})['item']['version'],1)
    def test_double_update_only_one_wins(self):
        task=self.create()
        def change(_):
            try:
                self.exec('titan.work.status',{'id':task['id'],'expected_version':1,'status':'done'},self.operator,True)
                return 'ok'
            except Conflict:return 'conflict'
        with ThreadPoolExecutor(max_workers=8) as pool:results=list(pool.map(change,range(8)))
        self.assertEqual(results.count('ok'),1)
        self.assertEqual(results.count('conflict'),7)
    def test_invalid_filter_and_limit(self):
        with self.assertRaises(Invalid):self.exec('titan.work.list',{'limit':0})
        with self.assertRaises(Invalid):self.exec('titan.work.list',{'status':'all'})
    def test_no_cross_tenant_notifications(self):
        self.create()
        self.assertEqual(self.exec('titan.notifications.list',token=self.other)['items'],[])


class HttpTests(unittest.TestCase):
    def setUp(self):
        folder=tempfile.TemporaryDirectory();self.addCleanup(folder.cleanup)
        self.app=Director195(Path(folder.name)/'db.sqlite');self.app.initialize()
        self.token=self.app.provision('Demo','owner')['token']
        self.http=ThreadingHTTPServer(('127.0.0.1',0),handler_for(self.app))
        self.worker=threading.Thread(target=self.http.serve_forever,daemon=True);self.worker.start()
        self.addCleanup(lambda:(self.http.shutdown(),self.worker.join(),self.http.server_close()))
        self.origin=f'http://127.0.0.1:{self.http.server_port}'
    def request(self,path,body=None,origin=None,authorization=None):
        headers={'Host':f'127.0.0.1:{self.http.server_port}'}
        if authorization:headers['Authorization']='Bearer '+authorization
        if origin:headers['Origin']=origin
        if body is None:req=Request(self.origin+path,headers=headers)
        else:
            headers['Content-Type']='application/json'
            req=Request(self.origin+path,data=json.dumps(body).encode(),headers=headers)
        try:
            with urlopen(req,timeout=4) as r:return r.status,r.read(),r.headers
        except HTTPError as e:return e.code,e.read(),e.headers
    def test_russian_studio_served_with_csp(self):
        code,body,headers=self.request('/studio/')
        self.assertEqual(code,200)
        self.assertIn(b'data-page="team"',body)
        self.assertIn("default-src 'none'",headers['Content-Security-Policy'])
    def test_app_locale_available(self):
        for path in ('/studio/app.js','/studio/ru.json','/studio/styles.css'):
            self.assertEqual(self.request(path)[0],200)
    def test_authenticated_team_api(self):
        body={'operation':'titan.work.create','payload':{'title':'HTTP work'},'idempotency_key':key()}
        code,response,_=self.request('/v1/execute',body,authorization=self.token)
        self.assertEqual(code,200,response)
        self.assertEqual(json.loads(response)['result']['status'],'open')
    def test_no_external_origin(self):
        payload={'operation':'titan.work.list','payload':{},'idempotency_key':None}
        self.assertEqual(self.request('/v1/execute',payload,origin='https://attacker.invalid',authorization=self.token)[0],403)
    def test_no_bearer(self):
        payload={'operation':'titan.work.list','payload':{},'idempotency_key':None}
        self.assertEqual(self.request('/v1/execute',payload)[0],401)
    def test_host_header_guard(self):
        import http.client
        con=http.client.HTTPConnection('127.0.0.1',self.http.server_port,timeout=4)
        try:
            con.request('GET','/studio/',headers={'Host':'evil.invalid'})
            self.assertEqual(con.getresponse().status,403)
        finally:con.close()


if __name__=='__main__':unittest.main()
