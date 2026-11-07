"""Wave 26 / feature 1+2: manual observed checkpoints and verifiable history.

Every observation is read from live tenant/project-scoped task rows inside a
single write transaction; the manager cannot supply fake status/assignee data.
No background polling, outcome prediction or measured revenue claims. A
per-scenario SHA-256 hash chain makes deletion/reordering/tampering detectable
whenever the complete chain is read. Prior check-ins remain available after a
confirmed rollback, but new observations of that superseded plan are refused.
"""
from __future__ import annotations

from datetime import datetime, timezone
import json
import time
import uuid
from typing import TYPE_CHECKING, Any

from .contracts import canonical, digest
from .resource_forecast import _project_forecast_db
from .scenario_library import ScenarioLibraryDenied, _find, _snapshot, _uuid
from .scenario_outcomes import _read_receipt, summarize
from .team_tasks import _principal, _read

if TYPE_CHECKING:
    from .app_runtime import LocalAppRuntime

SCHEMA="osgard.original180.outcome-checkpoint/1"
MAX_CHECKPOINTS=60
MAX_ROWS=20
MAX_NOTE=400


def init_checkpoints(runtime:"LocalAppRuntime")->None:
    with runtime.drafts._db() as db:
        db.executescript("""
        CREATE TABLE IF NOT EXISTS director_scenario_checkpoints(
          tenant TEXT NOT NULL,
          project_id TEXT NOT NULL,
          scenario_id TEXT NOT NULL,
          checkpoint_id TEXT NOT NULL,
          seq INTEGER NOT NULL CHECK(seq BETWEEN 1 AND 60),
          prev_sha256 TEXT,
          created_epoch INTEGER NOT NULL,
          actor TEXT NOT NULL,
          source_snapshot TEXT NOT NULL,
          payload_json TEXT NOT NULL,
          payload_sha256 TEXT NOT NULL,
          PRIMARY KEY(tenant,project_id,scenario_id,checkpoint_id),
          UNIQUE(tenant,project_id,scenario_id,seq)
        );
        CREATE INDEX IF NOT EXISTS director_checkpoint_history_scope
          ON director_scenario_checkpoints(tenant,project_id,scenario_id,seq);
        CREATE TRIGGER IF NOT EXISTS director_checkpoint_update_denied
          BEFORE UPDATE ON director_scenario_checkpoints BEGIN
            SELECT RAISE(ABORT,'checkpoints immutable'); END;
        CREATE TRIGGER IF NOT EXISTS director_checkpoint_delete_denied
          BEFORE DELETE ON director_scenario_checkpoints BEGIN
            SELECT RAISE(ABORT,'checkpoints immutable'); END;
        """)


def _note(value:Any)->str:
    if (type(value) is not str or len(value)>MAX_NOTE
            or any((ord(ch)<32 and ch not in "\n") for ch in value)):
        raise ScenarioLibraryDenied("Checkpoint note must be 0-400 printable characters")
    return value.strip()


def _page_value(value:Any,*,label:str,minimum:int,maximum:int)->int:
    if type(value) is not int or not minimum<=value<=maximum:
        raise ScenarioLibraryDenied(label+" exceeds allowed range")
    return value


def _check_chain(db,tenant:str,project_id:str,scenario_id:str)->list[dict]:
    rows=db.execute(
        """SELECT * FROM director_scenario_checkpoints
           WHERE tenant=? AND project_id=? AND scenario_id=?
           ORDER BY seq ASC LIMIT ?""",
        (tenant,project_id,scenario_id,MAX_CHECKPOINTS+1)).fetchall()
    if len(rows)>MAX_CHECKPOINTS:
        raise ScenarioLibraryDenied("Checkpoint retention bound violated")
    seen=set()
    output=[]
    prev=None
    for expected,row in enumerate(rows,1):
        try:
            p=json.loads(row["payload_json"])
        except (ValueError,TypeError) as exc:
            raise ScenarioLibraryDenied("Unreadable outcome checkpoint") from exc
        if (type(p) is not dict
            or row["seq"]!=expected or p.get("sequence")!=expected
            or row["prev_sha256"]!=prev or p.get("prev_sha256")!=prev
            or row["checkpoint_id"] in seen
            or p.get("schema")!=SCHEMA
            or any(p.get(k)!=row[k] for k in (
                "tenant","project_id","scenario_id","checkpoint_id",
                "actor","created_epoch","source_snapshot"))
            or canonical(p).decode("utf-8")!=row["payload_json"]
            or digest(p)!=row["payload_sha256"]):
            raise ScenarioLibraryDenied("Outcome checkpoint chain integrity failure")
        if (type(p.get("task_observations")) is not list
            or not 1<=len(p["task_observations"])<=MAX_ROWS
            or type(p.get("metrics")) is not dict
            or type(p.get("note")) is not str
            or type(p.get("observed_on_utc")) is not str):
            raise ScenarioLibraryDenied("Checkpoint payload malformed")
        _snapshot(p["source_snapshot"])
        _snapshot(p.get("application_sha256"))
        _note(p["note"])
        task_seen=set()
        for t in p["task_observations"]:
            if (type(t) is not dict or
                set(t)!={
                    "task_id","title","assignee","status","version",
                    "due_date","updated_epoch","forecast_finish",
                    "forecast_state","variance_calendar_days"
                }):
                raise ScenarioLibraryDenied("Checkpoint task evidence malformed")
            task_id=_uuid(t["task_id"])
            if task_id in task_seen:
                raise ScenarioLibraryDenied("Duplicated checkpoint task")
            task_seen.add(task_id)
        seen.add(row["checkpoint_id"])
        prev=row["payload_sha256"]
        output.append({**p,"sha256":prev})
    return output


def _application(db,tenant,project_id,scenario_id):
    scenario=_find(db,tenant,project_id,scenario_id)
    if scenario["status"]!="applied":
        raise ScenarioLibraryDenied("Only an applied scenario can be monitored")
    applied=_read_receipt(db,"application",tenant,project_id,scenario_id)
    if applied is None:
        raise ScenarioLibraryDenied("Cannot verify pre-receipt scenario application")
    reverted=_read_receipt(db,"rollback",tenant,project_id,scenario_id)
    if reverted is not None and reverted.get("application_sha256")!=applied["sha256"]:
        raise ScenarioLibraryDenied("Rollback receipt refers to a different application")
    return scenario,applied,reverted


def _observe(db,*,tenant:str,project_id:str,applied:dict,forecast:dict)->list[dict]:
    tasks={t["task_id"]:t for t in forecast["tasks"]}
    output=[]
    for previous in applied["task_changes"]:
        current=_read(db,tenant,project_id,previous["task_id"])
        state=tasks.get(current["task_id"])
        if state is None:
            raise ScenarioLibraryDenied("Applied task missing from project forecast")
        output.append({
            "task_id":current["task_id"],
            "title":current["title"],
            "assignee":current["assignee"],
            "status":current["status"],
            "version":current["version"],
            "due_date":current["due_date"],
            "updated_epoch":current["updated_epoch"],
            "forecast_finish":state["estimated_finish"],
            "forecast_state":state["state"],
            "variance_calendar_days":state["variance_calendar_days"],
        })
    return sorted(output,key=lambda t:t["task_id"])


def capture_checkpoint(runtime:"LocalAppRuntime",*,tenant:str,project_id:str,
                       actor:str,scenario_id:str,expected_snapshot:str,
                       note:str,idempotency_key:str)->dict:
    scenario_id=_uuid(scenario_id)
    expected_snapshot=_snapshot(expected_snapshot)
    clean_note=_note(note)
    runtime.records._key(idempotency_key)
    request=digest({
        "operation":"monitor.checkpoint","tenant":tenant,"project_id":project_id,
        "actor":actor,"scenario_id":scenario_id,
        "snapshot":expected_snapshot,"note":clean_note
    })
    with runtime.drafts._tx() as db:
        _principal(runtime,db,tenant,project_id,actor,"task.manage")
        prior=runtime.records._seen(db,tenant,project_id,idempotency_key,request)
        if prior is not None:return prior
        _scenario,application,rollback=_application(
            db,tenant,project_id,scenario_id)
        if rollback is not None:
            raise ScenarioLibraryDenied("Cannot create new check-ins after rollback")
        forecast=_project_forecast_db(runtime,db,tenant=tenant,
                                     project_id=project_id,actor=actor)
        if forecast["input_snapshot"]!=expected_snapshot:
            raise ScenarioLibraryDenied("Forecast changed; refresh before check-in")
        chain=_check_chain(db,tenant,project_id,scenario_id)
        if len(chain)>=MAX_CHECKPOINTS:
            raise ScenarioLibraryDenied("Checkpoint limit reached for this scenario")
        now=int(time.time())
        p={
            "schema":SCHEMA,"tenant":tenant,"project_id":project_id,
            "scenario_id":scenario_id,"checkpoint_id":str(uuid.uuid4()),
            "sequence":len(chain)+1,
            "prev_sha256":chain[-1]["sha256"] if chain else None,
            "actor":actor,"created_epoch":now,
            "observed_on_utc":datetime.fromtimestamp(
                now,timezone.utc).date().isoformat(),
            "source_snapshot":expected_snapshot,
            "application_sha256":application["sha256"],
            "note":clean_note,
            "metrics":summarize(forecast),
            "task_observations":_observe(
                db,tenant=tenant,project_id=project_id,
                applied=application,forecast=forecast),
        }
        if not p["task_observations"]:
            raise ScenarioLibraryDenied("No tasks in applied scenario")
        content=canonical(p).decode("utf-8")
        sha=digest(p)
        db.execute(
            """INSERT INTO director_scenario_checkpoints(
               tenant,project_id,scenario_id,checkpoint_id,seq,prev_sha256,
               created_epoch,actor,source_snapshot,payload_json,payload_sha256)
               VALUES(?,?,?,?,?,?,?,?,?,?,?)""",
            (tenant,project_id,scenario_id,p["checkpoint_id"],p["sequence"],
             p["prev_sha256"],now,actor,expected_snapshot,content,sha))
        result={"checkpoint":{**p,"sha256":sha},"persisted_locally":True,
                "production_published":False}
        runtime.records._remember(db,tenant,project_id,idempotency_key,
                                  request,result)
        return result


def checkpoint_history(runtime:"LocalAppRuntime",*,tenant:str,project_id:str,
                       actor:str,scenario_id:str,limit:int=20,
                       offset:int=0)->dict:
    _uuid(scenario_id)
    _page_value(limit,label="Checkpoint page size",minimum=1,maximum=50)
    _page_value(offset,label="Checkpoint page offset",minimum=0,maximum=60)
    with runtime.drafts._db() as db:
        _principal(runtime,db,tenant,project_id,actor,"task.manage")
        _application(db,tenant,project_id,scenario_id)
        chain=_check_chain(db,tenant,project_id,scenario_id)
        ordered=list(reversed(chain))
        return {
            "checkpoints":ordered[offset:offset+limit],
            "total":len(ordered),
            "limit":limit,"offset":offset,
            "has_more":offset+limit<len(ordered),
            "chain_verified":True,
            "local_only":True,"production_published":False,
        }


def _snapshot_chain(db,tenant,project_id,scenario_id):
    # All readers verify the *whole* chain rather than trusting only a page.
    return _check_chain(db,tenant,project_id,scenario_id)
