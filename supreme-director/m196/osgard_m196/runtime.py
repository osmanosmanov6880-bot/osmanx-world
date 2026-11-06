"""M196: tenant-scoped delivery projects, stages and linked employee work.

An additive local SQLite module built on M195; external effects are forbidden.
Project completion requires real local stage/task evidence, never verifies 180
historical engineering tasks or authorizes production.
"""
from __future__ import annotations

from collections import Counter
from hashlib import sha256
import json

from osgard_m192.runtime import (ROLES, KEY_RE, Invalid, Unauthorized, Conflict,
    canonical, _secret_hash, _uid, _text, _object, _identifier)
from osgard_m193.runtime import _version
from osgard_m195.runtime import Director195, _record, _visible, _due

OPS196 = {
    'commerce.projects.create': {'owner', 'operator'},
    'commerce.projects.list': ROLES,
    'commerce.projects.get': ROLES,
    'commerce.projects.stage.add': {'owner', 'operator'},
    'commerce.projects.stage.status': {'owner', 'operator'},
    'commerce.projects.status': {'owner', 'operator'},
    'commerce.projects.events': {'owner', 'operator'},
    'titan.work.project.link': {'owner', 'operator'},
    'titan.work.project.unlink': {'owner', 'operator'},
}
WRITES196 = frozenset({'commerce.projects.create', 'commerce.projects.stage.add',
    'commerce.projects.stage.status', 'commerce.projects.status',
    'titan.work.project.link', 'titan.work.project.unlink'})
PROJECT_TRANSITIONS = {
    'planned': {'active', 'cancelled'},
    'active': {'completed', 'cancelled'},
    'completed': set(),
    'cancelled': set(),
}
STAGE_TRANSITIONS = {'pending': {'active'}, 'active': {'done'}, 'done': set()}
GENESIS = '0' * 64


def _project(db, tenant, project_id):
    _identifier(project_id, 'project id')
    row = db.execute('SELECT * FROM delivery_projects WHERE tenant_id=? AND id=?',
                     (tenant, project_id)).fetchone()
    if row is None:
        raise Invalid('project not found for this organization')
    return row


def _stage(db, tenant, stage_id, project_id):
    _identifier(stage_id, 'stage id')
    row = db.execute('''SELECT * FROM delivery_stages
                        WHERE tenant_id=? AND id=? AND project_id=?''',
                     (tenant, stage_id, project_id)).fetchone()
    if row is None:
        raise Invalid('stage not found for project')
    return row


def _project_edit(identity, project):
    if identity['role'] != 'owner' and identity['actor'] != project['created_by']:
        raise Unauthorized('only project creator or owner may edit project')


def _record_project(db, tenant, project_id, actor, kind, payload, now):
    last = db.execute('''SELECT event_hash FROM delivery_events
      WHERE tenant_id=? AND project_id=? ORDER BY seq DESC LIMIT 1''',
      (tenant, project_id)).fetchone()
    previous = last['event_hash'] if last else GENESIS
    event = {'tenant': tenant, 'project_id': project_id, 'actor': actor,
             'kind': kind, 'payload': payload, 'previous_hash': previous, 'at': now}
    digest = sha256(canonical(event).encode('ascii')).hexdigest()
    db.execute('''INSERT INTO delivery_events
      (tenant_id,project_id,actor,kind,payload_json,at,previous_hash,event_hash)
      VALUES (?,?,?,?,?,?,?,?)''',
      (tenant, project_id, actor, kind, canonical(payload), now, previous, digest))
    return digest


def _project_history(db, tenant, project_id):
    result = []
    previous = GENESIS
    for row in db.execute('''SELECT * FROM delivery_events
            WHERE tenant_id=? AND project_id=? ORDER BY seq''', (tenant, project_id)):
        payload = json.loads(row['payload_json'])
        if row['payload_json'] != canonical(payload):
            raise Conflict('project history canonicalization mismatch')
        event = {'tenant': row['tenant_id'], 'project_id': row['project_id'],
                 'actor': row['actor'], 'kind': row['kind'],
                 'payload': payload, 'previous_hash': previous, 'at': row['at']}
        digest = sha256(canonical(event).encode('ascii')).hexdigest()
        if row['previous_hash'] != previous or row['event_hash'] != digest:
            raise Conflict('project history integrity mismatch')
        previous = digest
        result.append({'actor': row['actor'], 'kind': row['kind'],
                       'payload': payload, 'at': row['at'], 'event_hash': digest})
    return {'events': result[-200:], 'total': len(result), 'head': previous,
            'warning': 'Local SHA-256 chain is not externally anchored.'}


class Director196(Director195):
    def initialize(self):
        super().initialize()
        with self.connect() as db:
            db.executescript('''
              CREATE TABLE IF NOT EXISTS delivery_projects (
                id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL,
                customer_id TEXT NOT NULL REFERENCES customers(id),
                deal_id TEXT NOT NULL REFERENCES deals(id),
                title TEXT NOT NULL, description TEXT NOT NULL,
                created_by TEXT NOT NULL, state TEXT NOT NULL
                  CHECK(state IN ('planned','active','completed','cancelled')),
                version INTEGER NOT NULL CHECK(version>=1),
                created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
                finished_at INTEGER);
              CREATE INDEX IF NOT EXISTS delivery_projects_tenant
                ON delivery_projects(tenant_id,created_at,id);
              CREATE TABLE IF NOT EXISTS delivery_stages (
                id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL,
                project_id TEXT NOT NULL REFERENCES delivery_projects(id),
                title TEXT NOT NULL, rank INTEGER NOT NULL CHECK(rank BETWEEN 1 AND 30),
                status TEXT NOT NULL CHECK(status IN ('pending','active','done')),
                due_at INTEGER, version INTEGER NOT NULL CHECK(version>=1),
                created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
                finished_at INTEGER, UNIQUE(tenant_id,project_id,rank));
              CREATE INDEX IF NOT EXISTS delivery_stages_project
                ON delivery_stages(tenant_id,project_id,rank);
              CREATE TABLE IF NOT EXISTS delivery_work_links (
                tenant_id TEXT NOT NULL, work_id TEXT PRIMARY KEY REFERENCES team_work(id),
                project_id TEXT NOT NULL REFERENCES delivery_projects(id),
                stage_id TEXT NOT NULL REFERENCES delivery_stages(id),
                linked_by TEXT NOT NULL, linked_at INTEGER NOT NULL);
              CREATE INDEX IF NOT EXISTS delivery_work_project
                ON delivery_work_links(tenant_id,project_id,stage_id);
              CREATE TABLE IF NOT EXISTS delivery_events (
                seq INTEGER PRIMARY KEY AUTOINCREMENT, tenant_id TEXT NOT NULL,
                project_id TEXT NOT NULL, actor TEXT NOT NULL, kind TEXT NOT NULL,
                payload_json TEXT NOT NULL, at INTEGER NOT NULL,
                previous_hash TEXT NOT NULL, event_hash TEXT NOT NULL);
              CREATE INDEX IF NOT EXISTS delivery_events_project
                ON delivery_events(tenant_id,project_id,seq);
              CREATE TRIGGER IF NOT EXISTS delivery_events_immutable_update
                BEFORE UPDATE ON delivery_events
                BEGIN SELECT RAISE(ABORT,'project events are append-only'); END;
              CREATE TRIGGER IF NOT EXISTS delivery_events_immutable_delete
                BEFORE DELETE ON delivery_events
                BEGIN SELECT RAISE(ABORT,'project events are append-only'); END;
            ''')

    def execute(self, token, op, payload, idem_key=None):
        if op not in OPS196:
            return super().execute(token, op, payload, idem_key)
        if not isinstance(payload, dict):
            raise Invalid('payload must be an object')
        writing = op in WRITES196
        if writing and (not isinstance(idem_key, str) or not KEY_RE.fullmatch(idem_key)):
            raise Invalid('write operation requires idempotency key')
        with self.connect(transaction=True) as db:
            identity = self._identity(db, token)
            if identity['role'] not in OPS196[op]:
                raise Unauthorized('permission denied')
            tenant = identity['tenant_id']
            if writing:
                try:
                    sha = _secret_hash(canonical({'op': op, 'payload': payload}))
                except (ValueError, TypeError) as error:
                    raise Invalid('non-JSON request data') from error
                stored = db.execute('''SELECT op,request_sha,response_json FROM requests
                    WHERE tenant_id=? AND idem_key=?''',(tenant,idem_key)).fetchone()
                if stored is not None:
                    if stored['op'] != op or stored['request_sha'] != sha:
                        raise Conflict('idempotency key reused with different request')
                    return json.loads(stored['response_json'])
            result = self._apply_196(db, identity, op, payload)
            if writing:
                db.execute('INSERT INTO requests VALUES (?,?,?,?,?)',
                           (tenant,idem_key,op,sha,canonical(result)))
                db.execute('''INSERT INTO audit(tenant_id,actor,operation,request_sha,recorded_at)
                              VALUES (?,?,?,?,?)''',
                           (tenant, identity['actor'],op,sha,self.clock()))
            return result

    def _project_view(self, db, tenant, identity, project_id):
        proj = _project(db,tenant,project_id)
        stages = [dict(r) for r in db.execute('''SELECT * FROM delivery_stages
            WHERE tenant_id=? AND project_id=? ORDER BY rank''', (tenant,project_id))]
        links = list(db.execute('''SELECT w.id,w.title,w.status,w.priority,w.due_at,
          w.assignee,w.created_by,w.version,l.stage_id,l.project_id FROM delivery_work_links l
          JOIN team_work w ON w.id=l.work_id AND w.tenant_id=l.tenant_id
          WHERE l.tenant_id=? AND l.project_id=? ORDER BY w.created_at,w.id''',
          (tenant,project_id)))
        per_stage = {s['id']: [] for s in stages}
        counts = Counter()
        for work in links:
            counts[work['stage_id']] += 1
            if _visible(identity['role'],identity['actor'],work):
                per_stage[work['stage_id']].append(dict(work))
        finished = sum(s['status']=='done' for s in stages)
        for stage in stages:
            tasks = per_stage[stage['id']]
            stage['tasks'] = tasks
            stage['linked_total'] = counts[stage['id']]
            stage['linked_done'] = sum(w['status']=='done' for w in links if w['stage_id']==stage['id'])
            stage['tasks_filtered_by_permissions'] = len(tasks) != stage['linked_total']
        return {'project': dict(proj), 'stages': stages,
                'completed_stages': finished,
                'progress_percent': round(finished * 100 / len(stages),1) if stages else 0,
                'source': 'LOCAL_TENANT_SQLITE', 'external_approval': False}

    def _apply_196(self, db, identity, op, p):
        tenant, actor, role = identity['tenant_id'], identity['actor'], identity['role']
        now = self.clock()
        if op == 'commerce.projects.create':
            _object(p, {'deal_id','title'}, {'description'})
            deal_id = _identifier(p['deal_id'],'deal id')
            deal = db.execute('SELECT * FROM deals WHERE id=? AND tenant_id=?',
                              (deal_id,tenant)).fetchone()
            if deal is None:
                raise Invalid('deal missing from tenant')
            title = _text(p['title'],'title',160)
            description = _text(p['description'],'description',1200) if p.get('description') else ''
            project_id = _uid()
            db.execute('''INSERT INTO delivery_projects VALUES (?,?,?,?,?,?,?,?,?,?,?,?)''',
                (project_id,tenant,deal['customer_id'],deal_id,title,description,actor,
                 'planned',1,now,now,None))
            head = _record_project(db,tenant,project_id,actor,'created',
                                   {'title': title,'deal_id':deal_id,'customer_id':deal['customer_id']},now)
            return {'id':project_id,'version':1,'state':'planned','event_head':head}
        if op == 'commerce.projects.list':
            _object(p,set(),{'limit','state'})
            limit = p.get('limit',100)
            if type(limit) is not int or not 1<=limit<=200:
                raise Invalid('invalid limit')
            state = p.get('state')
            if state is not None and state not in PROJECT_TRANSITIONS:
                raise Invalid('invalid state')
            query = '''SELECT p.*,c.name AS customer_name,d.title AS deal_title,
                 (SELECT COUNT(*) FROM delivery_stages s WHERE s.tenant_id=p.tenant_id
                  AND s.project_id=p.id) AS stages_total,
                 (SELECT COUNT(*) FROM delivery_stages s WHERE s.tenant_id=p.tenant_id
                  AND s.project_id=p.id AND s.status='done') AS stages_done
                 FROM delivery_projects p
                 JOIN customers c ON c.id=p.customer_id AND c.tenant_id=p.tenant_id
                 JOIN deals d ON d.id=p.deal_id AND d.tenant_id=p.tenant_id
                 WHERE p.tenant_id=?'''
            params=[tenant]
            if state:
                query+=' AND p.state=?';params.append(state)
            query+=' ORDER BY p.created_at DESC,p.id DESC LIMIT ?';params.append(limit)
            return {'items':[dict(row) for row in db.execute(query,params)], 'limit':limit}
        if op in ('commerce.projects.get','commerce.projects.events'):
            _object(p,{'project_id'})
            if op.endswith('.get'):
                return self._project_view(db,tenant,identity,p['project_id'])
            proj=_project(db,tenant,p['project_id'])
            _project_edit(identity,proj)
            return _project_history(db,tenant,proj['id'])
        if op == 'commerce.projects.stage.add':
            _object(p,{'project_id','expected_version','title'}, {'due_at'})
            proj=_project(db,tenant,p['project_id'])
            _project_edit(identity,proj)
            if proj['version']!=_version(p['expected_version']):
                raise Conflict('stale project version')
            if proj['state'] not in ('planned','active'):
                raise Conflict('project is closed')
            title=_text(p['title'],'stage title',160)
            due=_due(p.get('due_at'),now)
            position=db.execute('''SELECT COALESCE(MAX(rank),0)+1 AS next FROM delivery_stages
                       WHERE tenant_id=? AND project_id=?''', (tenant,proj['id'])).fetchone()['next']
            if position > 30:
                raise Invalid('at most 30 project stages')
            stage_id=_uid()
            db.execute('''INSERT INTO delivery_stages VALUES (?,?,?,?,?,?,?,?,?,?,?)''',
                       (stage_id,tenant,proj['id'],title,position,'pending',due,1,now,now,None))
            db.execute('UPDATE delivery_projects SET version=?,updated_at=? WHERE id=? AND tenant_id=?',
                       (proj['version']+1,now,proj['id'],tenant))
            _record_project(db,tenant,proj['id'],actor,'stage_added',
                            {'stage_id':stage_id,'title':title,'rank':position},now)
            return {'id':stage_id,'project_id':proj['id'],'rank':position,
                    'version':1,'project_version':proj['version']+1}
        if op == 'commerce.projects.status':
            _object(p,{'project_id','expected_version','state'})
            proj=_project(db,tenant,p['project_id']); _project_edit(identity,proj)
            if proj['version']!=_version(p['expected_version']):
                raise Conflict('stale project version')
            new=p['state']
            if new not in PROJECT_TRANSITIONS[proj['state']]:
                raise Conflict('invalid project transition')
            if new=='active' and not db.execute('''SELECT 1 FROM delivery_stages
                 WHERE tenant_id=? AND project_id=? LIMIT 1''',(tenant,proj['id'])).fetchone():
                raise Conflict('add a stage before activating project')
            if new=='completed':
                any_unfinished=db.execute('''SELECT 1 FROM delivery_stages
                  WHERE tenant_id=? AND project_id=? AND status!='done' LIMIT 1''',
                  (tenant,proj['id'])).fetchone()
                total=db.execute('''SELECT COUNT(*) AS n FROM delivery_stages
                    WHERE tenant_id=? AND project_id=?''',(tenant,proj['id'])).fetchone()['n']
                if any_unfinished or not total:
                    raise Conflict('all stages must be completed')
            db.execute('''UPDATE delivery_projects SET state=?,version=?,updated_at=?,finished_at=?
                          WHERE id=? AND tenant_id=?''',
                       (new,proj['version']+1,now,now if new in ('completed','cancelled') else None,
                        proj['id'],tenant))
            head=_record_project(db,tenant,proj['id'],actor,'project_state',
                                 {'from':proj['state'],'to':new,'version':proj['version']+1},now)
            return {'id':proj['id'],'state':new,'version':proj['version']+1,'event_head':head}
        if op == 'commerce.projects.stage.status':
            _object(p,{'project_id','stage_id','expected_version','status'})
            proj=_project(db,tenant,p['project_id']);_project_edit(identity,proj)
            if proj['state']!='active':
                raise Conflict('project must be active')
            stage=_stage(db,tenant,p['stage_id'],proj['id'])
            if stage['version']!=_version(p['expected_version']):
                raise Conflict('stale stage version')
            new=p['status']
            if new not in STAGE_TRANSITIONS[stage['status']]:
                raise Conflict('invalid stage transition')
            previous=db.execute('''SELECT status FROM delivery_stages
                WHERE tenant_id=? AND project_id=? AND rank=?''',
                (tenant,proj['id'],stage['rank']-1)).fetchone()
            if previous and previous['status']!='done':
                raise Conflict('previous stage must be done')
            if new=='done':
                incomplete=db.execute('''SELECT 1 FROM delivery_work_links l
                 JOIN team_work w ON w.id=l.work_id AND w.tenant_id=l.tenant_id
                 WHERE l.tenant_id=? AND l.project_id=? AND l.stage_id=?
                   AND w.status!='done' LIMIT 1''',
                 (tenant,proj['id'],stage['id'])).fetchone()
                if incomplete:
                    raise Conflict('unfinished linked work prevents closing stage')
            db.execute('''UPDATE delivery_stages SET status=?,version=?,updated_at=?,finished_at=?
                          WHERE id=? AND tenant_id=?''',
                       (new,stage['version']+1,now,now if new=='done' else None,
                        stage['id'],tenant))
            head=_record_project(db,tenant,proj['id'],actor,'stage_status',
                                 {'stage_id':stage['id'],'from':stage['status'],
                                  'to':new,'version':stage['version']+1},now)
            return {'id':stage['id'],'status':new,'version':stage['version']+1,'event_head':head}
        if op == 'titan.work.project.link':
            _object(p,{'work_id','expected_version','project_id','stage_id'})
            proj=_project(db,tenant,p['project_id'])
            if proj['state'] not in ('planned','active'):
                raise Conflict('cannot link work to closed project')
            stage=_stage(db,tenant,p['stage_id'],proj['id'])
            if stage['status']=='done':
                raise Conflict('cannot link work to completed stage')
            work=self._work(db,tenant,p['work_id'])
            if not _visible(role,actor,work) or (role!='owner' and work['assignee']!=actor):
                raise Unauthorized('only assignee or owner can link task')
            if work['version']!=_version(p['expected_version']):
                raise Conflict('stale task version')
            if work['status'] in ('done','cancelled'):
                raise Conflict('cannot link closed task')
            if work['crm_activity_id']:
                activity=db.execute('''SELECT customer_id,deal_id FROM crm_activities
                  WHERE tenant_id=? AND id=?''',(tenant,work['crm_activity_id'])).fetchone()
                if activity is None or activity['customer_id']!=proj['customer_id'] or (
                        activity['deal_id'] is not None and activity['deal_id']!=proj['deal_id']):
                    raise Conflict('CRM activity does not match project deal/customer')
            existing=db.execute('''SELECT project_id,stage_id FROM delivery_work_links
                  WHERE tenant_id=? AND work_id=?''',(tenant,work['id'])).fetchone()
            if existing:
                if existing['project_id']!=proj['id']:
                    raise Conflict('task already linked to a different project; unlink first')
                if existing['stage_id']==stage['id']:
                    raise Conflict('task already linked to this stage')
                oldstage=_stage(db,tenant,existing['stage_id'],proj['id'])
                if oldstage['status']=='done':
                    raise Conflict('cannot move task from completed stage')
                db.execute('''UPDATE delivery_work_links SET stage_id=?,linked_by=?,linked_at=?
                              WHERE tenant_id=? AND work_id=?''',
                           (stage['id'],actor,now,tenant,work['id']))
            else:
                db.execute('''INSERT INTO delivery_work_links VALUES (?,?,?,?,?,?)''',
                           (tenant,work['id'],proj['id'],stage['id'],actor,now))
            db.execute('''UPDATE team_work SET version=?,updated_at=? WHERE tenant_id=? AND id=?''',
                       (work['version']+1,now,tenant,work['id']))
            _record(db,tenant,work['id'],actor,'project_linked',
                    {'project_id':proj['id'],'stage_id':stage['id'],
                     'version':work['version']+1},now)
            head=_record_project(db,tenant,proj['id'],actor,'task_linked',
                                 {'work_id':work['id'],'stage_id':stage['id']},now)
            return {'work_id':work['id'],'version':work['version']+1,
                    'project_id':proj['id'],'stage_id':stage['id'],'event_head':head}
        if op == 'titan.work.project.unlink':
            _object(p,{'work_id','expected_version'})
            work=self._work(db,tenant,p['work_id'])
            if not _visible(role,actor,work) or (role!='owner' and work['assignee']!=actor):
                raise Unauthorized('cannot unlink task')
            if work['version']!=_version(p['expected_version']):
                raise Conflict('stale task version')
            linked=db.execute('''SELECT * FROM delivery_work_links
                 WHERE tenant_id=? AND work_id=?''',(tenant,work['id'])).fetchone()
            if not linked: raise Conflict('task is not linked')
            proj=_project(db,tenant,linked['project_id'])
            stage=_stage(db,tenant,linked['stage_id'],proj['id'])
            if proj['state'] not in ('planned','active') or stage['status']=='done':
                raise Conflict('cannot unlink from completed stage or closed project')
            db.execute('DELETE FROM delivery_work_links WHERE tenant_id=? AND work_id=?',
                       (tenant,work['id']))
            db.execute('UPDATE team_work SET version=?,updated_at=? WHERE tenant_id=? AND id=?',
                       (work['version']+1,now,tenant,work['id']))
            _record(db,tenant,work['id'],actor,'project_unlinked',
                    {'project_id':proj['id'],'stage_id':stage['id'],
                     'version':work['version']+1},now)
            head=_record_project(db,tenant,proj['id'],actor,'task_unlinked',
                                 {'work_id':work['id'],'stage_id':stage['id']},now)
            return {'work_id':work['id'],'version':work['version']+1,'event_head':head}
        raise Invalid('unknown M196 operation')
