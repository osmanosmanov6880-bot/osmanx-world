"""M200 local-only, tenant-scoped projected cash-flow with dated expenses.

The two write operations are schedule changes only. No payment is executed.
"""
from __future__ import annotations
import json

from osgard_m192.runtime import (
    KEY_RE, Conflict, Invalid, Unauthorized, canonical, _secret_hash,
    _identifier, _object,
)
from osgard_m193.runtime import _version
from osgard_m195.runtime import _due
from osgard_m196.runtime import _project, _record_project
from osgard_m197.runtime import _check_editable
from osgard_m199.runtime import Director199, _projects
from .model import parameters, forecast, integer

OPS = {
    'commerce.cashflow.schedule.set',
    'commerce.cashflow.schedule.list',
    'commerce.cashflow.forecast',
    'commerce.cashflow.compare',
}
WRITE = 'commerce.cashflow.schedule.set'


class Director200(Director199):
    """Migration adds only one table; prior M192-M199 schemas remain intact."""

    def initialize(self):
        super().initialize()
        with self.connect() as db:
            db.executescript("""
                CREATE TABLE IF NOT EXISTS delivery_expense_schedule (
                  expense_id TEXT PRIMARY KEY REFERENCES delivery_finance_expenses(id),
                  tenant_id TEXT NOT NULL,
                  project_id TEXT NOT NULL REFERENCES delivery_projects(id),
                  due_at INTEGER,
                  version INTEGER NOT NULL CHECK(version >= 1),
                  updated_by TEXT NOT NULL,
                  updated_at INTEGER NOT NULL
                );
                CREATE INDEX IF NOT EXISTS idx_delivery_expense_schedule_tenant
                  ON delivery_expense_schedule(tenant_id,project_id,due_at);
            """)

    def execute(self, token, op, payload, idem_key=None):
        if op not in OPS:
            return super().execute(token,op,payload,idem_key)
        if not isinstance(payload,dict):
            raise Invalid('cashflow payload must be an object')
        writing = op == WRITE
        if writing:
            if not isinstance(idem_key,str) or not KEY_RE.fullmatch(idem_key):
                raise Invalid('schedule change requires idempotency key')
        elif idem_key is not None:
            raise Invalid('read-only cashflow operations do not take idempotency keys')
        with self.connect(transaction=True) as db:
            identity = self._identity(db,token)
            if identity['role'] == 'viewer':
                raise Unauthorized('cashflow unavailable to viewer')
            tenant,actor = identity['tenant_id'],identity['actor']
            if writing:
                _object(payload,{'project_id','expense_id','expected_expense_version',
                                 'expected_schedule_version','due_at'})
                project=_project(db,tenant,payload['project_id'])
                _check_editable(identity,project)
                try:
                    request_sha=_secret_hash(canonical({'op':op,'payload':payload}))
                except (TypeError,ValueError) as e:
                    raise Invalid('invalid schedule request') from e
                cached=db.execute(
                    'SELECT op,request_sha,response_json FROM requests '
                    'WHERE tenant_id=? AND idem_key=?',(tenant,idem_key)
                ).fetchone()
                if cached:
                    if cached['op']!=op or cached['request_sha']!=request_sha:
                        raise Conflict('idempotency key reused with different request')
                    return json.loads(cached['response_json'])
                result=self._set_schedule(db,identity,project,payload)
                db.execute('INSERT INTO requests VALUES (?,?,?,?,?)',
                    (tenant,idem_key,op,request_sha,canonical(result)))
                db.execute('INSERT INTO audit(tenant_id,actor,operation,request_sha,recorded_at) '
                           'VALUES (?,?,?,?,?)',
                           (tenant,actor,op,request_sha,self.clock()))
                return result

            if op == 'commerce.cashflow.schedule.list':
                _object(payload,{'project_id'})
                project=_project(db,tenant,payload['project_id'])
                if identity['role']!='owner' and project['created_by']!=actor:
                    raise Unauthorized('only creator or owner can read expense schedules')
                data=[dict(row) for row in db.execute("""
                  SELECT e.id AS expense_id,e.title,e.amount_minor,e.kind,e.state,
                         e.version AS expense_version,
                         s.due_at,COALESCE(s.version,0) AS schedule_version
                  FROM delivery_finance_expenses e
                  LEFT JOIN delivery_expense_schedule s
                    ON s.tenant_id=e.tenant_id
                   AND s.project_id=e.project_id AND s.expense_id=e.id
                  WHERE e.tenant_id=? AND e.project_id=?
                  ORDER BY e.created_at DESC,e.id DESC LIMIT 501
                """,(tenant,project['id']))]
                if len(data)>500:
                    raise Invalid('more than 500 expenses; refusing partial schedule')
                return {'project_id':project['id'],'items':data,
                        'source':'LOCAL_SQLITE_ONLY'}

            as_of, months, state, scenarios = parameters(
                payload,self.clock(),compare=op=='commerce.cashflow.compare')
            projects = _projects(db,identity,state)
            result = [forecast(db,identity,projects,as_of,months,s) for s in scenarios]
            if op=='commerce.cashflow.forecast':
                return result[0]
            return {'schema':'osgard.m200.scenario-comparison/1',
                    'scenarios':result,'project_count':len(projects),
                    'months':months,'as_of_utc':as_of,
                    'bank_verified':False,'production_authorized':False}

    def _set_schedule(self,db,identity,project,p):
        tenant,actor=identity['tenant_id'],identity['actor']
        expense_id=_identifier(p['expense_id'],'expense_id')
        expected_expense=_version(p['expected_expense_version'])
        expected_schedule=integer(p['expected_schedule_version'],
                                  'expected_schedule_version',0,1000000)
        due_at=_due(p['due_at'],self.clock())
        expense=db.execute("""
           SELECT id,kind,state,version FROM delivery_finance_expenses
           WHERE tenant_id=? AND project_id=? AND id=?
        """,(tenant,project['id'],expense_id)).fetchone()
        if not expense:
            raise Invalid('expense not found in project')
        if expense['kind']!='planned' or expense['state']!='active':
            raise Conflict('only active planned expenses can be scheduled')
        if expense['version']!=expected_expense:
            raise Conflict('stale expense version')
        schedule=db.execute("""
           SELECT due_at,version FROM delivery_expense_schedule
           WHERE tenant_id=? AND project_id=? AND expense_id=?
        """,(tenant,project['id'],expense_id)).fetchone()
        if not schedule:
            if expected_schedule != 0 or due_at is None:
                raise Conflict('new schedule needs version zero and a due date')
            version=1
            db.execute("""
              INSERT INTO delivery_expense_schedule
                (expense_id,tenant_id,project_id,due_at,version,updated_by,updated_at)
              VALUES (?,?,?,?,?,?,?)
            """,(expense_id,tenant,project['id'],due_at,version,actor,self.clock()))
        else:
            if schedule['version']!=expected_schedule or schedule['due_at']==due_at:
                raise Conflict('stale or unchanged schedule')
            version=expected_schedule+1
            db.execute("""
              UPDATE delivery_expense_schedule
              SET due_at=?,version=?,updated_by=?,updated_at=?
              WHERE tenant_id=? AND project_id=? AND expense_id=?
            """,(due_at,version,actor,self.clock(),tenant,project['id'],expense_id))
        head=_record_project(db,tenant,project['id'],actor,'cashflow_schedule_changed',
            {'expense_id':expense_id,'due_at':due_at,'schedule_version':version},
            self.clock())
        return {'expense_id':expense_id,'expense_version':expense['version'],
                'schedule_version':version,'due_at':due_at,'event_head':head,
                'external_payment_executed':False}
