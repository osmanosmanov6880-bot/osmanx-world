"""M203 finance response execution: plans, tasks, model comparisons and review.

Append-only auditable local SQLite, same bearer/tenant isolation as M192-M202.
Explicit local mutations only, no external finance or notification effects.
"""
from __future__ import annotations
import json

from osgard_m192.runtime import (
    KEY_RE, Invalid, Unauthorized, Conflict, canonical, _secret_hash,
    _object, _identifier,
)
from .plans import (
    find_plan, create_plan, add_step, start_plan, cancel_plan,
    list_plans, expose_plan, mine, verified_events
)
from .outcomes import evaluate, review
from .reporting import management_report, export_report
from osgard_m202.runtime import Director202

PREFIX="commerce.actions."
OP_CREATE=PREFIX+"create"
OP_ADD_STEP=PREFIX+"step.add"
OP_START=PREFIX+"start"
OP_CANCEL=PREFIX+"cancel"
OP_EVALUATE=PREFIX+"evaluate"
OP_REVIEW=PREFIX+"review"
OP_LIST=PREFIX+"list"
OP_GET=PREFIX+"get"
OP_HISTORY=PREFIX+"history"
OP_MINE=PREFIX+"mine"
OP_REPORT=PREFIX+"report"
OP_CSV=PREFIX+"report.csv"

OPERATIONS=frozenset((
    OP_CREATE,OP_ADD_STEP,OP_START,OP_CANCEL,OP_EVALUATE,OP_REVIEW,
    OP_LIST,OP_GET,OP_HISTORY,OP_MINE,OP_REPORT,OP_CSV
))
WRITES=frozenset((
    OP_CREATE,OP_ADD_STEP,OP_START,OP_CANCEL,OP_EVALUATE,OP_REVIEW
))


class Director203(Director202):
    def initialize(self):
        super().initialize()
        with self.connect() as db:
            db.executescript("""
              CREATE TABLE IF NOT EXISTS financial_action_plans(
                id TEXT PRIMARY KEY,tenant_id TEXT NOT NULL,
                alert_id TEXT NOT NULL,rule TEXT NOT NULL,
                title TEXT NOT NULL,hypothesis TEXT NOT NULL,
                target_value INTEGER NOT NULL,
                direction TEXT NOT NULL CHECK(direction IN('increase','decrease')),
                baseline_snapshot_id TEXT NOT NULL,baseline_value INTEGER NOT NULL,
                policy_version INTEGER NOT NULL,due_at INTEGER NOT NULL,
                status TEXT NOT NULL CHECK(status IN(
                   'draft','active','model_reviewed','cancelled')),
                version INTEGER NOT NULL CHECK(version>=1),
                latest_evaluation_id TEXT,
                created_by TEXT NOT NULL,created_at INTEGER NOT NULL,
                started_at INTEGER,updated_at INTEGER NOT NULL,
                reviewed_at INTEGER,cancelled_at INTEGER
              );
              CREATE UNIQUE INDEX IF NOT EXISTS action_one_open_per_alert
                ON financial_action_plans(tenant_id,alert_id)
                WHERE status IN ('draft','active');
              CREATE INDEX IF NOT EXISTS action_plans_tenant
                ON financial_action_plans(tenant_id,created_at,id);
              CREATE TABLE IF NOT EXISTS financial_action_steps(
                id TEXT PRIMARY KEY,tenant_id TEXT NOT NULL,
                plan_id TEXT NOT NULL,work_id TEXT NOT NULL UNIQUE,
                created_by TEXT NOT NULL,created_at INTEGER NOT NULL,
                UNIQUE(tenant_id,plan_id,work_id)
              );
              CREATE INDEX IF NOT EXISTS action_steps_tenant
                ON financial_action_steps(tenant_id,plan_id,id);
              CREATE TABLE IF NOT EXISTS financial_action_events(
                seq INTEGER PRIMARY KEY AUTOINCREMENT,
                tenant_id TEXT NOT NULL,plan_id TEXT NOT NULL,
                actor TEXT NOT NULL,action TEXT NOT NULL,
                details_json TEXT NOT NULL,at INTEGER NOT NULL,
                previous_hash TEXT NOT NULL,event_hash TEXT NOT NULL
              );
              CREATE INDEX IF NOT EXISTS action_events_plan
                ON financial_action_events(tenant_id,plan_id,seq);
              CREATE TRIGGER IF NOT EXISTS immutable_action_events_update
                BEFORE UPDATE ON financial_action_events
                BEGIN SELECT RAISE(ABORT,'action events immutable'); END;
              CREATE TRIGGER IF NOT EXISTS immutable_action_events_delete
                BEFORE DELETE ON financial_action_events
                BEGIN SELECT RAISE(ABORT,'action events immutable'); END;
              CREATE TABLE IF NOT EXISTS financial_action_evaluations(
                id TEXT PRIMARY KEY,tenant_id TEXT NOT NULL,
                plan_id TEXT NOT NULL,snapshot_id TEXT NOT NULL,
                snapshot_hash TEXT NOT NULL,policy_version INTEGER NOT NULL,
                baseline_value INTEGER NOT NULL,observed_value INTEGER NOT NULL,
                improvement_value INTEGER NOT NULL,
                target_met INTEGER NOT NULL CHECK(target_met IN(0,1)),
                finished_tasks INTEGER NOT NULL,total_tasks INTEGER NOT NULL,
                judgement TEXT NOT NULL CHECK(judgement IN(
                  'MODEL_TARGET_REACHED_REVIEW_REQUIRED',
                  'TARGET_NOT_REACHED','TASKS_NOT_FINISHED')),
                created_by TEXT NOT NULL,created_at INTEGER NOT NULL,
                UNIQUE(tenant_id,plan_id,snapshot_id)
              );
              CREATE INDEX IF NOT EXISTS action_evaluations_plan
                ON financial_action_evaluations(tenant_id,plan_id,created_at);
              CREATE TRIGGER IF NOT EXISTS immutable_action_evaluations_update
                BEFORE UPDATE ON financial_action_evaluations
                BEGIN SELECT RAISE(ABORT,'action evaluations immutable'); END;
              CREATE TRIGGER IF NOT EXISTS immutable_action_evaluations_delete
                BEFORE DELETE ON financial_action_evaluations
                BEGIN SELECT RAISE(ABORT,'action evaluations immutable'); END;
              CREATE TABLE IF NOT EXISTS financial_action_reviews(
                id TEXT PRIMARY KEY,tenant_id TEXT NOT NULL,
                plan_id TEXT NOT NULL,evaluation_id TEXT NOT NULL UNIQUE,
                approved INTEGER NOT NULL CHECK(approved IN(0,1)),
                reason TEXT NOT NULL,reviewed_by TEXT NOT NULL,
                created_at INTEGER NOT NULL
              );
              CREATE TRIGGER IF NOT EXISTS immutable_action_reviews_update
                BEFORE UPDATE ON financial_action_reviews
                BEGIN SELECT RAISE(ABORT,'action reviews immutable'); END;
              CREATE TRIGGER IF NOT EXISTS immutable_action_reviews_delete
                BEFORE DELETE ON financial_action_reviews
                BEGIN SELECT RAISE(ABORT,'action reviews immutable'); END;
            """)

    def execute(self,token,op,payload,idem_key=None):
        if op not in OPERATIONS:
            return super().execute(token,op,payload,idem_key)
        if type(payload) is not dict:
            raise Invalid("M203 payload must be a JSON object")
        writing=op in WRITES
        if writing:
            if not isinstance(idem_key,str) or not KEY_RE.fullmatch(idem_key):
                raise Invalid("action changes require an idempotency key")
        elif idem_key is not None:
            raise Invalid("read-only action endpoint rejects idempotency keys")
        with self.connect(transaction=True) as db:
            identity=self._identity(db,token)
            tenant,actor=identity["tenant_id"],identity["actor"]
            role=identity["role"]
            if role=="viewer" or (role!="owner" and op!=OP_MINE):
                raise Unauthorized("only owner can access action plans and financial results")
            if writing:
                try:
                    digest=_secret_hash(canonical({"op":op,"payload":payload}))
                except (TypeError,ValueError,OverflowError) as exc:
                    raise Invalid("invalid JSON action request") from exc
                reused=db.execute(
                    """SELECT op,request_sha,response_json FROM requests
                       WHERE tenant_id=? AND idem_key=?""",
                    (tenant,idem_key)
                ).fetchone()
                if reused:
                    if reused["op"]!=op or reused["request_sha"]!=digest:
                        raise Conflict("idempotency key reused with different request")
                    return json.loads(reused["response_json"])
            outcome=self._apply_203(db,identity,op,payload)
            if writing:
                db.execute(
                    "INSERT INTO requests VALUES (?,?,?,?,?)",
                    (tenant,idem_key,op,digest,canonical(outcome))
                )
                db.execute(
                    """INSERT INTO audit(tenant_id,actor,operation,request_sha,recorded_at)
                       VALUES (?,?,?,?,?)""",
                    (tenant,actor,op,digest,self.clock())
                )
            return outcome

    def _apply_203(self,db,identity,op,p):
        now=self.clock()
        tenant=identity["tenant_id"]
        if op==OP_CREATE:
            return create_plan(db,identity,p,now)
        if op==OP_ADD_STEP:
            return add_step(db,identity,p,now)
        if op==OP_START:
            return start_plan(db,identity,p,now)
        if op==OP_CANCEL:
            return cancel_plan(db,identity,p,now)
        if op==OP_EVALUATE:
            return evaluate(db,identity,p,now)
        if op==OP_REVIEW:
            return review(db,identity,p,now)
        if op==OP_LIST:
            return list_plans(db,tenant,p)
        if op==OP_GET:
            _object(p,{"plan_id"})
            row=find_plan(db,tenant,p["plan_id"])
            return {"item":expose_plan(db,tenant,row)}
        if op==OP_HISTORY:
            _object(p,{"plan_id"})
            return verified_events(db,tenant,p["plan_id"])
        if op==OP_MINE:
            return mine(db,identity,p)
        if op==OP_REPORT:
            _object(p,set())
            return management_report(db,identity,now)
        if op==OP_CSV:
            _object(p,set())
            return export_report(db,identity,now)
        raise Invalid("unknown action operation")
