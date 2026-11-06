"""M195 team work, local notifications, deadlines and tamper-evident history.

Extends M194 using the same authenticated, tenant-scoped SQLite transaction.
No external messaging, scheduled daemon, billing, or production permissions.
"""
from __future__ import annotations

from collections import Counter
from hashlib import sha256
import json

from osgard_m192.runtime import (ROLES, KEY_RE, Invalid, Unauthorized, Conflict,
                                canonical, _secret_hash, _uid, _text, _object, _identifier,
                                NAME_RE)
from osgard_m193.runtime import _version
from osgard_m194.runtime import Director194

OPS195 = {
    'titan.team.members.list': {'owner', 'operator'},
    'titan.work.create': {'owner', 'operator'},
    'titan.work.list': ROLES,
    'titan.work.get': ROLES,
    'titan.work.assign': {'owner'},
    'titan.work.status': {'owner', 'operator'},
    'titan.work.note': {'owner', 'operator'},
    'titan.work.history': {'owner', 'operator'},
    'titan.work.sla': ROLES,
    'titan.notifications.list': ROLES,
    'titan.notifications.ack': {'owner', 'operator'},
    'titan.notifications.refresh': {'owner', 'operator'},
}
WRITES195 = frozenset({'titan.work.create','titan.work.assign','titan.work.status',
                       'titan.work.note','titan.notifications.ack',
                       'titan.notifications.refresh'})
PRIORITIES = frozenset({'low','normal','high','critical'})
TRANSITIONS = {'open': {'in_progress','done','cancelled'},
               'in_progress': {'done','cancelled'}, 'done': set(), 'cancelled': set()}
HISTORY_GENESIS = '0' * 64


def _due(value, now):
    if value is None:
        return None
    if type(value) is not int or not now - 90*86400 <= value <= now + 730*86400:
        raise Invalid('due_at must be Unix seconds within 90 days past to 730 days future')
    return value


def _active_actor(db, tenant, actor, now):
    if not isinstance(actor,str) or not NAME_RE.fullmatch(actor):
        raise Invalid('invalid employee name')
    row = db.execute('''SELECT 1 FROM api_keys WHERE tenant_id=? AND actor=?
        AND role IN ('owner','operator') AND revoked=0 AND expires_at>? LIMIT 1''',
        (tenant,actor,now)).fetchone()
    if row is None:
        raise Invalid('assignee must have an active owner/operator token in this organization')
    return actor


def _record(db, tenant, work_id, actor, action, payload, now):
    prior = db.execute('''SELECT event_hash FROM work_history WHERE tenant_id=? AND work_id=?
                          ORDER BY seq DESC LIMIT 1''',(tenant,work_id)).fetchone()
    prev = prior['event_hash'] if prior else HISTORY_GENESIS
    event = {'tenant':tenant,'work_id':work_id,'actor':actor,'action':action,
             'previous_hash':prev,'payload':payload,'created_at':now}
    digest = sha256(canonical(event).encode('ascii')).hexdigest()
    db.execute('''INSERT INTO work_history(tenant_id,work_id,actor,action,payload_json,
                  created_at,previous_hash,event_hash) VALUES (?,?,?,?,?,?,?,?)''',
               (tenant,work_id,actor,action,canonical(payload),now,prev,digest))
    return digest


def _history(db,tenant,work_id,limit=200):
    rows = list(db.execute('''SELECT * FROM work_history WHERE tenant_id=? AND work_id=?
                              ORDER BY seq''',(tenant,work_id)))
    prev=HISTORY_GENESIS
    result=[]
    for row in rows:
        payload=json.loads(row['payload_json'])
        event={'tenant':row['tenant_id'],'work_id':row['work_id'],'actor':row['actor'],
               'action':row['action'],'previous_hash':prev,'payload':payload,
               'created_at':row['created_at']}
        digest=sha256(canonical(event).encode('ascii')).hexdigest()
        if row['previous_hash'] != prev or row['event_hash'] != digest or row['payload_json'] != canonical(payload):
            raise Conflict('history integrity mismatch')
        prev = digest
        result.append({'actor':row['actor'],'action':row['action'],'payload':payload,
                       'created_at':row['created_at'],'event_hash':digest})
    return {'events':result[-limit:],'total':len(result),'head':prev,
            'warning':'Local hashes are not an independently signed external audit anchor.'}


def _notice(db,tenant,recipient,work_id,kind,version,body,now):
    db.execute('''INSERT OR IGNORE INTO team_notices
        (id,tenant_id,recipient,work_id,kind,work_version,body,created_at)
        VALUES (?,?,?,?,?,?,?,?)''',(_uid(),tenant,recipient,work_id,kind,version,body,now))


def _visible(role,actor,row):
    return role=='owner' or (role=='operator' and
                              (row['assignee']==actor or row['created_by']==actor))


class Director195(Director194):
    def initialize(self):
        super().initialize()
        with self.connect() as db:
            db.executescript('''
            CREATE TABLE IF NOT EXISTS team_work (
              id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, title TEXT NOT NULL,
              description TEXT NOT NULL, assignee TEXT NOT NULL, created_by TEXT NOT NULL,
              priority TEXT NOT NULL CHECK(priority IN ('low','normal','high','critical')),
              status TEXT NOT NULL CHECK(status IN ('open','in_progress','done','cancelled')),
              crm_activity_id TEXT, due_at INTEGER, version INTEGER NOT NULL CHECK(version >= 1),
              created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, finished_at INTEGER);
            CREATE INDEX IF NOT EXISTS team_work_tenant_assignee
              ON team_work(tenant_id,assignee,status,due_at,id);
            CREATE TABLE IF NOT EXISTS work_history (
              seq INTEGER PRIMARY KEY AUTOINCREMENT, tenant_id TEXT NOT NULL,
              work_id TEXT NOT NULL, actor TEXT NOT NULL, action TEXT NOT NULL,
              payload_json TEXT NOT NULL, created_at INTEGER NOT NULL,
              previous_hash TEXT NOT NULL, event_hash TEXT NOT NULL);
            CREATE INDEX IF NOT EXISTS work_history_tenant
              ON work_history(tenant_id,work_id,seq);
            CREATE TRIGGER IF NOT EXISTS immutable_work_history_update
              BEFORE UPDATE ON work_history BEGIN SELECT RAISE(ABORT,'history is append-only'); END;
            CREATE TRIGGER IF NOT EXISTS immutable_work_history_delete
              BEFORE DELETE ON work_history BEGIN SELECT RAISE(ABORT,'history is append-only'); END;
            CREATE TABLE IF NOT EXISTS team_notices (
              id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, recipient TEXT NOT NULL,
              work_id TEXT NOT NULL, kind TEXT NOT NULL,
              work_version INTEGER NOT NULL, body TEXT NOT NULL,
              created_at INTEGER NOT NULL, read_at INTEGER,
              UNIQUE(tenant_id,recipient,work_id,kind,work_version));
            CREATE INDEX IF NOT EXISTS team_notices_person
              ON team_notices(tenant_id,recipient,read_at,created_at);
            ''')

    def execute(self,token,op,payload,idem_key=None):
        if op not in OPS195:
            return super().execute(token,op,payload,idem_key)
        if not isinstance(payload,dict):
            raise Invalid('payload must be a JSON object')
        write=op in WRITES195
        if write and (not isinstance(idem_key,str) or not KEY_RE.fullmatch(idem_key)):
            raise Invalid('writes require an idempotency key of 8..100 characters')
        with self.connect(transaction=True) as db:
            identity=self._identity(db,token)
            if identity['role'] not in OPS195[op]:
                raise Unauthorized('permission denied')
            tenant,actor,role=identity['tenant_id'],identity['actor'],identity['role']
            if write:
                try:
                    req_sha=_secret_hash(canonical({'op':op,'payload':payload}))
                except (TypeError, ValueError) as exc:
                    raise Invalid('invalid request values') from exc
                cached=db.execute('''SELECT op,request_sha,response_json FROM requests
                    WHERE tenant_id=? AND idem_key=?''',(tenant,idem_key)).fetchone()
                if cached:
                    if cached['op']!=op or cached['request_sha']!=req_sha:
                        raise Conflict('idempotency key reused with different request')
                    return json.loads(cached['response_json'])
            output=self._apply_195(db,tenant,actor,role,op,payload)
            if write:
                db.execute('INSERT INTO requests VALUES (?,?,?,?,?)',
                           (tenant,idem_key,op,req_sha,canonical(output)))
                db.execute('''INSERT INTO audit(tenant_id,actor,operation,request_sha,recorded_at)
                    VALUES (?,?,?,?,?)''',(tenant,actor,op,req_sha,self.clock()))
            return output

    def _work(self,db,tenant,id):
        _identifier(id,'work id')
        row=db.execute('SELECT * FROM team_work WHERE tenant_id=? AND id=?',(tenant,id)).fetchone()
        if row is None:
            raise Invalid('task does not exist in this organization')
        return row

    def _apply_195(self,db,tenant,actor,role,op,p):
        now=self.clock()
        if op=='titan.team.members.list':
            _object(p,set())
            rows=db.execute('''SELECT actor,role,MAX(expires_at) AS expires_at FROM api_keys
                WHERE tenant_id=? AND revoked=0 AND expires_at>?
                AND role IN ('owner','operator') GROUP BY actor,role ORDER BY actor,role''',(tenant,now))
            return {'members':[dict(x) for x in rows],'local_only':True}
        if op=='titan.work.create':
            _object(p,{'title'}, {'description','priority','assignee','due_at','crm_activity_id'})
            title=_text(p['title'],'title',160)
            description=_text(p['description'],'description',1200) if p.get('description') else ''
            priority=p.get('priority','normal')
            if priority not in PRIORITIES: raise Invalid('invalid priority')
            assignee=_active_actor(db,tenant,p.get('assignee',actor),now)
            if role!='owner' and assignee!=actor: raise Unauthorized('only owner can delegate')
            due=_due(p.get('due_at'),now)
            activity=p.get('crm_activity_id')
            if activity is not None:
                _identifier(activity,'CRM activity')
                if not db.execute('''SELECT 1 FROM crm_activities WHERE id=? AND tenant_id=?''',
                                  (activity,tenant)).fetchone():
                    raise Invalid('CRM activity is outside this organization or missing')
            work_id=_uid()
            db.execute('''INSERT INTO team_work VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)''',
                       (work_id,tenant,title,description,assignee,actor,priority,
                        'open',activity,due,1,now,now,None))
            head=_record(db,tenant,work_id,actor,'created',
                   {'title':title,'description':description,'priority':priority,
                    'assignee':assignee,'due_at':due,'crm_activity_id':activity},now)
            if assignee!=actor:
                _notice(db,tenant,assignee,work_id,'assignment',1,'Вам назначена задача: '+title,now)
            return {'id':work_id,'version':1,'assignee':assignee,'status':'open','history_head':head}
        if op=='titan.work.list':
            _object(p,set(),{'status','assignee','limit'})
            status=p.get('status')
            if status is not None and status not in TRANSITIONS: raise Invalid('invalid status filter')
            target=p.get('assignee')
            if target is not None and (not isinstance(target,str) or not NAME_RE.fullmatch(target)):
                raise Invalid('invalid assignee filter')
            limit=p.get('limit',100)
            if type(limit) is not int or not 1<=limit<=200: raise Invalid('invalid limit')
            sql='SELECT * FROM team_work WHERE tenant_id=?'
            params=[tenant]
            if role!='owner':
                sql+=' AND (assignee=? OR created_by=?)' if role=='operator' else ' AND 0=1'
                if role=='operator': params.extend([actor,actor])
            if status is not None: sql+=' AND status=?';params.append(status)
            if target is not None: sql+=' AND assignee=?';params.append(target)
            sql+=' ORDER BY created_at DESC,id DESC LIMIT ?';params.append(limit)
            return {'items':[dict(x) for x in db.execute(sql,params)],'as_of':now,'limit':limit}
        if op in ('titan.work.get','titan.work.assign','titan.work.status','titan.work.note','titan.work.history'):
            mandatory=({'id'} if op.endswith(('.get','.history')) else
                       {'id','expected_version','assignee'} if op.endswith('.assign') else
                       {'id','expected_version','status'} if op.endswith('.status') else
                       {'id','expected_version','message'})
            _object(p,mandatory)
            row=self._work(db,tenant,p['id'])
            if not _visible(role,actor,row): raise Unauthorized('task not visible for actor')
            if op=='titan.work.get': return {'item':dict(row)}
            if op=='titan.work.history': return _history(db,tenant,row['id'])
            if row['version']!=_version(p['expected_version']): raise Conflict('stale task version')
            if op=='titan.work.assign':
                if role!='owner': raise Unauthorized('only owner can reassign')
                if row['status'] in ('done','cancelled'): raise Conflict('closed task cannot be reassigned')
                assignee=_active_actor(db,tenant,p['assignee'],now)
                if assignee==row['assignee']: raise Conflict('task already assigned to actor')
                db.execute('''UPDATE team_work SET assignee=?,version=?,updated_at=? WHERE id=? AND tenant_id=?''',
                           (assignee,row['version']+1,now,row['id'],tenant))
                head=_record(db,tenant,row['id'],actor,'assigned',
                             {'from':row['assignee'],'to':assignee,'version':row['version']+1},now)
                _notice(db,tenant,assignee,row['id'],'assignment',row['version']+1,
                        'Вам назначена задача: '+row['title'],now)
                return {'id':row['id'],'assignee':assignee,'version':row['version']+1,
                        'history_head':head}
            if role!='owner' and row['assignee']!=actor:
                raise Unauthorized('only assignee or owner can modify task')
            if op=='titan.work.status':
                status=p['status']
                if status not in TRANSITIONS[row['status']]: raise Conflict('invalid task status transition')
                db.execute('''UPDATE team_work SET status=?,version=?,updated_at=?,finished_at=?
                              WHERE id=? AND tenant_id=?''',
                           (status,row['version']+1,now,now if status in ('done','cancelled') else None,
                            row['id'],tenant))
                head=_record(db,tenant,row['id'],actor,'status',
                             {'from':row['status'],'to':status,'version':row['version']+1},now)
                if row['created_by']!=actor:
                    _notice(db,tenant,row['created_by'],row['id'],'status',row['version']+1,
                            'Изменён статус задачи: '+row['title'],now)
                return {'id':row['id'],'status':status,'version':row['version']+1,'history_head':head}
            message=_text(p['message'],'message',1200)
            db.execute('''UPDATE team_work SET version=?,updated_at=? WHERE id=? AND tenant_id=?''',
                       (row['version']+1,now,row['id'],tenant))
            head=_record(db,tenant,row['id'],actor,'note',
                         {'message':message,'version':row['version']+1},now)
            return {'id':row['id'],'version':row['version']+1,'history_head':head}
        if op=='titan.work.sla':
            _object(p,set())
            sql='SELECT status,due_at,assignee FROM team_work WHERE tenant_id=?'
            params=[tenant]
            if role!='owner':
                sql+=' AND (assignee=? OR created_by=?)' if role=='operator' else ' AND 0=1'
                if role=='operator':params.extend([actor,actor])
            counters=Counter()
            for row in db.execute(sql,params):
                counters[row['status']]+=1
                if row['status'] in ('open','in_progress'):
                    due=row['due_at']
                    counters['overdue' if due is not None and due<now else
                             'due_soon' if due is not None and due<=now+86400 else
                             'unscheduled' if due is None else 'scheduled_later']+=1
            return {'counts':{key:counters[key] for key in
                    ('open','in_progress','done','cancelled','overdue','due_soon','unscheduled','scheduled_later')},
                    'as_of':now,'source':'LOCAL_COMPUTED_NOT_BACKGROUND_JOB'}
        if op=='titan.notifications.refresh':
            _object(p,set())
            sql='''SELECT id,title,assignee,version,due_at FROM team_work WHERE tenant_id=?
                AND status IN ('open','in_progress') AND due_at IS NOT NULL AND due_at<=?'''
            params=[tenant,now+86400]
            if role!='owner':sql+=' AND assignee=?';params.append(actor)
            matched=0
            for row in db.execute(sql,params):
                kind='overdue' if row['due_at']<now else 'due_soon'
                _notice(db,tenant,row['assignee'],row['id'],kind,row['version'],
                        ('Просрочена задача: ' if kind=='overdue' else 'Приближается срок: ')+row['title'],now)
                matched+=1
            return {'matched':matched,'local_only':True}
        if op=='titan.notifications.list':
            _object(p,set(),{'unread_only','limit'})
            unread=p.get('unread_only',False);limit=p.get('limit',100)
            if type(unread) is not bool: raise Invalid('unread_only must be boolean')
            if type(limit) is not int or not 1<=limit<=200: raise Invalid('invalid limit')
            sql='''SELECT id,work_id,kind,body,created_at,read_at FROM team_notices
                   WHERE tenant_id=? AND recipient=?'''
            args=[tenant,actor]
            if unread:sql+=' AND read_at IS NULL'
            sql+=' ORDER BY created_at DESC,id DESC LIMIT ?';args.append(limit)
            items=[dict(x) for x in db.execute(sql,args)]
            count=db.execute('''SELECT COUNT(*) FROM team_notices
                   WHERE tenant_id=? AND recipient=? AND read_at IS NULL''',(tenant,actor)).fetchone()[0]
            return {'items':items,'unread_count':count,'local_only':True}
        if op=='titan.notifications.ack':
            _object(p,{'notification_id'})
            _identifier(p['notification_id'],'notification id')
            item=db.execute('''SELECT read_at FROM team_notices WHERE tenant_id=?
                       AND recipient=? AND id=?''',(tenant,actor,p['notification_id'])).fetchone()
            if item is None: raise Invalid('notification not found for actor')
            if item['read_at'] is None:
                db.execute('''UPDATE team_notices SET read_at=? WHERE tenant_id=? AND recipient=? AND id=?''',
                           (now,tenant,actor,p['notification_id']))
            return {'id':p['notification_id'],'read':True}
        raise Invalid('unknown M195 operation')
