"""Wave 29: manually executed risk mitigation with verified local evidence.

Step checks and evidence are factual local SQLite records, not independent
customer verification or proof that the business risk was eliminated. Only
an owner may mark a case 'verified against local data'. No network/background
operations, task assignment mutation, auto-notifications or AI inference.
"""
from __future__ import annotations

import csv
from datetime import datetime, timezone
from hashlib import sha256
import io
import json
import time
import uuid
from typing import TYPE_CHECKING, Any

from .contracts import canonical, digest
from .resource_forecast import _project_forecast_db
from .scenario_actions import RiskActionDenied, _stored, _live, MAX_ACTIONS
from .scenario_checkpoints import _application, _snapshot_chain
from .scenario_library import _uuid, _snapshot
from .scenario_monitor_export import _safe
from .team_tasks import _principal, _eligible, _due, _text, _read

if TYPE_CHECKING:
    from .app_runtime import LocalAppRuntime

STEP_SCHEMA = "osgard.original180.risk-execution-step/1"
STEP_EVENT = "osgard.original180.risk-execution-step-event/1"
EVIDENCE_SCHEMA = "osgard.original180.risk-execution-evidence/1"
REVIEW_SCHEMA = "osgard.original180.risk-execution-review/1"
MAX_STEPS = 12
MAX_STEP_REVISIONS = 20
MAX_EVIDENCE = 30
MAX_REVIEWS = 20
STEP_STATES = frozenset(("todo", "doing", "done"))
STEP_TRANSITIONS = {
    "todo": frozenset(("doing", "done")),
    "doing": frozenset(("todo", "done")),
    "done": frozenset(("todo",)),
}
REVIEW_DECISIONS = frozenset(("verified", "needs_work"))


class ExecutionDenied(RiskActionDenied):
    pass


def init_execution(runtime: "LocalAppRuntime") -> None:
    with runtime.drafts._db() as db:
        db.executescript("""
        CREATE TABLE IF NOT EXISTS director_action_steps(
          tenant TEXT NOT NULL,project_id TEXT NOT NULL,
          scenario_id TEXT NOT NULL,action_id TEXT NOT NULL,
          step_id TEXT NOT NULL,position INTEGER NOT NULL CHECK(position BETWEEN 1 AND 12),
          version INTEGER NOT NULL CHECK(version BETWEEN 1 AND 20),
          payload_json TEXT NOT NULL,payload_sha256 TEXT NOT NULL,
          PRIMARY KEY(tenant,project_id,scenario_id,action_id,step_id),
          UNIQUE(tenant,project_id,scenario_id,action_id,position)
        );
        CREATE INDEX IF NOT EXISTS director_action_steps_order
          ON director_action_steps(tenant,project_id,scenario_id,action_id,position);
        CREATE TABLE IF NOT EXISTS director_action_step_events(
          tenant TEXT NOT NULL,project_id TEXT NOT NULL,
          scenario_id TEXT NOT NULL,action_id TEXT NOT NULL,
          step_id TEXT NOT NULL,seq INTEGER NOT NULL CHECK(seq BETWEEN 1 AND 20),
          prev_sha256 TEXT,event_json TEXT NOT NULL,event_sha256 TEXT NOT NULL,
          PRIMARY KEY(tenant,project_id,scenario_id,action_id,step_id,seq)
        );
        CREATE TRIGGER IF NOT EXISTS director_step_event_update_denied
          BEFORE UPDATE ON director_action_step_events BEGIN
            SELECT RAISE(ABORT,'risk step event immutable');END;
        CREATE TRIGGER IF NOT EXISTS director_step_event_delete_denied
          BEFORE DELETE ON director_action_step_events BEGIN
            SELECT RAISE(ABORT,'risk step event immutable');END;
        CREATE TABLE IF NOT EXISTS director_action_evidence(
          tenant TEXT NOT NULL,project_id TEXT NOT NULL,
          scenario_id TEXT NOT NULL,action_id TEXT NOT NULL,
          seq INTEGER NOT NULL CHECK(seq BETWEEN 1 AND 30),
          prev_sha256 TEXT,payload_json TEXT NOT NULL,payload_sha256 TEXT NOT NULL,
          PRIMARY KEY(tenant,project_id,scenario_id,action_id,seq)
        );
        CREATE TRIGGER IF NOT EXISTS director_action_evidence_update_denied
          BEFORE UPDATE ON director_action_evidence BEGIN
            SELECT RAISE(ABORT,'risk evidence immutable');END;
        CREATE TRIGGER IF NOT EXISTS director_action_evidence_delete_denied
          BEFORE DELETE ON director_action_evidence BEGIN
            SELECT RAISE(ABORT,'risk evidence immutable');END;
        CREATE TABLE IF NOT EXISTS director_action_reviews(
          tenant TEXT NOT NULL,project_id TEXT NOT NULL,
          scenario_id TEXT NOT NULL,action_id TEXT NOT NULL,
          seq INTEGER NOT NULL CHECK(seq BETWEEN 1 AND 20),
          prev_sha256 TEXT,payload_json TEXT NOT NULL,payload_sha256 TEXT NOT NULL,
          PRIMARY KEY(tenant,project_id,scenario_id,action_id,seq)
        );
        CREATE TRIGGER IF NOT EXISTS director_action_review_update_denied
          BEFORE UPDATE ON director_action_reviews BEGIN
            SELECT RAISE(ABORT,'risk review immutable');END;
        CREATE TRIGGER IF NOT EXISTS director_action_review_delete_denied
          BEFORE DELETE ON director_action_reviews BEGIN
            SELECT RAISE(ABORT,'risk review immutable');END;
        """)


def _scope(runtime, db, tenant, project_id, actor, scenario_id, action_id,
           *, write=False, owner=False):
    _uuid(scenario_id); _uuid(action_id)
    _principal(runtime, db, tenant, project_id, actor,
               "members.manage" if owner else "task.manage")
    _scenario, _application_receipt, rollback = _application(
        db, tenant, project_id, scenario_id)
    action, _journal = _stored(db, tenant, project_id, scenario_id, action_id)
    if write and rollback is not None:
        raise ExecutionDenied("Rolled back plans have read-only execution history")
    return action, rollback is not None


def _text_clean(value, field, bound, *, empty=False):
    return _text(value, field, bound, empty=empty)


def _now():
    return int(time.time())


def _step_events(db, scope, step_id):
    rows = db.execute(
        """SELECT * FROM director_action_step_events WHERE tenant=? AND project_id=?
           AND scenario_id=? AND action_id=? AND step_id=?
           ORDER BY seq ASC LIMIT ?""",
        (*scope, step_id, MAX_STEP_REVISIONS + 1)).fetchall()
    if len(rows) > MAX_STEP_REVISIONS:
        raise ExecutionDenied("Risk step journal exceeded bounds")
    events = []
    prev_sha = None
    prev_state = None
    for seq, row in enumerate(rows, 1):
        try:
            event = json.loads(row["event_json"])
        except (TypeError, ValueError) as exc:
            raise ExecutionDenied("Risk step journal not parseable") from exc
        if (type(event) is not dict or
            any(event.get(key) != value for key, value in zip(
                ("tenant","project_id","scenario_id","action_id","step_id"),
                (*scope,step_id))) or
            event.get("schema") != STEP_EVENT or event.get("seq") != seq or
            row["seq"] != seq or event.get("prev_sha256") != prev_sha or
            row["prev_sha256"] != prev_sha or
            event.get("before_sha256") != (digest(prev_state) if prev_state else None) or
            type(event.get("state")) is not dict or
            event["state"].get("version") != seq or
            event.get("after_sha256") != digest(event["state"]) or
            canonical(event).decode("utf-8") != row["event_json"] or
            digest(event) != row["event_sha256"]):
            raise ExecutionDenied("Risk step journal integrity failed")
        prev_state = event["state"]
        prev_sha = row["event_sha256"]
        events.append({**event, "sha256": prev_sha})
    return events


def _get_step(db, scope, step_id):
    _uuid(step_id)
    row = db.execute(
        """SELECT * FROM director_action_steps
           WHERE tenant=? AND project_id=? AND scenario_id=? AND action_id=?
             AND step_id=?""",(*scope,step_id)).fetchone()
    if row is None:
        raise ExecutionDenied("Step not found")
    try:
        step=json.loads(row["payload_json"])
    except (TypeError,ValueError) as exc:
        raise ExecutionDenied("Risk step state unreadable") from exc
    if (type(step) is not dict or step.get("schema") != STEP_SCHEMA or
        any(step.get(key) != value for key, value in zip(
            ("tenant","project_id","scenario_id","action_id","step_id"),
            (*scope,step_id))) or
        step.get("position") != row["position"] or
        step.get("version") != row["version"] or
        step.get("status") not in STEP_STATES or
        canonical(step).decode("utf-8") != row["payload_json"] or
        digest(step) != row["payload_sha256"]):
        raise ExecutionDenied("Stored risk step integrity failed")
    events=_step_events(db,scope,step_id)
    if len(events) != row["version"] or not events or events[-1]["state"] != step:
        raise ExecutionDenied("Risk step differs from history")
    return step,events


def _steps(db, scope):
    rows=db.execute(
        """SELECT step_id FROM director_action_steps
           WHERE tenant=? AND project_id=? AND scenario_id=? AND action_id=?
           ORDER BY position ASC LIMIT ?""",
        (*scope,MAX_STEPS+1)).fetchall()
    if len(rows)>MAX_STEPS:
        raise ExecutionDenied("Too many risk mitigation steps")
    steps=[]
    for i,row in enumerate(rows,1):
        step,events=_get_step(db,scope,row["step_id"])
        if step["position"] != i:
            raise ExecutionDenied("Missing risk mitigation step")
        steps.append({**step,"sha256":digest(step),
                      "last_event_sha256":events[-1]["sha256"]})
    return steps


def _insert_step_event(db,step,actor,previous,previous_events):
    scope=tuple(step[k] for k in ("tenant","project_id","scenario_id","action_id"))
    entry={
        "schema":STEP_EVENT,**{k:step[k] for k in (
            "tenant","project_id","scenario_id","action_id","step_id")},
        "seq":step["version"],"prev_sha256":(
            previous_events[-1]["sha256"] if previous_events else None),
        "actor":actor,"at_epoch":step["updated_epoch"],
        "before_sha256":digest(previous) if previous else None,
        "after_sha256":digest(step),"state":step,
    }
    value=digest(entry)
    db.execute(
        """INSERT INTO director_action_step_events(
           tenant,project_id,scenario_id,action_id,step_id,seq,
           prev_sha256,event_json,event_sha256) VALUES(?,?,?,?,?,?,?,?,?)""",
        (*scope,step["step_id"],step["version"],entry["prev_sha256"],
         canonical(entry).decode("utf-8"),value))
    return value


def create_step(runtime:"LocalAppRuntime",*,tenant:str,project_id:str,
                actor:str,scenario_id:str,action_id:str,title:str,
                assignee:str|None,due_date:str|None,
                idempotency_key:str)->dict:
    title=_text_clean(title,"mitigation step",160)
    due_date=_due(due_date)
    runtime.records._key(idempotency_key)
    request=digest({"op":"risk.step.create","tenant":tenant,"project_id":project_id,
                    "actor":actor,"scenario_id":scenario_id,"action_id":action_id,
                    "title":title,"assignee":assignee,"due_date":due_date})
    with runtime.drafts._tx() as db:
        action,rolled=_scope(runtime,db,tenant,project_id,actor,
                             scenario_id,action_id,write=True)
        existing=runtime.records._seen(db,tenant,project_id,idempotency_key,request)
        if existing is not None:return existing
        if action["status"]=="resolved":
            raise ExecutionDenied("Reopen decision card before adding steps")
        _eligible(db,tenant,project_id,assignee)
        scope=(tenant,project_id,scenario_id,action_id)
        steps=_steps(db,scope)
        if len(steps)>=MAX_STEPS:
            raise ExecutionDenied("Maximum 12 mitigation steps")
        now=_now()
        step={"schema":STEP_SCHEMA,"tenant":tenant,"project_id":project_id,
              "scenario_id":scenario_id,"action_id":action_id,
              "step_id":str(uuid.uuid4()),"position":len(steps)+1,
              "title":title,"assignee":assignee,"due_date":due_date,
              "status":"todo","note":"","version":1,
              "created_by":actor,"created_epoch":now,
              "updated_by":actor,"updated_epoch":now}
        db.execute(
            """INSERT INTO director_action_steps(
               tenant,project_id,scenario_id,action_id,step_id,position,
               version,payload_json,payload_sha256) VALUES(?,?,?,?,?,?,?,?,?)""",
            (*scope,step["step_id"],step["position"],1,
             canonical(step).decode("utf-8"),digest(step)))
        proof=_insert_step_event(db,step,actor,None,[])
        output={"step":{**step,"sha256":digest(step),
                         "last_event_sha256":proof},
                "persisted_locally":True,"production_published":False}
        runtime.records._remember(db,tenant,project_id,idempotency_key,
                                  request,output)
        return output


def revise_step(runtime:"LocalAppRuntime",*,tenant:str,project_id:str,
                actor:str,scenario_id:str,action_id:str,step_id:str,
                expected_version:int,changes:dict,
                idempotency_key:str)->dict:
    if (type(expected_version) is not int or not 1<=expected_version<MAX_STEP_REVISIONS
        or type(changes) is not dict or not changes or
        not set(changes)<=set(("title","status","assignee","due_date","note"))):
        raise ExecutionDenied("Invalid step change or expected revision")
    clean={}
    for key,value in changes.items():
        if key=="title":clean[key]=_text_clean(value,"step title",160)
        elif key=="status":
            if type(value) is not str or value not in STEP_STATES:
                raise ExecutionDenied("Invalid step status")
            clean[key]=value
        elif key=="assignee":
            if value is not None and type(value) is not str:
                raise ExecutionDenied("Invalid step owner")
            clean[key]=value
        elif key=="due_date":clean[key]=_due(value)
        elif key=="note":clean[key]=_text_clean(value,"step note",300,empty=True)
    runtime.records._key(idempotency_key)
    request=digest({"op":"risk.step.update","tenant":tenant,"project_id":project_id,
                    "actor":actor,"scenario_id":scenario_id,"action_id":action_id,
                    "step_id":step_id,"expected_version":expected_version,
                    "changes":clean})
    with runtime.drafts._tx() as db:
        action,_=_scope(runtime,db,tenant,project_id,actor,scenario_id,action_id,write=True)
        replay=runtime.records._seen(db,tenant,project_id,idempotency_key,request)
        if replay is not None:return replay
        if action["status"]=="resolved":
            raise ExecutionDenied("Reopen decision card before editing steps")
        scope=(tenant,project_id,scenario_id,action_id)
        previous,events=_get_step(db,scope,step_id)
        if previous["version"]!=expected_version:
            raise ExecutionDenied("Step has changed; refresh")
        if "assignee" in clean:_eligible(db,tenant,project_id,clean["assignee"])
        new_status=clean.get("status",previous["status"])
        if new_status!=previous["status"] and new_status not in STEP_TRANSITIONS[previous["status"]]:
            raise ExecutionDenied("Invalid mitigation step state transition")
        if new_status=="done" and not clean.get("note",previous["note"]).strip():
            raise ExecutionDenied("Step completion requires an explicit note")
        if all(previous[k]==value for k,value in clean.items()):
            raise ExecutionDenied("No actual step changes")
        updated={**previous,**clean,"version":expected_version+1,
                 "updated_by":actor,"updated_epoch":_now()}
        changed=db.execute(
            """UPDATE director_action_steps SET version=?,payload_json=?,payload_sha256=?
               WHERE tenant=? AND project_id=? AND scenario_id=? AND action_id=?
                 AND step_id=? AND version=? AND payload_sha256=?""",
            (updated["version"],canonical(updated).decode("utf-8"),digest(updated),
             *scope,step_id,expected_version,digest(previous))).rowcount
        if changed!=1:raise ExecutionDenied("Concurrent step version conflict")
        proof=_insert_step_event(db,updated,actor,previous,events)
        output={"step":{**updated,"sha256":digest(updated),
                        "last_event_sha256":proof},
                "persisted_locally":True,"production_published":False}
        runtime.records._remember(db,tenant,project_id,idempotency_key,
                                  request,output)
        return output


def _ledger(db,table,schema,scope,maximum):
    rows=db.execute(
        f"""SELECT * FROM {table} WHERE tenant=? AND project_id=?
            AND scenario_id=? AND action_id=? ORDER BY seq ASC LIMIT ?""",
        (*scope,maximum+1)).fetchall()
    if len(rows)>maximum:
        raise ExecutionDenied("Execution history exceeds limit")
    out=[];prev=None
    for expected,row in enumerate(rows,1):
        try:p=json.loads(row["payload_json"])
        except (TypeError,ValueError) as exc:
            raise ExecutionDenied("Execution history unreadable") from exc
        if (type(p) is not dict or p.get("schema")!=schema or
            p.get("seq")!=expected or row["seq"]!=expected or
            p.get("prev_sha256")!=prev or row["prev_sha256"]!=prev or
            any(p.get(key)!=value for key,value in zip(
                ("tenant","project_id","scenario_id","action_id"),scope)) or
            canonical(p).decode("utf-8")!=row["payload_json"] or
            digest(p)!=row["payload_sha256"]):
            raise ExecutionDenied("Execution SHA-256 chain failed")
        prev=row["payload_sha256"]
        out.append({**p,"sha256":prev})
    return out


def _evidence(db,scope):return _ledger(
    db,"director_action_evidence",EVIDENCE_SCHEMA,scope,MAX_EVIDENCE)


def _reviews(db,scope):return _ledger(
    db,"director_action_reviews",REVIEW_SCHEMA,scope,MAX_REVIEWS)


def _append_ledger(db,table,record,scope):
    # The table is selected exclusively from module constants by callers.
    sha=digest(record)
    db.execute(
        f"""INSERT INTO {table}(
           tenant,project_id,scenario_id,action_id,seq,prev_sha256,
           payload_json,payload_sha256) VALUES(?,?,?,?,?,?,?,?)""",
        (*scope,record["seq"],record["prev_sha256"],
         canonical(record).decode("utf-8"),sha))
    return sha


def capture_evidence(runtime:"LocalAppRuntime",*,tenant:str,project_id:str,
                     actor:str,scenario_id:str,action_id:str,kind:str,
                     expected_snapshot:str,note:str,checkpoint_sha256:str|None,
                     idempotency_key:str)->dict:
    if kind not in ("task","checkpoint") or type(kind) is not str:
        raise ExecutionDenied("Evidence type must be task or checkpoint")
    expected_snapshot=_snapshot(expected_snapshot)
    note=_text_clean(note,"evidence description",400)
    if kind=="checkpoint":_snapshot(checkpoint_sha256)
    elif checkpoint_sha256 is not None:
        raise ExecutionDenied("Task evidence cannot supply checkpoint hash")
    runtime.records._key(idempotency_key)
    request=digest({"op":"risk.evidence","tenant":tenant,"project_id":project_id,
                    "actor":actor,"scenario_id":scenario_id,"action_id":action_id,
                    "kind":kind,"snapshot":expected_snapshot,
                    "note":note,"checkpoint_sha256":checkpoint_sha256})
    with runtime.drafts._tx() as db:
        action,_=_scope(runtime,db,tenant,project_id,actor,scenario_id,action_id,write=True)
        repeated=runtime.records._seen(db,tenant,project_id,idempotency_key,request)
        if repeated is not None:return repeated
        snapshot,risks,rolled=_live(runtime,db,tenant,project_id,actor,scenario_id)
        if rolled or snapshot!=expected_snapshot:
            raise ExecutionDenied("Source snapshot changed; refresh evidence")
        scope=(tenant,project_id,scenario_id,action_id)
        evidence=_evidence(db,scope)
        if len(evidence)>=MAX_EVIDENCE:
            raise ExecutionDenied("Evidence log limit reached")
        if kind=="task":
            if action["task_id"] is None:
                raise ExecutionDenied("Global risk cannot capture a task")
            task=_read(db,tenant,project_id,action["task_id"])
            source={"task_id":task["task_id"],"title":task["title"],
                    "status":task["status"],"assignee":task["assignee"],
                    "version":task["version"],"due_date":task["due_date"],
                    "updated_epoch":task["updated_epoch"],
                    "task_sha256":digest(task)}
        else:
            chain=_snapshot_chain(db,tenant,project_id,scenario_id)
            matches=[p for p in chain if p["sha256"]==checkpoint_sha256]
            if len(matches)!=1:
                raise ExecutionDenied("Checkpoint SHA is not in verified scenario history")
            p=matches[0]
            source={"checkpoint_sha256":p["sha256"],"sequence":p["sequence"],
                    "observed_on_utc":p["observed_on_utc"],
                    "task_count":len(p["task_observations"])}
        now=_now()
        record={"schema":EVIDENCE_SCHEMA,"tenant":tenant,"project_id":project_id,
                "scenario_id":scenario_id,"action_id":action_id,
                "seq":len(evidence)+1,"prev_sha256":(
                    evidence[-1]["sha256"] if evidence else None),
                "evidence_id":str(uuid.uuid4()),"kind":kind,
                "actor":actor,"created_epoch":now,
                "source_snapshot":snapshot,"source":source,
                "note":note,"action_version":action["version"],
                "source_verified_locally":True}
        proof=_append_ledger(db,"director_action_evidence",record,scope)
        result={"evidence":{**record,"sha256":proof},
                "persisted_locally":True,"production_published":False}
        runtime.records._remember(db,tenant,project_id,idempotency_key,request,result)
        return result


def _proof_status(action,steps,evidence,reviews,snapshot,risks,rolled):
    risk_active=(action["risk_code"],action["task_id"]) in {
        (r["code"],r["task_id"]) for r in risks}
    ready=(not rolled and action["status"]=="resolved" and bool(steps)
           and all(s["status"]=="done" for s in steps) and bool(evidence)
           and evidence[-1]["source_snapshot"]==snapshot
           and evidence[-1]["created_epoch"]>=max(
               s["updated_epoch"] for s in steps)
           and not risk_active)
    last=reviews[-1] if reviews else None
    review_current=bool(last and last["decision"]=="verified" and ready
                        and last["action_sha256"]==digest(action)
                        and last["evidence_sha256"]==evidence[-1]["sha256"]
                        and last["step_digests"]==[s["sha256"] for s in steps]
                        and last["source_snapshot"]==snapshot)
    return {
        "ready_for_local_verification":ready,
        "review_verified_on_current_data":review_current,
        "risk_still_observed":risk_active,
        "all_steps_done":bool(steps) and all(s["status"]=="done" for s in steps),
        "evidence_current":bool(evidence) and evidence[-1]["source_snapshot"]==snapshot,
        "last_review":{k:last[k] for k in (
            "seq","decision","actor","created_epoch","note","sha256")
        } if last else None,
        "independent_external_verification":False,
    }


def workbook(runtime:"LocalAppRuntime",*,tenant:str,project_id:str,actor:str,
             scenario_id:str,action_id:str)->dict:
    with runtime.drafts._db() as db:
        db.execute("BEGIN")
        action,rolled=_scope(runtime,db,tenant,project_id,actor,scenario_id,action_id)
        scope=(tenant,project_id,scenario_id,action_id)
        steps=_steps(db,scope)
        evidence=_evidence(db,scope)
        reviews=_reviews(db,scope)
        snapshot,risks,_=_live(runtime,db,tenant,project_id,actor,scenario_id)
        status=_proof_status(action,steps,evidence,reviews,snapshot,risks,rolled)
        return {
            "scenario_id":scenario_id,"action_id":action_id,
            "action_version":action["version"],"action_status":action["status"],
            "action_sha256":digest(action),"steps":steps,
            "evidence":list(reversed(evidence)),
            "reviews":list(reversed(reviews)),
            "last_evidence_sha256":evidence[-1]["sha256"] if evidence else None,
            "last_review_sha256":reviews[-1]["sha256"] if reviews else None,
            "source_snapshot":snapshot,"rolled_back":rolled,
            "verification":status,"chains_verified":True,
            "local_only":True,"production_published":False,
        }


def review_execution(runtime:"LocalAppRuntime",*,tenant:str,project_id:str,
                     actor:str,scenario_id:str,action_id:str,
                     expected_action_version:int,expected_snapshot:str,
                     expected_evidence_sha256:str|None,
                     expected_review_sha256:str|None,
                     decision:str,note:str,idempotency_key:str)->dict:
    if (type(expected_action_version) is not int
        or not 1<=expected_action_version<=40
        or type(decision) is not str or decision not in REVIEW_DECISIONS):
        raise ExecutionDenied("Invalid review decision or version")
    expected_snapshot=_snapshot(expected_snapshot)
    if expected_evidence_sha256 is not None:_snapshot(expected_evidence_sha256)
    if expected_review_sha256 is not None:_snapshot(expected_review_sha256)
    note=_text_clean(note,"review rationale",400)
    runtime.records._key(idempotency_key)
    request=digest({"op":"risk.execution.review","tenant":tenant,
                    "project_id":project_id,"actor":actor,
                    "scenario_id":scenario_id,"action_id":action_id,
                    "expected_action_version":expected_action_version,
                    "expected_snapshot":expected_snapshot,
                    "expected_evidence_sha256":expected_evidence_sha256,
                    "expected_review_sha256":expected_review_sha256,
                    "decision":decision,"note":note})
    with runtime.drafts._tx() as db:
        action,rolled=_scope(runtime,db,tenant,project_id,actor,scenario_id,action_id,
                             write=True,owner=True)
        repeated=runtime.records._seen(db,tenant,project_id,idempotency_key,request)
        if repeated is not None:return repeated
        if action["version"]!=expected_action_version:
            raise ExecutionDenied("Action was revised; refresh before review")
        snapshot,risks,rolled=_live(runtime,db,tenant,project_id,actor,scenario_id)
        if rolled or snapshot!=expected_snapshot:
            raise ExecutionDenied("Review based on stale task snapshot")
        scope=(tenant,project_id,scenario_id,action_id)
        steps=_steps(db,scope);evidence=_evidence(db,scope);reviews=_reviews(db,scope)
        if (expected_evidence_sha256!=(evidence[-1]["sha256"] if evidence else None)
            or expected_review_sha256!=(reviews[-1]["sha256"] if reviews else None)):
            raise ExecutionDenied("Evidence or review changed; refresh")
        if len(reviews)>=MAX_REVIEWS:
            raise ExecutionDenied("Review history bound reached")
        proof=_proof_status(action,steps,evidence,reviews,snapshot,risks,False)
        if decision=="verified" and not proof["ready_for_local_verification"]:
            raise ExecutionDenied("Incomplete steps, stale evidence or active risk")
        previous=reviews[-1]["sha256"] if reviews else None
        record={"schema":REVIEW_SCHEMA,"tenant":tenant,"project_id":project_id,
                "scenario_id":scenario_id,"action_id":action_id,
                "seq":len(reviews)+1,"prev_sha256":previous,
                "review_id":str(uuid.uuid4()),"actor":actor,"created_epoch":_now(),
                "decision":decision,"note":note,
                "action_version":action["version"],"action_sha256":digest(action),
                "evidence_sha256":expected_evidence_sha256,
                "step_digests":[s["sha256"] for s in steps],
                "source_snapshot":snapshot,"risk_active_at_review":proof["risk_still_observed"],
                "independent_external_verification":False}
        sha=_append_ledger(db,"director_action_reviews",record,scope)
        result={"review":{**record,"sha256":sha},
                "local_data_verified":decision=="verified",
                "independent_external_verification":False,
                "production_published":False}
        runtime.records._remember(db,tenant,project_id,idempotency_key,request,result)
        return result


def _queue(db,runtime,tenant,project_id,actor):
    _principal(runtime,db,tenant,project_id,actor,"task.manage")
    rows=db.execute(
        """SELECT scenario_id,title FROM director_saved_scenarios
           WHERE tenant=? AND project_id=? AND status='applied'
           ORDER BY scenario_id LIMIT 51""",
        (tenant,project_id)).fetchall()
    if len(rows)>50:raise ExecutionDenied("Scenario queue exceeds allowed size")
    out=[]
    for row in rows:
        scenario_id=row["scenario_id"]
        _scenario,_receipt,rollback=_application(
            db,tenant,project_id,scenario_id)
        if rollback is not None:continue
        snapshot,risks,_=_live(runtime,db,tenant,project_id,actor,scenario_id)
        live={(risk["code"],risk["task_id"]) for risk in risks}
        entries=db.execute(
            """SELECT action_id FROM director_risk_actions
               WHERE tenant=? AND project_id=? AND scenario_id=?
               ORDER BY action_id LIMIT ?""",
            (tenant,project_id,scenario_id,MAX_ACTIONS+1)).fetchall()
        if len(entries)>MAX_ACTIONS:raise ExecutionDenied("Action queue exceeds limits")
        for entry in entries:
            action,_events=_stored(db,tenant,project_id,scenario_id,entry["action_id"])
            scope=(tenant,project_id,scenario_id,action["action_id"])
            steps=_steps(db,scope)
            evidence=_evidence(db,scope)
            reviews=_reviews(db,scope)
            verify=_proof_status(action,steps,evidence,reviews,snapshot,risks,False)
            out.append({
                "scenario_id":scenario_id,"scenario_title":row["title"],
                "action_id":action["action_id"],"risk_code":action["risk_code"],
                "task_id":action["task_id"],"severity":action["initial_severity"],
                "plan":action["plan"],"assignee":action["assignee"],
                "due_date":action["due_date"],"status":action["status"],
                "action_version":action["version"],
                "risk_still_observed":(action["risk_code"],action["task_id"]) in live,
                "step_done":sum(s["status"]=="done" for s in steps),
                "step_count":len(steps),"evidence_count":len(evidence),
                "review_verified_on_current_data":verify["review_verified_on_current_data"],
                "source_snapshot":snapshot,"action_sha256":digest(action),
            })
    return out


def portfolio_queue(runtime:"LocalAppRuntime",*,tenant:str,project_id:str,
                    actor:str,limit:int=50,offset:int=0)->dict:
    if (type(limit) is not int or not 1<=limit<=100 or
        type(offset) is not int or not 0<=offset<=2000):
        raise ExecutionDenied("Invalid risk queue page")
    with runtime.drafts._db() as db:
        db.execute("BEGIN")
        all_actions=_queue(db,runtime,tenant,project_id,actor)
        as_of=datetime.now(timezone.utc).date()
        def late(action):return bool(
            action["status"]!="resolved" and action["due_date"] is not None
            and action["due_date"]<as_of.isoformat())
        sorted_actions=sorted(all_actions,key=lambda x:(
            0 if late(x) else 1,
            {"high":0,"medium":1,"low":2}.get(x["severity"],3),
            x["due_date"] or "9999-12-31",x["action_id"]))
        return {
            "as_of_utc":as_of.isoformat(),
            "actions":sorted_actions[offset:offset+limit],
            "total":len(sorted_actions),"limit":limit,"offset":offset,
            "has_more":offset+limit<len(sorted_actions),
            "counts":{
                "open":sum(x["status"]=="open" for x in all_actions),
                "doing":sum(x["status"]=="doing" for x in all_actions),
                "resolved":sum(x["status"]=="resolved" for x in all_actions),
                "overdue":sum(late(x) for x in all_actions),
                "unassigned":sum(x["assignee"] is None and x["status"]!="resolved"
                                 for x in all_actions),
                "reviewed_current":sum(x["review_verified_on_current_data"]
                                       for x in all_actions),
            },
            "all_integrity_chains_checked":True,
            "local_only":True,"production_published":False,
        }


def portfolio_csv(runtime:"LocalAppRuntime",*,tenant:str,
                  project_id:str,actor:str)->dict:
    # One project, max 2,000 cards: no cross-organization export.
    report=portfolio_queue(runtime,tenant=tenant,project_id=project_id,
                           actor=actor,limit=100,offset=0)
    rows=report["actions"]
    # Export all pages; never silently provide an incomplete "all" export.
    while report["has_more"]:
        report=portfolio_queue(runtime,tenant=tenant,project_id=project_id,
                               actor=actor,limit=100,offset=len(rows))
        rows.extend(report["actions"])
    columns=("scenario_id","scenario_title","action_id","risk_code",
             "task_id","severity","plan","assignee","due_date","status",
             "risk_still_observed","step_done","step_count",
             "evidence_count","review_verified_on_current_data",
             "action_version","action_sha256")
    buffer=io.StringIO(newline="")
    writer=csv.DictWriter(buffer,fieldnames=columns,lineterminator="\r\n")
    writer.writeheader()
    for entry in rows:
        writer.writerow({key:_safe(entry.get(key)) for key in columns})
    output="\ufeff"+buffer.getvalue()
    return {"filename":"osgard-risk-portfolio.csv","mime":"text/csv;charset=utf-8",
            "csv":output,"rows":len(rows),"sha256":sha256(output.encode()).hexdigest(),
            "all_integrity_chains_checked":True,"production_published":False}
