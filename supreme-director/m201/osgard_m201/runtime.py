"""M201 financial risk policies, alerts, local history and team task delegation.

Manual scans only. No polling, email, bank API, external side effects or
production permissions. All tenant and role constraints are server-side.
"""
from __future__ import annotations

from hashlib import sha256
import json

from osgard_m192.runtime import (
    KEY_RE, Invalid, Unauthorized, Conflict, canonical, _secret_hash,
    _uid, _identifier, _object, _text,
)
from osgard_m193.runtime import _version
from osgard_m195.runtime import _due, _active_actor, _record, _notice
from osgard_m199.runtime import _projects, _portfolio_overview, _epoch
from osgard_m200.runtime import Director200
from osgard_m200.model import forecast, scenario
from .risk_rules import RULES, validate_policy, evaluate_rules

OP_SET = 'commerce.alerts.policy.set'
OP_GET = 'commerce.alerts.policy.get'
OP_PREVIEW = 'commerce.alerts.preview'
OP_SCAN = 'commerce.alerts.scan'
OP_LIST = 'commerce.alerts.list'
OP_MINE = 'commerce.alerts.mine'
OP_HISTORY = 'commerce.alerts.history'
OP_ACK = 'commerce.alerts.ack'
OP_DISMISS = 'commerce.alerts.dismiss'
OP_TASK = 'commerce.alerts.task.create'
OPS = frozenset((OP_SET,OP_GET,OP_PREVIEW,OP_SCAN,OP_LIST,
                  OP_MINE,OP_HISTORY,OP_ACK,OP_DISMISS,OP_TASK))
WRITES = frozenset((OP_SET,OP_SCAN,OP_ACK,OP_DISMISS,OP_TASK))
LIFECYCLE = frozenset(('open','acknowledged','dismissed','cleared'))
GENESIS = '0'*64


def _policy(db, tenant):
    row = db.execute(
        'SELECT * FROM financial_alert_policies WHERE tenant_id=?',
        (tenant,)
    ).fetchone()
    if row is None:
        raise Invalid('configure an alert policy before scanning')
    config = json.loads(row['config_json'])
    if canonical(config) != row['config_json']:
        raise Conflict('alert policy integrity mismatch')
    validate_policy(config)
    return row, config


def _alert(db, tenant, alert_id):
    _identifier(alert_id,'alert_id')
    result = db.execute(
        'SELECT * FROM financial_alerts WHERE tenant_id=? AND id=?',
        (tenant,alert_id)
    ).fetchone()
    if result is None:
        raise Invalid('alert does not exist in this tenant')
    return result


def _event(db, tenant, alert_id, actor, action, payload, now):
    previous = db.execute(
        'SELECT event_hash FROM financial_alert_events '
        'WHERE tenant_id=? AND alert_id=? ORDER BY seq DESC LIMIT 1',
        (tenant,alert_id)
    ).fetchone()
    prev = previous['event_hash'] if previous else GENESIS
    source = {'tenant':tenant,'alert_id':alert_id,'actor':actor,
              'action':action,'payload':payload,'previous_hash':prev,'at':now}
    digest = sha256(canonical(source).encode('ascii')).hexdigest()
    db.execute(
        'INSERT INTO financial_alert_events '
        '(tenant_id,alert_id,actor,action,payload_json,at,previous_hash,event_hash) '
        'VALUES (?,?,?,?,?,?,?,?)',
        (tenant,alert_id,actor,action,canonical(payload),now,prev,digest)
    )
    return digest


def _history(db, tenant, alert_id):
    _alert(db,tenant,alert_id)
    previous = GENESIS
    events=[]
    for row in db.execute(
        'SELECT * FROM financial_alert_events '
        'WHERE tenant_id=? AND alert_id=? ORDER BY seq',
        (tenant,alert_id)
    ):
        payload=json.loads(row['payload_json'])
        source={'tenant':row['tenant_id'],'alert_id':row['alert_id'],
                'actor':row['actor'],'action':row['action'],
                'payload':payload,'previous_hash':previous,'at':row['at']}
        digest=sha256(canonical(source).encode('ascii')).hexdigest()
        if (row['previous_hash']!=previous or row['event_hash']!=digest
            or row['payload_json']!=canonical(payload)):
            raise Conflict('financial alert history integrity mismatch')
        previous=digest
        events.append({'actor':row['actor'],'action':row['action'],
                       'payload':payload,'at':row['at'],'event_hash':digest})
    return {'events':events[-200:], 'total':len(events), 'head':previous,
            'warning':'Local SHA-256 is not externally anchored or bank-verified.'}


def _snapshot(db, identity, cfg, now):
    entries=_projects(db,identity,cfg['project_state'])
    settings=scenario({'starting_balance_minor':cfg['starting_balance_minor'],
        'collection_rate_bp':cfg['collection_rate_bp'],
        'cost_overrun_bp':cfg['cost_overrun_bp']})
    prediction=forecast(db,identity,entries,now,cfg['months'],settings)
    overview=_portfolio_overview(db,identity,entries,now)
    rules=evaluate_rules(prediction,overview,cfg)
    return {'rules':rules,'cashflow':{
        'first_gap_month':prediction['first_gap_month'],
        'lowest_balance_minor':prediction['lowest_balance_minor'],
        'risk':prediction['risk'],
        'outside_horizon':prediction['outside_horizon'],
        'project_count':prediction['project_count']},
        'over_budget_project_count':overview['totals']['over_budget_projects'],
        'as_of_utc':now,'hypothetical':True,'bank_verified':False,
        'production_authorized':False}


def _alert_public(row):
    item=dict(row)
    item['evidence']=json.loads(item.pop('evidence_json'))
    return item


def _incident_stats(db,tenant):
    counts={name:0 for name in LIFECYCLE}
    for row in db.execute(
        'SELECT status,COUNT(*) AS count FROM financial_alerts '
        'WHERE tenant_id=? GROUP BY status',(tenant,)
    ):
        counts[row['status']]=row['count']
    return counts


class Director201(Director200):
    def initialize(self):
        super().initialize()
        with self.connect() as db:
            db.executescript("""
              CREATE TABLE IF NOT EXISTS financial_alert_policies(
                tenant_id TEXT PRIMARY KEY,
                config_json TEXT NOT NULL,version INTEGER NOT NULL CHECK(version>=1),
                updated_by TEXT NOT NULL,updated_at INTEGER NOT NULL);
              CREATE TABLE IF NOT EXISTS financial_alerts(
                id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL,
                rule TEXT NOT NULL,episode INTEGER NOT NULL CHECK(episode>=1),
                label TEXT NOT NULL,severity TEXT NOT NULL,
                status TEXT NOT NULL CHECK(status IN
                  ('open','acknowledged','dismissed','cleared')),
                observed_value INTEGER NOT NULL,threshold_value INTEGER NOT NULL,
                unit TEXT NOT NULL,first_gap_month TEXT,
                policy_version INTEGER NOT NULL,
                evidence_json TEXT NOT NULL,snapshot_hash TEXT NOT NULL,
                work_id TEXT,version INTEGER NOT NULL CHECK(version>=1),
                created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,
                closed_at INTEGER,
                UNIQUE(tenant_id,rule,episode));
              CREATE INDEX IF NOT EXISTS financial_alerts_tenant
                ON financial_alerts(tenant_id,created_at,id);
              CREATE TABLE IF NOT EXISTS financial_alert_state(
                tenant_id TEXT NOT NULL,rule TEXT NOT NULL,
                condition_active INTEGER NOT NULL CHECK(condition_active IN (0,1)),
                episode INTEGER NOT NULL CHECK(episode>=1),
                alert_id TEXT NOT NULL REFERENCES financial_alerts(id),
                updated_at INTEGER NOT NULL,
                PRIMARY KEY(tenant_id,rule));
              CREATE TABLE IF NOT EXISTS financial_alert_events(
                seq INTEGER PRIMARY KEY AUTOINCREMENT,
                tenant_id TEXT NOT NULL,alert_id TEXT NOT NULL,
                actor TEXT NOT NULL,action TEXT NOT NULL,
                payload_json TEXT NOT NULL,at INTEGER NOT NULL,
                previous_hash TEXT NOT NULL,event_hash TEXT NOT NULL);
              CREATE INDEX IF NOT EXISTS financial_alert_events_idx
                ON financial_alert_events(tenant_id,alert_id,seq);
              CREATE TRIGGER IF NOT EXISTS financial_alert_events_no_update
                BEFORE UPDATE ON financial_alert_events
                BEGIN SELECT RAISE(ABORT,'financial alert history is append only'); END;
              CREATE TRIGGER IF NOT EXISTS financial_alert_events_no_delete
                BEFORE DELETE ON financial_alert_events
                BEGIN SELECT RAISE(ABORT,'financial alert history is append only'); END;
            """)

    def execute(self,token,op,payload,idem_key=None):
        if op not in OPS:
            return super().execute(token,op,payload,idem_key)
        if type(payload) is not dict:
            raise Invalid('financial alert payload must be an object')
        writing=op in WRITES
        if writing:
            if not isinstance(idem_key,str) or not KEY_RE.fullmatch(idem_key):
                raise Invalid('financial write requires idempotency key')
        elif idem_key is not None:
            raise Invalid('financial read must not use idempotency key')
        with self.connect(transaction=True) as db:
            identity=self._identity(db,token)
            tenant,actor,role=identity['tenant_id'],identity['actor'],identity['role']
            if role!='owner' and op!=OP_MINE:
                raise Unauthorized('only tenant owner can access financial incidents')
            if role=='viewer':
                raise Unauthorized('viewer cannot access financial alerts')
            if writing:
                try:
                    req_sha=_secret_hash(canonical({'op':op,'payload':payload}))
                except (TypeError,ValueError) as error:
                    raise Invalid('non-JSON alert request') from error
                cached=db.execute(
                    'SELECT op,request_sha,response_json FROM requests '
                    'WHERE tenant_id=? AND idem_key=?',(tenant,idem_key)
                ).fetchone()
                if cached:
                    if cached['op']!=op or cached['request_sha']!=req_sha:
                        raise Conflict('idempotency key reused with different request')
                    return json.loads(cached['response_json'])
            result=self._apply_201(db,identity,op,payload)
            if writing:
                db.execute('INSERT INTO requests VALUES (?,?,?,?,?)',
                           (tenant,idem_key,op,req_sha,canonical(result)))
                db.execute(
                    'INSERT INTO audit(tenant_id,actor,operation,request_sha,recorded_at) '
                    'VALUES (?,?,?,?,?)',(tenant,actor,op,req_sha,self.clock())
                )
            return result

    def _apply_201(self,db,identity,op,p):
        tenant,actor,now=identity['tenant_id'],identity['actor'],self.clock()
        if op==OP_GET:
            _object(p,set())
            row=db.execute(
                'SELECT * FROM financial_alert_policies WHERE tenant_id=?',
                (tenant,)
            ).fetchone()
            return {'exists':row is not None,'version':row['version'] if row else 0,
                    'config':json.loads(row['config_json']) if row else None,
                    'bank_verified':False}
        if op==OP_SET:
            _object(p,{'expected_version','config'})
            version=p['expected_version']
            if type(version) is not int or not 0<=version<=1000000:
                raise Invalid('invalid expected policy version')
            config=validate_policy(p['config'])
            before=db.execute(
                'SELECT version,config_json FROM financial_alert_policies WHERE tenant_id=?',
                (tenant,)
            ).fetchone()
            if before is None:
                if version!=0:
                    raise Conflict('new policy requires expected_version zero')
                db.execute('INSERT INTO financial_alert_policies VALUES (?,?,?,?,?)',
                    (tenant,canonical(config),1,actor,now))
            else:
                if before['version']!=version:
                    raise Conflict('stale policy version')
                if before['config_json']==canonical(config):
                    raise Conflict('policy unchanged')
                db.execute('UPDATE financial_alert_policies SET config_json=?,'
                    'version=?,updated_by=?,updated_at=? WHERE tenant_id=?',
                    (canonical(config),version+1,actor,now,tenant))
            return {'version':version+1,'config':config,'saved':True,
                    'external_effects':False}
        if op in (OP_PREVIEW,OP_SCAN):
            _object(p,{'expected_policy_version'} if op==OP_SCAN else set(),
                    {'as_of'} if op==OP_PREVIEW else set())
            policy_row,cfg=_policy(db,tenant)
            if op==OP_SCAN and policy_row['version']!=_version(p['expected_policy_version']):
                raise Conflict('stale policy version for risk scan')
            effective=_epoch(p.get('as_of',now)) if op==OP_PREVIEW else _epoch(now)
            snapshot=_snapshot(db,identity,cfg,effective)
            if op==OP_PREVIEW:
                return {'policy_version':policy_row['version'],**snapshot,
                        'persisted':False,'external_notifications':False}
            return self._scan(db,identity,policy_row,snapshot,now)
        if op==OP_LIST:
            _object(p,set(),{'status','limit'})
            status=p.get('status')
            if status is not None and (type(status) is not str or status not in LIFECYCLE):
                raise Invalid('invalid alert status filter')
            limit=p.get('limit',100)
            if type(limit) is not int or not 1<=limit<=200:
                raise Invalid('alert limit must be integer from 1 to 200')
            statement='SELECT a.*,w.assignee,w.status AS work_status FROM financial_alerts a '
            statement+='LEFT JOIN team_work w ON w.tenant_id=a.tenant_id AND w.id=a.work_id '
            statement+='WHERE a.tenant_id=?'
            args=[tenant]
            if status:
                statement+=' AND a.status=?';args.append(status)
            statement+=' ORDER BY a.created_at DESC,a.id DESC LIMIT ?';args.append(limit)
            rows=[_alert_public(r) for r in db.execute(statement,args)]
            total=db.execute('SELECT COUNT(*) FROM financial_alerts WHERE tenant_id=?'+
                (' AND status=?' if status else ''), (tenant,status) if status else (tenant,)).fetchone()[0]
            return {'items':rows,'total':total,'limit':limit,
                    'truncated':total>len(rows),'summary':_incident_stats(db,tenant),
                    'bank_verified':False}
        if op==OP_MINE:
            _object(p,set(),{'limit'})
            limit=p.get('limit',100)
            if type(limit) is not int or not 1<=limit<=100:
                raise Invalid('limit must be integer from 1 to 100')
            rows=db.execute("""
                SELECT a.id,a.rule,a.label,a.severity,a.status,
                       a.work_id,w.status AS work_status
                FROM financial_alerts a JOIN team_work w
                  ON w.tenant_id=a.tenant_id AND w.id=a.work_id
                WHERE a.tenant_id=? AND w.assignee=?
                ORDER BY a.created_at DESC,a.id DESC LIMIT ?
            """,(tenant,actor,limit))
            return {'items':[dict(r) for r in rows],
                    'financial_values_redacted':True,'scope':'ASSIGNED_TASKS_ONLY'}
        if op==OP_HISTORY:
            _object(p,{'alert_id'})
            return _history(db,tenant,p['alert_id'])
        if op in (OP_ACK,OP_DISMISS):
            required={'alert_id','expected_version'}
            if op==OP_DISMISS:
                required.add('reason')
            _object(p,required)
            alert=_alert(db,tenant,p['alert_id'])
            if alert['version']!=_version(p['expected_version']):
                raise Conflict('stale alert version')
            if op==OP_ACK and alert['status']!='open':
                raise Conflict('only open alerts may be acknowledged')
            if op==OP_DISMISS and alert['status'] not in ('open','acknowledged'):
                raise Conflict('alert already dismissed or cleared')
            target='acknowledged' if op==OP_ACK else 'dismissed'
            reason=_text(p['reason'],'reason',300) if op==OP_DISMISS else None
            db.execute('UPDATE financial_alerts SET status=?,version=version+1,'
                       'updated_at=?,closed_at=? WHERE id=? AND tenant_id=?',
                       (target,now,now if target=='dismissed' else None,alert['id'],tenant))
            head=_event(db,tenant,alert['id'],actor,target,
                        {'from':alert['status'],'reason':reason},now)
            return {'alert_id':alert['id'],'status':target,
                    'version':alert['version']+1,'history_head':head}
        if op==OP_TASK:
            _object(p,{'alert_id','expected_version','assignee'},{'due_at'})
            alert=_alert(db,tenant,p['alert_id'])
            if alert['version']!=_version(p['expected_version']):
                raise Conflict('stale alert version')
            if alert['status'] not in ('open','acknowledged'):
                raise Conflict('cannot assign closed alert')
            if alert['work_id']:
                raise Conflict('alert already has an employee task')
            assignee=_active_actor(db,tenant,p['assignee'],now)
            due=_due(p.get('due_at',now+2*86400),now)
            task_id=_uid()
            title='Проверить финансовый риск: '+alert['label']
            description=(
                'Локальное предупреждение OSGARD '+alert['rule']+
                '. Проверьте исходные данные, причину риска и предложите действия. '
                'Прогноз не является банковским подтверждением.'
            )
            priority='critical' if alert['severity']=='critical' else 'high'
            db.execute('INSERT INTO team_work VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
                (task_id,tenant,title,description,assignee,actor,priority,'open',
                 None,due,1,now,now,None))
            task_head=_record(db,tenant,task_id,actor,'created',{
                'title':title,'description':description,'priority':priority,
                'assignee':assignee,'due_at':due,'crm_activity_id':None},now)
            if assignee!=actor:
                _notice(db,tenant,assignee,task_id,'assignment',1,
                    'Вам назначена задача: '+title,now)
            db.execute('UPDATE financial_alerts SET work_id=?,version=version+1,'
                'updated_at=? WHERE tenant_id=? AND id=?',
                (task_id,now,tenant,alert['id']))
            head=_event(db,tenant,alert['id'],actor,'delegated',{
                'work_id':task_id,'assignee':assignee,'task_version':1},now)
            return {'alert_id':alert['id'],'version':alert['version']+1,
                    'work_id':task_id,'assignee':assignee,'task_history_head':task_head,
                    'history_head':head,'external_notification_sent':False}
        raise Invalid('unsupported M201 operation')

    def _scan(self,db,identity,policy_row,snapshot,now):
        tenant,actor=identity['tenant_id'],identity['actor']
        created,updated,cleared,suppressed=[],[],[],[]
        for item in snapshot['rules']:
            rule=item['rule']
            prev=db.execute('SELECT * FROM financial_alert_state '
                'WHERE tenant_id=? AND rule=?',(tenant,rule)).fetchone()
            if item['present']:
                fingerprint=sha256(canonical({
                    'policy_version':policy_row['version'], 'rule':rule,
                    'observed':item['observed'],'threshold':item['threshold'],
                    'month':item['first_gap_month']}).encode('ascii')).hexdigest()
                if prev is None or not prev['condition_active']:
                    new_id=_uid()
                    episode=prev['episode']+1 if prev else 1
                    db.execute("""
                        INSERT INTO financial_alerts
                        (id,tenant_id,rule,episode,label,severity,status,
                         observed_value,threshold_value,unit,first_gap_month,
                         policy_version,evidence_json,snapshot_hash,work_id,
                         version,created_at,updated_at,closed_at)
                        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
                    """,(new_id,tenant,rule,episode,item['label'],item['severity'],
                          'open',item['observed'],item['threshold'],item['unit'],
                          item['first_gap_month'],policy_row['version'],
                          canonical(item),fingerprint,None,1,now,now,None))
                    if prev is None:
                        db.execute('INSERT INTO financial_alert_state VALUES (?,?,?,?,?,?)',
                            (tenant,rule,1,episode,new_id,now))
                    else:
                        db.execute('UPDATE financial_alert_state SET condition_active=1,'
                            'episode=?,alert_id=?,updated_at=? WHERE tenant_id=? AND rule=?',
                            (episode,new_id,now,tenant,rule))
                    _event(db,tenant,new_id,actor,'detected',
                           {'rule':rule,'fingerprint':fingerprint},now)
                    created.append(new_id)
                else:
                    active=_alert(db,tenant,prev['alert_id'])
                    if active['snapshot_hash']==fingerprint:
                        suppressed.append(active['id'])
                        continue
                    db.execute("""
                        UPDATE financial_alerts SET observed_value=?,threshold_value=?,
                          first_gap_month=?,policy_version=?,evidence_json=?,
                          snapshot_hash=?,updated_at=?,version=version+1
                        WHERE tenant_id=? AND id=?
                    """,(item['observed'],item['threshold'],item['first_gap_month'],
                          policy_row['version'],canonical(item),fingerprint,now,
                          tenant,active['id']))
                    _event(db,tenant,active['id'],actor,'evidence_changed',{
                        'observed':item['observed'],'policy_version':policy_row['version'],
                        'fingerprint':fingerprint},now)
                    updated.append(active['id'])
            elif prev is not None and prev['condition_active']:
                active=_alert(db,tenant,prev['alert_id'])
                db.execute('UPDATE financial_alert_state SET condition_active=0,'
                    'updated_at=? WHERE tenant_id=? AND rule=?',(now,tenant,rule))
                db.execute('UPDATE financial_alerts SET status=?,version=version+1,'
                    'updated_at=?,closed_at=? WHERE tenant_id=? AND id=?',
                    ('cleared',now,now,tenant,active['id']))
                _event(db,tenant,active['id'],actor,'cleared',
                       {'previous_status':active['status'],'rule':rule},now)
                cleared.append(active['id'])
        return {'created':created,'updated':updated,'cleared':cleared,
                'deduplicated':suppressed,'created_count':len(created),
                'policy_version':policy_row['version'],
                'rules_checked':len(snapshot['rules']),
                'at':now,'external_notifications_sent':False,
                'bank_verified':False,'production_authorized':False}
