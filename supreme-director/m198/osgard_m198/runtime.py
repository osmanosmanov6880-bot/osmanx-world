"""M198: tenant-isolated, local-only project finance forecasting.

All money is integer kopecks. 'recorded' receivables are MANUAL observations,
not proof of a bank transfer. There are no payment or banking integrations.
"""
from __future__ import annotations

from collections import Counter
from hashlib import sha256
import json

from osgard_m192.runtime import (KEY_RE, Invalid, Unauthorized, Conflict,
    canonical, _secret_hash, _uid, _text, _object, _identifier)
from osgard_m193.runtime import _version
from osgard_m195.runtime import _due
from osgard_m196.runtime import _project, _project_edit, _record_project, _project_history, _stage
from osgard_m197.runtime import Director197, _check_editable

MAX_MINOR = 10**12
FINANCE_WRITES = frozenset({
    'commerce.finance.budget.set',
    'commerce.finance.expenses.add',
    'commerce.finance.expenses.commit',
    'commerce.finance.expenses.void',
    'commerce.finance.receivables.add',
    'commerce.finance.receivables.resolve',
})
FINANCE_READS = frozenset({'commerce.finance.snapshot', 'commerce.finance.history'})
FINANCE_OPS = FINANCE_READS | FINANCE_WRITES
EXPENSE_TYPES = frozenset({'planned', 'incurred'})
EXPENSE_CATEGORIES = frozenset({'materials', 'labor', 'software', 'services', 'other'})
RECEIVABLE_STATES = frozenset({'pending', 'recorded', 'cancelled'})


def _money(value, *, zero=False):
    if type(value) is not int or not (0 if zero else 1) <= value <= MAX_MINOR:
        raise Invalid('amount_minor must be integer kopecks within allowed range')
    return value


def _finance_access(identity, project):
    # Operators unrelated to this project, and viewers, cannot read money.
    if identity['role'] == 'viewer':
        raise Unauthorized('financial information unavailable to viewer')
    _project_edit(identity, project)


def _expense(db, tenant, project, expense_id):
    _identifier(expense_id, 'expense id')
    row = db.execute('''SELECT * FROM delivery_finance_expenses
          WHERE tenant_id=? AND project_id=? AND id=?''', (tenant, project, expense_id)).fetchone()
    if row is None:
        raise Invalid('expense not found in project')
    return row


def _receivable(db, tenant, project, item_id):
    _identifier(item_id, 'receivable id')
    row = db.execute('''SELECT * FROM delivery_finance_receivables
          WHERE tenant_id=? AND project_id=? AND id=?''', (tenant, project, item_id)).fetchone()
    if row is None:
        raise Invalid('receivable not found in project')
    return row


def _evidence_document(db, tenant, project_id, document_id, expected_sha):
    _identifier(document_id, 'document id')
    if not isinstance(expected_sha, str) or len(expected_sha) != 64 or any(c not in '0123456789abcdef' for c in expected_sha):
        raise Invalid('valid document SHA-256 required')
    row = db.execute('''SELECT v.content,v.sha256,v.byte_count FROM delivery_documents d
         JOIN delivery_document_versions v ON v.tenant_id=d.tenant_id
             AND v.project_id=d.project_id AND v.document_id=d.id AND v.version=d.version
         WHERE d.tenant_id=? AND d.project_id=? AND d.id=?''',
         (tenant, project_id, document_id)).fetchone()
    if row is None or row['sha256'] != expected_sha or sha256(bytes(row['content'])).hexdigest() != expected_sha or len(row['content']) != row['byte_count']:
        raise Conflict('current project document evidence missing or modified')


def _summary(db, tenant, project_id, now):
    budget = db.execute('''SELECT budget_minor,currency,version,updated_at FROM delivery_finance_budgets
        WHERE tenant_id=? AND project_id=?''', (tenant,project_id)).fetchone()
    totals = db.execute('''SELECT
      COALESCE(SUM(CASE WHEN state='active' AND kind='incurred' THEN amount_minor ELSE 0 END),0) AS actual_minor,
      COALESCE(SUM(CASE WHEN state='active' AND kind='planned' THEN amount_minor ELSE 0 END),0) AS planned_minor,
      COALESCE(SUM(CASE WHEN state='active' THEN 1 ELSE 0 END),0) AS active_expenses
      FROM delivery_finance_expenses WHERE tenant_id=? AND project_id=?''',
      (tenant,project_id)).fetchone()
    income = db.execute('''SELECT
      COALESCE(SUM(CASE WHEN state!='cancelled' THEN amount_minor ELSE 0 END),0) AS expected_minor,
      COALESCE(SUM(CASE WHEN state='recorded' THEN amount_minor ELSE 0 END),0) AS manually_recorded_minor,
      COALESCE(SUM(CASE WHEN state='pending' THEN amount_minor ELSE 0 END),0) AS pending_minor,
      COALESCE(SUM(CASE WHEN state='pending' AND due_at IS NOT NULL AND due_at<? THEN 1 ELSE 0 END),0) AS overdue_count
      FROM delivery_finance_receivables WHERE tenant_id=? AND project_id=?''',
      (now,tenant,project_id)).fetchone()
    actual, planned = totals['actual_minor'], totals['planned_minor']
    forecast = actual + planned
    budget_minor = budget['budget_minor'] if budget else None
    variance = (forecast - budget_minor) if budget else None
    return {
        'project_id': project_id, 'currency': 'RUB', 'money_unit': 'kopecks',
        'budget_minor': budget_minor, 'budget_version': budget['version'] if budget else 0,
        'actual_cost_minor': actual, 'planned_cost_minor': planned,
        'forecast_cost_minor': forecast, 'forecast_over_budget_minor': max(variance,0) if budget else None,
        'forecast_variance_minor': variance,
        'budget_usage_basis_points': (actual * 10000 // budget_minor) if budget_minor else None,
        'expected_receivables_minor': income['expected_minor'],
        'manually_recorded_receivables_minor': income['manually_recorded_minor'],
        'pending_receivables_minor': income['pending_minor'],
        'overdue_receivables_count': income['overdue_count'],
        'estimated_margin_minor': (income['expected_minor'] - forecast),
        'manual_cash_delta_minor': income['manually_recorded_minor'] - actual,
        'risk': ('OVER_BUDGET' if budget is not None and forecast > budget_minor else
                 'RECEIVABLE_OVERDUE' if income['overdue_count'] else
                 'BUDGET_NOT_SET' if budget is None else 'ON_PLAN'),
        'source': 'LOCAL_SQLITE_ONLY', 'external_bank_verified': False,
        'real_payment_executed': False, 'production_authorized': False,
        'warning': 'Amounts and receipt statuses are manually recorded, not bank-confirmed.'
    }


class Director198(Director197):
    def initialize(self):
        super().initialize()
        with self.connect() as db:
            db.executescript('''
              CREATE TABLE IF NOT EXISTS delivery_finance_budgets (
                project_id TEXT PRIMARY KEY REFERENCES delivery_projects(id),
                tenant_id TEXT NOT NULL, budget_minor INTEGER NOT NULL
                   CHECK(budget_minor BETWEEN 0 AND 1000000000000),
                currency TEXT NOT NULL CHECK(currency='RUB'),
                version INTEGER NOT NULL CHECK(version>=1),
                updated_by TEXT NOT NULL, updated_at INTEGER NOT NULL);
              CREATE INDEX IF NOT EXISTS delivery_finance_budget_tenant
                ON delivery_finance_budgets(tenant_id,project_id);
              CREATE TABLE IF NOT EXISTS delivery_finance_expenses (
                id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL,
                project_id TEXT NOT NULL REFERENCES delivery_projects(id),
                title TEXT NOT NULL, category TEXT NOT NULL
                  CHECK(category IN ('materials','labor','software','services','other')),
                amount_minor INTEGER NOT NULL CHECK(amount_minor BETWEEN 1 AND 1000000000000),
                kind TEXT NOT NULL CHECK(kind IN ('planned','incurred')),
                state TEXT NOT NULL CHECK(state IN ('active','voided')),
                version INTEGER NOT NULL CHECK(version>=1),
                created_by TEXT NOT NULL, created_at INTEGER NOT NULL,
                updated_by TEXT NOT NULL, updated_at INTEGER NOT NULL,
                void_reason TEXT);
              CREATE INDEX IF NOT EXISTS delivery_finance_expenses_project
                ON delivery_finance_expenses(tenant_id,project_id,created_at,id);
              CREATE TABLE IF NOT EXISTS delivery_finance_receivables (
                id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL,
                project_id TEXT NOT NULL REFERENCES delivery_projects(id),
                stage_id TEXT REFERENCES delivery_stages(id),
                title TEXT NOT NULL, amount_minor INTEGER NOT NULL
                  CHECK(amount_minor BETWEEN 1 AND 1000000000000),
                due_at INTEGER, state TEXT NOT NULL
                  CHECK(state IN ('pending','recorded','cancelled')),
                version INTEGER NOT NULL CHECK(version>=1),
                created_by TEXT NOT NULL, created_at INTEGER NOT NULL,
                updated_by TEXT NOT NULL, updated_at INTEGER NOT NULL,
                evidence_document_id TEXT, evidence_sha256 TEXT,
                cancel_reason TEXT, resolved_at INTEGER);
              CREATE INDEX IF NOT EXISTS delivery_finance_receivables_project
                ON delivery_finance_receivables(tenant_id,project_id,state,due_at,id);
            ''')

    def execute(self, token, op, payload, idem_key=None):
        if op not in FINANCE_OPS:
            return super().execute(token, op, payload, idem_key)
        if not isinstance(payload, dict):
            raise Invalid('payload must be an object')
        writing = op in FINANCE_WRITES
        if writing and (not isinstance(idem_key, str) or not KEY_RE.fullmatch(idem_key)):
            raise Invalid('idempotency key required for financial write')
        with self.connect(transaction=True) as db:
            identity = self._identity(db, token)
            tenant, actor = identity['tenant_id'], identity['actor']
            if identity['role'] == 'viewer':
                raise Unauthorized('finance requires owner or project creator')
            if 'project_id' not in payload:
                raise Invalid('project_id required')
            project = _project(db, tenant, payload['project_id'])
            _finance_access(identity, project)
            if writing:
                _check_editable(identity, project)
                try:
                    request_sha = _secret_hash(canonical({'op': op, 'payload': payload}))
                except (ValueError, TypeError) as exc:
                    raise Invalid('non-JSON financial request') from exc
                replay = db.execute('''SELECT op,request_sha,response_json FROM requests
                    WHERE tenant_id=? AND idem_key=?''',(tenant,idem_key)).fetchone()
                if replay:
                    if replay['op'] != op or replay['request_sha'] != request_sha:
                        raise Conflict('idempotency key reused for a different financial operation')
                    return json.loads(replay['response_json'])
                # Verify existing project history before appending financial evidence.
                _project_history(db,tenant,project['id'])
            result = self._apply_finance(db,identity,project,op,payload)
            if writing:
                db.execute('INSERT INTO requests VALUES (?,?,?,?,?)',
                           (tenant,idem_key,op,request_sha,canonical(result)))
                db.execute('''INSERT INTO audit(tenant_id,actor,operation,request_sha,recorded_at)
                    VALUES (?,?,?,?,?)''',(tenant,actor,op,request_sha,self.clock()))
            return result

    def _apply_finance(self, db, identity, project, op, p):
        tenant, actor, pid = identity['tenant_id'],identity['actor'],project['id']
        now = self.clock()
        if op == 'commerce.finance.snapshot':
            _object(p,{'project_id'})
            budget = _summary(db,tenant,pid,now)
            expenses = [dict(x) for x in db.execute('''SELECT * FROM delivery_finance_expenses
                WHERE tenant_id=? AND project_id=? ORDER BY created_at DESC,id DESC LIMIT 200''',(tenant,pid))]
            receivables = [dict(x) for x in db.execute('''SELECT * FROM delivery_finance_receivables
                WHERE tenant_id=? AND project_id=? ORDER BY created_at DESC,id DESC LIMIT 200''',(tenant,pid))]
            return {'summary':budget,'expenses':expenses,'receivables':receivables,
                    'expenses_truncated':len(expenses)==200,'receivables_truncated':len(receivables)==200}
        if op == 'commerce.finance.history':
            _object(p,{'project_id'})
            history=_project_history(db,tenant,pid)
            history['events']=[x for x in history['events'] if x['kind'].startswith('finance_')]
            return history
        if op == 'commerce.finance.budget.set':
            _object(p,{'project_id','expected_version','budget_minor'})
            amount=_money(p['budget_minor'],zero=True)
            expected=p['expected_version']
            if type(expected) is not int or not 0 <= expected <= 1_000_000:
                raise Invalid('invalid budget expected version')
            current=db.execute('''SELECT version,budget_minor FROM delivery_finance_budgets
                WHERE tenant_id=? AND project_id=?''',(tenant,pid)).fetchone()
            if current and current['version']!=expected or not current and expected!=0:
                raise Conflict('stale budget version')
            if current and current['budget_minor']==amount:
                raise Conflict('budget unchanged')
            version=expected+1
            if current:
                db.execute('''UPDATE delivery_finance_budgets SET budget_minor=?,version=?,updated_by=?,updated_at=?
                    WHERE tenant_id=? AND project_id=?''',(amount,version,actor,now,tenant,pid))
            else:
                db.execute('''INSERT INTO delivery_finance_budgets VALUES (?,?,?,?,?,?,?)''',
                    (pid,tenant,amount,'RUB',version,actor,now))
            head=_record_project(db,tenant,pid,actor,'finance_budget_set',
                 {'budget_minor':amount,'version':version},now)
            return {'project_id':pid,'budget_minor':amount,'version':version,'event_head':head}
        if op == 'commerce.finance.expenses.add':
            _object(p,{'project_id','title','category','amount_minor','kind'})
            title=_text(p['title'],'expense title',180)
            category=p['category'];kind=p['kind']
            if not isinstance(category,str) or not isinstance(kind,str) or category not in EXPENSE_CATEGORIES or kind not in EXPENSE_TYPES:
                raise Invalid('invalid expense category or kind')
            amount=_money(p['amount_minor']);expense_id=_uid()
            db.execute('''INSERT INTO delivery_finance_expenses VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)''',
                (expense_id,tenant,pid,title,category,amount,kind,'active',1,actor,now,actor,now,None))
            head=_record_project(db,tenant,pid,actor,'finance_expense_added',
                {'expense_id':expense_id,'amount_minor':amount,'kind':kind,'category':category},now)
            return {'id':expense_id,'version':1,'kind':kind,'state':'active','event_head':head}
        if op in ('commerce.finance.expenses.commit','commerce.finance.expenses.void'):
            needed={'project_id','expense_id','expected_version'}
            optional={'reason'} if op.endswith('.void') else set()
            _object(p,needed,optional)
            item=_expense(db,tenant,pid,p['expense_id'])
            if item['version']!=_version(p['expected_version']):
                raise Conflict('stale expense version')
            if item['state']!='active':
                raise Conflict('expense already voided')
            if op.endswith('.commit'):
                if item['kind']!='planned':
                    raise Conflict('expense already incurred')
                db.execute('''UPDATE delivery_finance_expenses SET kind='incurred',version=version+1,
                    updated_by=?,updated_at=? WHERE id=? AND tenant_id=?''',(actor,now,item['id'],tenant))
                new_kind,new_state='incurred','active'
                payload={'expense_id':item['id'],'amount_minor':item['amount_minor']}
                event='finance_expense_incurred'
            else:
                reason=_text(p.get('reason'),'void reason',200)
                db.execute('''UPDATE delivery_finance_expenses SET state='voided',version=version+1,
                    void_reason=?,updated_by=?,updated_at=? WHERE id=? AND tenant_id=?''',
                    (reason,actor,now,item['id'],tenant))
                new_kind,new_state=item['kind'],'voided'
                payload={'expense_id':item['id'],'reason':reason}
                event='finance_expense_voided'
            head=_record_project(db,tenant,pid,actor,event,payload,now)
            return {'id':item['id'],'version':item['version']+1,
                    'kind':new_kind,'state':new_state,'event_head':head}
        if op == 'commerce.finance.receivables.add':
            _object(p,{'project_id','title','amount_minor'},{'due_at','stage_id'})
            title=_text(p['title'],'receivable title',180);amount=_money(p['amount_minor'])
            due=_due(p.get('due_at'),now)
            stage_id=p.get('stage_id')
            if stage_id is not None:
                _stage(db,tenant,stage_id,pid)
            item_id=_uid()
            db.execute('''INSERT INTO delivery_finance_receivables VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)''',
                 (item_id,tenant,pid,stage_id,title,amount,due,'pending',1,actor,now,actor,now,None,None,None,None))
            head=_record_project(db,tenant,pid,actor,'finance_receivable_added',
                {'id':item_id,'amount_minor':amount,'due_at':due,'stage_id':stage_id},now)
            return {'id':item_id,'state':'pending','version':1,'event_head':head}
        if op == 'commerce.finance.receivables.resolve':
            _object(p,{'project_id','receivable_id','expected_version','state'},
                    {'evidence_document_id','evidence_sha256','reason'})
            row=_receivable(db,tenant,pid,p['receivable_id'])
            if row['version']!=_version(p['expected_version']):
                raise Conflict('stale receivable version')
            if row['state']!='pending':
                raise Conflict('receivable already resolved')
            state=p['state']
            if state not in ('recorded','cancelled'):
                raise Invalid('invalid receivable transition')
            reason=None;document_id=None;proof_sha=None
            if state=='recorded':
                if 'reason' in p: raise Invalid('unexpected reason for receipt')
                document_id=p.get('evidence_document_id');proof_sha=p.get('evidence_sha256')
                _evidence_document(db,tenant,pid,document_id,proof_sha)
            else:
                if 'evidence_document_id' in p or 'evidence_sha256' in p:
                    raise Invalid('unexpected document proof for cancellation')
                reason=_text(p.get('reason'),'cancellation reason',200)
            db.execute('''UPDATE delivery_finance_receivables SET state=?,version=version+1,
                updated_by=?,updated_at=?,evidence_document_id=?,evidence_sha256=?,
                cancel_reason=?,resolved_at=? WHERE id=? AND tenant_id=?''',
                (state,actor,now,document_id,proof_sha,reason,now,row['id'],tenant))
            head=_record_project(db,tenant,pid,actor,'finance_receivable_'+state,
                {'id':row['id'],'amount_minor':row['amount_minor'],
                 'evidence_sha256':proof_sha,'reason':reason},now)
            return {'id':row['id'],'state':state,'version':row['version']+1,
                    'external_bank_verified':False,'event_head':head}
        raise Invalid('unknown M198 operation')

    def _apply_197(self, db, identity, op, payload):
        result=super()._apply_197(db,identity,op,payload)
        if op=='commerce.projects.card' and not result.get('details_redacted'):
            result['finance_summary']=_summary(db,identity['tenant_id'],payload['project_id'],self.clock())
        return result
