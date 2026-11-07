"""Wave 24 — saved what-if variants, explicit owner approval and atomic apply.

Only save/select metadata until an owner explicitly confirms APPLY. Each
approval and application checks the original Wave 22 forecast input snapshot;
application uses the existing task CAS + append-only task event contract in
one SQLite BEGIN IMMEDIATE transaction. No deployment, background execution
or privilege escalation is performed by these operations.
"""
from __future__ import annotations

import json
import time
from typing import TYPE_CHECKING, Any
import uuid

from .contracts import canonical, digest
from .app_policy import AppAccessDenied
from .team_tasks import TaskDenied, _principal, _read, _eligible, _event
from .resource_forecast import _project_forecast_db
from .resource_scenarios import compare_reassignment

if TYPE_CHECKING:
    from .app_runtime import LocalAppRuntime

MAX_VARIANTS=50
MAX_DECISIONS=1000
STATES=frozenset(("draft","approved","superseded","applied"))
ACTIONS=frozenset(("SAVE","APPROVE","SUPERSEDE","APPLY"))
EVENT_SCHEMA="osgard.original180.scenario-decision/1"
CONFIRM_PHRASE="ПРИМЕНИТЬ"


class ScenarioLibraryDenied(TaskDenied):
    """Invalid, unauthorized or stale saved scenario operation."""


def _uuid(value:Any)->str:
    try:
        if type(value) is not str or str(uuid.UUID(value))!=value:
            raise ValueError()
    except ValueError as exc:
        raise ScenarioLibraryDenied("Canonical scenario ID required") from exc
    return value


def _snapshot(value:Any)->str:
    if (type(value) is not str or len(value)!=64
            or any(c not in "0123456789abcdef" for c in value)):
        raise ScenarioLibraryDenied("A 64-character SHA-256 input snapshot is required")
    return value


def _version(value:Any,*,zero:bool=False)->int:
    if type(value) is not int or not (0 if zero else 1)<=value<=1000000:
        raise ScenarioLibraryDenied("Exact positive scenario revision required")
    return value


def _title(value:Any)->str:
    if (type(value) is not str or not 1<=len(value.strip())<=100
            or any(ord(c)<32 for c in value)):
        raise ScenarioLibraryDenied("Scenario name must be 1-100 printable characters")
    return value.strip()


def init_scenario_library(runtime:"LocalAppRuntime")->None:
    with runtime.drafts._db() as db:
        db.executescript("""
        CREATE TABLE IF NOT EXISTS director_saved_scenarios(
          tenant TEXT NOT NULL, project_id TEXT NOT NULL,
          scenario_id TEXT NOT NULL, title TEXT NOT NULL,
          input_snapshot TEXT NOT NULL, moves_json TEXT NOT NULL,
          comparison_json TEXT NOT NULL,
          status TEXT NOT NULL CHECK(status IN
            ('draft','approved','superseded','applied')),
          version INTEGER NOT NULL CHECK(version>=1),
          created_by TEXT NOT NULL, updated_by TEXT NOT NULL,
          created_epoch INTEGER NOT NULL,updated_epoch INTEGER NOT NULL,
          row_digest TEXT NOT NULL,
          PRIMARY KEY(tenant,project_id,scenario_id)
        );
        CREATE INDEX IF NOT EXISTS director_saved_scenarios_scope
          ON director_saved_scenarios(tenant,project_id,updated_epoch);
        CREATE UNIQUE INDEX IF NOT EXISTS director_one_approved_scenario
          ON director_saved_scenarios(tenant,project_id)
          WHERE status='approved';
        CREATE TABLE IF NOT EXISTS director_scenario_decisions(
          event_id TEXT PRIMARY KEY,
          tenant TEXT NOT NULL,project_id TEXT NOT NULL,scenario_id TEXT NOT NULL,
          action TEXT NOT NULL CHECK(action IN
            ('SAVE','APPROVE','SUPERSEDE','APPLY')),
          actor TEXT NOT NULL,version INTEGER NOT NULL,
          at_epoch INTEGER NOT NULL,event_json TEXT NOT NULL,
          event_digest TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS director_scenario_decisions_scope
          ON director_scenario_decisions(tenant,project_id,scenario_id,at_epoch);
        CREATE TRIGGER IF NOT EXISTS director_scenario_decisions_no_update
          BEFORE UPDATE ON director_scenario_decisions BEGIN
            SELECT RAISE(ABORT,'scenario decisions are append-only');END;
        CREATE TRIGGER IF NOT EXISTS director_scenario_decisions_no_delete
          BEFORE DELETE ON director_scenario_decisions BEGIN
            SELECT RAISE(ABORT,'scenario decisions are append-only');END;
        """)


def _record(row)->dict:
    fields=("tenant","project_id","scenario_id","title","input_snapshot",
            "moves_json","comparison_json","status","version","created_by",
            "updated_by","created_epoch","updated_epoch")
    value={k:row[k] for k in fields}
    if digest(value)!=row["row_digest"]:
        raise ScenarioLibraryDenied("Saved scenario integrity mismatch")
    _uuid(value["scenario_id"])
    _title(value["title"])
    _snapshot(value["input_snapshot"])
    _version(value["version"])
    if value["status"] not in STATES:
        raise ScenarioLibraryDenied("Unsupported saved scenario status")
    try:
        moves=json.loads(value["moves_json"])
        comparison=json.loads(value["comparison_json"])
    except (ValueError,TypeError) as exc:
        raise ScenarioLibraryDenied("Corrupt saved scenario payload") from exc
    if (canonical(moves).decode("utf-8")!=value["moves_json"]
            or canonical(comparison).decode("utf-8")!=value["comparison_json"]
            or type(moves) is not list or not 1<=len(moves)<=20
            or type(comparison) is not dict):
        raise ScenarioLibraryDenied("Non-canonical scenario data")
    for m in moves:
        if (type(m) is not dict or set(m)!={"task_id","assignee"}
                or type(m["assignee"]) is not str):
            raise ScenarioLibraryDenied("Invalid persisted scenario move")
        _uuid(m["task_id"])
    if (set(comparison)!={"baseline","scenario","comparison"}
            or any(type(comparison[k]) is not dict for k in comparison)):
        raise ScenarioLibraryDenied("Invalid persisted comparison")
    return {**value,"moves":moves,"preview":comparison}


def _find(db,tenant:str,project_id:str,scenario_id:str)->dict:
    row=db.execute(
        """SELECT * FROM director_saved_scenarios
           WHERE tenant=? AND project_id=? AND scenario_id=?""",
        (tenant,project_id,_uuid(scenario_id))).fetchone()
    if row is None:
        raise ScenarioLibraryDenied("Saved variant is not available in this project")
    return _record(row)


def _public(record:dict,current_snapshot:str|None=None)->dict:
    result={k:record[k] for k in
            ("scenario_id","title","status","version","created_by","updated_by",
             "created_epoch","updated_epoch","input_snapshot")}
    result.update({
        "moves":record["moves"],
        "preview":record["preview"],
        "move_count":len(record["moves"]),
        "snapshot_current":(record["input_snapshot"]==current_snapshot
                             if current_snapshot is not None else None),
    })
    return result


def _owner(runtime,db,tenant,project_id,actor)->None:
    role=_principal(runtime,db,tenant,project_id,actor,"task.manage")
    if role!="owner":
        raise AppAccessDenied("Only the project owner may approve or apply a scenario")


def _decision(db,record:dict,actor:str,action:str)->None:
    count=db.execute(
        """SELECT COUNT(*) FROM director_scenario_decisions
           WHERE tenant=? AND project_id=?""",
        (record["tenant"],record["project_id"])).fetchone()[0]
    if count>=MAX_DECISIONS:
        raise ScenarioLibraryDenied("Decision audit quota reached")
    e={"schema":EVENT_SCHEMA,"event_id":str(uuid.uuid4()),
       "tenant":record["tenant"],"project_id":record["project_id"],
       "scenario_id":record["scenario_id"],"actor":actor,
       "action":action,"version":record["version"],
       "status":record["status"],"at_epoch":record["updated_epoch"],
       "scenario_digest":digest({k:record[k] for k in (
           "tenant","project_id","scenario_id","title","input_snapshot",
           "moves_json","comparison_json","status","version","created_by",
           "updated_by","created_epoch","updated_epoch")})}
    db.execute(
        """INSERT INTO director_scenario_decisions(
           event_id,tenant,project_id,scenario_id,action,
           actor,version,at_epoch,event_json,event_digest)
           VALUES(?,?,?,?,?,?,?,?,?,?)""",
        (e["event_id"],e["tenant"],e["project_id"],e["scenario_id"],
         action,actor,e["version"],e["at_epoch"],
         canonical(e).decode("utf-8"),digest(e)))


def _transition(db,record:dict,actor:str,new_status:str,action:str)->dict:
    old={k:record[k] for k in (
        "tenant","project_id","scenario_id","title","input_snapshot",
        "moves_json","comparison_json","status","version","created_by",
        "updated_by","created_epoch","updated_epoch")}
    current={**old,"status":new_status,"version":old["version"]+1,
             "updated_by":actor,
             "updated_epoch":max(int(time.time()),old["updated_epoch"])}
    count=db.execute(
        """UPDATE director_saved_scenarios SET status=?,version=?,
           updated_by=?,updated_epoch=?,row_digest=?
           WHERE tenant=? AND project_id=? AND scenario_id=?
             AND version=? AND row_digest=?""",
        (new_status,current["version"],actor,current["updated_epoch"],
         digest(current),old["tenant"],old["project_id"],old["scenario_id"],
         old["version"],digest(old))).rowcount
    if count!=1:
        raise ScenarioLibraryDenied("Concurrent scenario decision rejected")
    result={**current,"moves":record["moves"],"preview":record["preview"]}
    _decision(db,current,actor,action)
    return result


def _current_snapshot(runtime,db,tenant,project_id,actor)->str:
    return _project_forecast_db(runtime,db,tenant=tenant,
                                project_id=project_id,actor=actor)["input_snapshot"]


def save_variant(runtime:"LocalAppRuntime",*,tenant:str,project_id:str,
                 actor:str,title:str,expected_snapshot:str,
                 moves:list[dict],idempotency_key:str)->dict:
    title=_title(title)
    _snapshot(expected_snapshot)
    runtime.records._key(idempotency_key)
    request=digest({
        "op":"scenario.save","tenant":tenant,"project":project_id,
        "actor":actor,"title":title,"snapshot":expected_snapshot,"moves":moves})
    # Return an idempotent prior response even if the real plan subsequently
    # changes, but recheck the current principal before any replay.
    with runtime.drafts._db() as read_db:
        _principal(runtime,read_db,tenant,project_id,actor,"task.manage")
        prior=runtime.records._seen(read_db,tenant,project_id,
                                    idempotency_key,request)
        if prior is not None:
            return prior
    # Simulate first; the write transaction revalidates the source hash.
    analysis=compare_reassignment(runtime,tenant=tenant,project_id=project_id,
                                   actor=actor,expected_snapshot=expected_snapshot,
                                   moves=moves)
    sorted_moves=[{"task_id":m["task_id"],"assignee":m["assignee"]}
                  for m in sorted(moves,key=lambda m:m["task_id"])]
    preview={k:analysis[k] for k in ("baseline","scenario","comparison")}
    with runtime.drafts._tx() as db:
        _principal(runtime,db,tenant,project_id,actor,"task.manage")
        replay=runtime.records._seen(db,tenant,project_id,idempotency_key,request)
        if replay is not None:
            return replay
        if _current_snapshot(runtime,db,tenant,project_id,actor)!=expected_snapshot:
            raise ScenarioLibraryDenied("Planning input changed before saving")
        count=db.execute(
            """SELECT COUNT(*) FROM director_saved_scenarios
               WHERE tenant=? AND project_id=?""",
            (tenant,project_id)).fetchone()[0]
        if count>=MAX_VARIANTS:
            raise ScenarioLibraryDenied("Maximum saved scenarios reached")
        now=int(time.time())
        rec={
            "tenant":tenant,"project_id":project_id,
            "scenario_id":str(uuid.uuid4()),"title":title,
            "input_snapshot":expected_snapshot,
            "moves_json":canonical(sorted_moves).decode("utf-8"),
            "comparison_json":canonical(preview).decode("utf-8"),
            "status":"draft","version":1,
            "created_by":actor,"updated_by":actor,
            "created_epoch":now,"updated_epoch":now,
        }
        db.execute(
            """INSERT INTO director_saved_scenarios(
               tenant,project_id,scenario_id,title,input_snapshot,moves_json,
               comparison_json,status,version,created_by,updated_by,
               created_epoch,updated_epoch,row_digest)
               VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
            (tenant,project_id,rec["scenario_id"],title,expected_snapshot,
             rec["moves_json"],rec["comparison_json"],"draft",1,actor,actor,
             now,now,digest(rec)))
        _decision(db,rec,actor,"SAVE")
        result={"variant":_public({**rec,"moves":sorted_moves,"preview":preview},
                                   expected_snapshot),
                "persisted_locally":True,"tasks_changed":0,
                "production_published":False}
        runtime.records._remember(db,tenant,project_id,idempotency_key,request,result)
        return result


def list_variants(runtime:"LocalAppRuntime",*,tenant:str,
                  project_id:str,actor:str)->dict:
    with runtime.drafts._db() as db:
        _principal(runtime,db,tenant,project_id,actor,"task.manage")
        snapshot=_current_snapshot(runtime,db,tenant,project_id,actor)
        rows=db.execute(
            """SELECT * FROM director_saved_scenarios
               WHERE tenant=? AND project_id=?
               ORDER BY created_epoch DESC,scenario_id DESC LIMIT ?""",
            (tenant,project_id,MAX_VARIANTS+1)).fetchall()
        if len(rows)>MAX_VARIANTS:
            raise ScenarioLibraryDenied("Scenario list exceeds allowed size")
        from .scenario_outcomes import saved_outcome_flags
        variants=[]
        for row in rows:
            record=_record(row)
            flags=saved_outcome_flags(
                db,tenant,project_id,record["scenario_id"],record["status"])
            variants.append({**_public(record,snapshot),**flags})
        return {
            "variants":variants,
            "input_snapshot":snapshot,"local_only":True,
            "production_published":False,
        }


def select_variant(runtime:"LocalAppRuntime",*,tenant:str,project_id:str,
                   actor:str,scenario_id:str,expected_version:int,
                   expected_snapshot:str,idempotency_key:str)->dict:
    _uuid(scenario_id);_version(expected_version);_snapshot(expected_snapshot)
    runtime.records._key(idempotency_key)
    request=digest({
        "op":"scenario.select","tenant":tenant,"project_id":project_id,
        "actor":actor,"scenario_id":scenario_id,
        "version":expected_version,"snapshot":expected_snapshot})
    with runtime.drafts._tx() as db:
        _owner(runtime,db,tenant,project_id,actor)
        replay=runtime.records._seen(db,tenant,project_id,idempotency_key,request)
        if replay is not None:return replay
        rec=_find(db,tenant,project_id,scenario_id)
        if rec["version"]!=expected_version or rec["status"] not in ("draft","superseded"):
            raise ScenarioLibraryDenied("Only current drafts can be selected")
        if (rec["input_snapshot"]!=expected_snapshot or
              _current_snapshot(runtime,db,tenant,project_id,actor)!=expected_snapshot):
            raise ScenarioLibraryDenied("Saved variant is stale; recalculate before selection")
        old_rows=db.execute(
            """SELECT * FROM director_saved_scenarios
               WHERE tenant=? AND project_id=? AND status='approved'""",
            (tenant,project_id)).fetchall()
        if len(old_rows)>1:
            raise ScenarioLibraryDenied("Multiple selected scenarios detected")
        for old in old_rows:
            _transition(db,_record(old),actor,"superseded","SUPERSEDE")
        selected=_transition(db,rec,actor,"approved","APPROVE")
        result={"variant":_public(selected,expected_snapshot),
                "selected":True,"tasks_changed":0,"production_published":False}
        runtime.records._remember(db,tenant,project_id,idempotency_key,request,result)
        return result


def apply_variant(runtime:"LocalAppRuntime",*,tenant:str,project_id:str,
                  actor:str,scenario_id:str,expected_version:int,
                  expected_snapshot:str,confirmation:str,
                  idempotency_key:str)->dict:
    _uuid(scenario_id);_version(expected_version);_snapshot(expected_snapshot)
    if type(confirmation) is not str or confirmation!=CONFIRM_PHRASE:
        raise ScenarioLibraryDenied("Explicit application confirmation is required")
    runtime.records._key(idempotency_key)
    request=digest({
        "op":"scenario.apply","tenant":tenant,"project_id":project_id,
        "actor":actor,"scenario_id":scenario_id,
        "version":expected_version,"snapshot":expected_snapshot,
        "confirmation":confirmation})
    with runtime.drafts._tx() as db:
        _owner(runtime,db,tenant,project_id,actor)
        replay=runtime.records._seen(db,tenant,project_id,idempotency_key,request)
        if replay is not None:return replay
        rec=_find(db,tenant,project_id,scenario_id)
        if rec["version"]!=expected_version or rec["status"]!="approved":
            raise ScenarioLibraryDenied("Only the selected, current variant may be applied")
        if (rec["input_snapshot"]!=expected_snapshot or
              _current_snapshot(runtime,db,tenant,project_id,actor)!=expected_snapshot):
            raise ScenarioLibraryDenied("Source data changed; select a refreshed plan")
        # Preflight EVERY task before the first update. The transaction
        # rolls back all task/event/decision changes if any check later fails.
        updates=[]
        for move in rec["moves"]:
            task=_read(db,tenant,project_id,move["task_id"])
            if task["status"]=="done" or task["assignee"]==move["assignee"]:
                raise ScenarioLibraryDenied("Task no longer eligible for proposed move")
            _eligible(db,tenant,project_id,move["assignee"])
            updates.append((task,move["assignee"]))
        changed=[]
        receipt_changes=[]
        before_report=_project_forecast_db(runtime,db,
            tenant=tenant,project_id=project_id,actor=actor)
        for old,new_assignee in updates:
            now=max(int(time.time()),old["updated_epoch"])
            current={**old,"assignee":new_assignee,
                     "version":old["version"]+1,
                     "updated_by":actor,"updated_epoch":now}
            count=db.execute(
                """UPDATE director_tasks SET assignee=?,version=?,
                   updated_by=?,updated_epoch=?,task_digest=?
                   WHERE tenant=? AND project_id=? AND task_id=?
                     AND version=? AND task_digest=?""",
                (new_assignee,current["version"],actor,now,digest(current),
                 tenant,project_id,old["task_id"],old["version"],digest(old)),
            ).rowcount
            if count!=1:
                raise ScenarioLibraryDenied("Atomic task CAS failed; plan not applied")
            _event(runtime,db,current,actor=actor,operation="UPDATE",
                   before=old,changed=["assignee"])
            changed.append({"task_id":old["task_id"],
                            "assignee":new_assignee,"version":current["version"]})
            receipt_changes.append({
                "task_id":old["task_id"],
                "before_assignee":old["assignee"],
                "after_assignee":new_assignee,
                "version_before":old["version"],
                "version_after":current["version"],
                "digest_before":digest(old),
                "digest_after":digest(current),
            })
        applied=_transition(db,rec,actor,"applied","APPLY")
        from .scenario_outcomes import record_application
        receipt=record_application(
            db,runtime=runtime,tenant=tenant,project_id=project_id,
            actor=actor,scenario_id=scenario_id,before=before_report,
            applied=applied,changes=receipt_changes)
        result={"scenario_id":scenario_id,"status":applied["status"],
                "application_sha256":receipt["sha256"],
                "version":applied["version"],"applied_count":len(changed),
                "tasks":changed,"atomic":True,"production_published":False,
                "persisted_locally":True}
        runtime.records._remember(db,tenant,project_id,idempotency_key,request,result)
        return result


def decision_history(runtime:"LocalAppRuntime",*,tenant:str,project_id:str,
                     actor:str,scenario_id:str,limit:int=30)->dict:
    _uuid(scenario_id)
    if type(limit) is not int or not 1<=limit<=50:
        raise ScenarioLibraryDenied("History limit must be 1-50")
    with runtime.drafts._db() as db:
        _principal(runtime,db,tenant,project_id,actor,"task.manage")
        _find(db,tenant,project_id,scenario_id)
        rows=db.execute(
            """SELECT * FROM director_scenario_decisions
               WHERE tenant=? AND project_id=? AND scenario_id=?
               ORDER BY at_epoch DESC,event_id DESC LIMIT ?""",
            (tenant,project_id,scenario_id,limit)).fetchall()
        output=[]
        for row in rows:
            try:event=json.loads(row["event_json"])
            except (ValueError,TypeError) as exc:
                raise ScenarioLibraryDenied("Corrupt decision record") from exc
            if (canonical(event).decode("utf-8")!=row["event_json"]
                    or digest(event)!=row["event_digest"]
                    or event.get("schema")!=EVENT_SCHEMA
                    or any(event.get(k)!=row[k] for k in (
                        "event_id","tenant","project_id","scenario_id","action",
                        "actor","version","at_epoch"))
                    or event.get("action") not in ACTIONS
                    or event.get("status") not in STATES):
                raise ScenarioLibraryDenied("Decision history integrity failure")
            output.append({
                "action":event["action"],"status":event["status"],
                "actor":event["actor"],"version":event["version"],
                "at_epoch":event["at_epoch"],"sha256":row["event_digest"],
                "scenario_digest":event["scenario_digest"],
            })
        # Legacy decision table cannot be altered without a destructive
        # migration. A verified append-only reversal receipt is surfaced
        # as a unified decision event, never spliced into historical rows.
        from .scenario_outcomes import _read_receipt
        reversal=_read_receipt(db,"rollback",tenant,project_id,scenario_id)
        if reversal is not None:
            output.append({
                "action":"ROLLBACK","status":"rolled_back",
                "actor":reversal["actor"],"version":reversal["scenario_version"],
                "at_epoch":reversal["at_epoch"],
                "sha256":reversal["sha256"],
                "scenario_digest":reversal["application_sha256"],
            })
        output.sort(key=lambda x:(x["at_epoch"],x["action"]),reverse=True)
        return {"events":output[:limit],"immutable":True,"local_only":True}
