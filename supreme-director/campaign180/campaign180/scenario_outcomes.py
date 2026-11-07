"""Wave 25: factual scenario application receipts and tightly guarded rollback.

A receipt is committed in the SAME SQLite write transaction as the Wave 24
reassignments; older applications without receipts cannot be automatically
reverted. Each rollback checks all touched rows and actor eligibility before
any write, uses digest+version CAS, and appends the existing task audit events.
Application and rollback receipts are immutable and individually SHA-256
verified. Scenarios remain in Wave24's 'applied' SQL state; their effective
'rolled_back' state is derived from a separate immutable receipt, so no
destructive schema migration or rewriting of historical decisions is required.
"""
from __future__ import annotations

from datetime import date
import json
import time
import uuid
from typing import TYPE_CHECKING, Any

from .contracts import canonical, digest
from .resource_forecast import _project_forecast_db
from .resource_scenarios import _compact
from .team_tasks import TaskDenied, _principal, _read, _eligible, _event
from .scenario_library import (
    ScenarioLibraryDenied, _find, _owner, _snapshot, _uuid, _version,
)

if TYPE_CHECKING:
    from .app_runtime import LocalAppRuntime

APPLY_SCHEMA="osgard.original180.scenario-application/1"
ROLLBACK_SCHEMA="osgard.original180.scenario-rollback/1"
ROLLBACK_PHRASE="ОТКАТИТЬ"
MAX_MOVES=20
SUMMARY_FIELDS=(
    "open_tasks","scheduled_tasks","unforecastable_tasks",
    "at_risk_tasks","at_risk_milestones","potential_finish",
    "coverage_complete","overloaded_workers","unknown_load_workers",
)


def init_outcomes(runtime:"LocalAppRuntime")->None:
    with runtime.drafts._db() as db:
        db.executescript("""
          CREATE TABLE IF NOT EXISTS director_scenario_applications(
            tenant TEXT NOT NULL, project_id TEXT NOT NULL,
            scenario_id TEXT NOT NULL,
            receipt_json TEXT NOT NULL,receipt_digest TEXT NOT NULL,
            PRIMARY KEY(tenant,project_id,scenario_id)
          );
          CREATE TABLE IF NOT EXISTS director_scenario_rollbacks(
            tenant TEXT NOT NULL, project_id TEXT NOT NULL,
            scenario_id TEXT NOT NULL,
            receipt_json TEXT NOT NULL,receipt_digest TEXT NOT NULL,
            PRIMARY KEY(tenant,project_id,scenario_id)
          );
          CREATE TRIGGER IF NOT EXISTS director_scenario_application_no_update
            BEFORE UPDATE ON director_scenario_applications BEGIN
              SELECT RAISE(ABORT,'scenario application receipt immutable');END;
          CREATE TRIGGER IF NOT EXISTS director_scenario_application_no_delete
            BEFORE DELETE ON director_scenario_applications BEGIN
              SELECT RAISE(ABORT,'scenario application receipt immutable');END;
          CREATE TRIGGER IF NOT EXISTS director_scenario_rollback_no_update
            BEFORE UPDATE ON director_scenario_rollbacks BEGIN
              SELECT RAISE(ABORT,'scenario rollback receipt immutable');END;
          CREATE TRIGGER IF NOT EXISTS director_scenario_rollback_no_delete
            BEFORE DELETE ON director_scenario_rollbacks BEGIN
              SELECT RAISE(ABORT,'scenario rollback receipt immutable');END;
        """)


def _table(kind:str)->str:
    if kind=="application":return "director_scenario_applications"
    if kind=="rollback":return "director_scenario_rollbacks"
    raise ScenarioLibraryDenied("Unsupported receipt type")


def _insert_receipt(db, kind:str, payload:dict)->str:
    table=_table(kind)
    content=canonical(payload).decode("utf-8")
    sha=digest(payload)
    db.execute(
        f"""INSERT INTO {table}(tenant,project_id,scenario_id,
            receipt_json,receipt_digest) VALUES(?,?,?,?,?)""",
        (payload["tenant"],payload["project_id"],payload["scenario_id"],
         content,sha))
    return sha


def _read_receipt(db,kind:str,tenant:str,project_id:str,scenario_id:str)->dict|None:
    table=_table(kind)
    row=db.execute(
        f"""SELECT * FROM {table}
            WHERE tenant=? AND project_id=? AND scenario_id=?""",
        (tenant,project_id,scenario_id)).fetchone()
    if row is None:return None
    try:
        payload=json.loads(row["receipt_json"])
    except (ValueError,TypeError) as exc:
        raise ScenarioLibraryDenied("Unreadable historical scenario receipt") from exc
    schema=APPLY_SCHEMA if kind=="application" else ROLLBACK_SCHEMA
    if (type(payload) is not dict
            or payload.get("schema")!=schema
            or any(payload.get(key)!=row[key] for key in (
                "tenant","project_id","scenario_id"))
            or canonical(payload).decode("utf-8")!=row["receipt_json"]
            or digest(payload)!=row["receipt_digest"]):
        raise ScenarioLibraryDenied("Historical scenario receipt integrity failure")
    _uuid(payload["scenario_id"])
    if type(payload.get("task_changes")) is not list or not (
        1<=len(payload["task_changes"])<=MAX_MOVES):
        raise ScenarioLibraryDenied("Invalid historical task operation count")
    seen=set()
    for task in payload["task_changes"]:
        if (type(task) is not dict or
                set(task)!={"task_id","before_assignee","after_assignee",
                             "version_before","version_after",
                             "digest_before","digest_after"}):
            raise ScenarioLibraryDenied("Damaged assignment receipt")
        tid=_uuid(task["task_id"])
        if tid in seen or task["version_after"]!=task["version_before"]+1:
            raise ScenarioLibraryDenied("Invalid assignment version history")
        seen.add(tid)
        _version(task["version_before"]);_version(task["version_after"])
        _snapshot(task["digest_before"]);_snapshot(task["digest_after"])
        for field in ("before_assignee","after_assignee"):
            actor=task[field]
            if actor is not None and (type(actor) is not str or not actor.strip()):
                raise ScenarioLibraryDenied("Damaged historical assignee")
        if task["before_assignee"]==task["after_assignee"]:
            raise ScenarioLibraryDenied("No-op historical assignment")
    for field in ("snapshot_before","snapshot_after"):
        _snapshot(payload.get(field))
    if (type(payload.get("at_epoch")) is not int or
        type(payload.get("actor")) is not str or
        type(payload.get("metrics_before")) is not dict or
        type(payload.get("metrics_after")) is not dict or
        set(payload["metrics_before"])!=set(SUMMARY_FIELDS) or
        set(payload["metrics_after"])!=set(SUMMARY_FIELDS)):
        raise ScenarioLibraryDenied("Invalid historical scenario summary")
    return {**payload,"sha256":row["receipt_digest"]}


def summarize(report:dict)->dict:
    metrics=_compact(report)["metrics"]
    return {key:metrics[key] for key in SUMMARY_FIELDS}


def record_application(db, *,runtime:"LocalAppRuntime",tenant:str,
                       project_id:str,actor:str,scenario_id:str,
                       before:dict,applied:dict,changes:list[dict])->dict:
    """Call inside the Wave24 BEGIN IMMEDIATE transaction after task writes."""
    if applied["status"]!="applied" or not 1<=len(changes)<=MAX_MOVES:
        raise ScenarioLibraryDenied("Application receipt requires a committed plan")
    if _read_receipt(db,"application",tenant,project_id,scenario_id) is not None:
        raise ScenarioLibraryDenied("Application was already recorded")
    after=_project_forecast_db(runtime,db,
                               tenant=tenant,project_id=project_id,actor=actor)
    if before["input_snapshot"]==after["input_snapshot"]:
        raise ScenarioLibraryDenied("Real assignments did not change")
    payload={
        "schema":APPLY_SCHEMA,"tenant":tenant,"project_id":project_id,
        "scenario_id":scenario_id,"actor":actor,
        "scenario_version":applied["version"],
        "at_epoch":int(time.time()),
        "snapshot_before":before["input_snapshot"],
        "snapshot_after":after["input_snapshot"],
        "task_changes":changes,
        "metrics_before":summarize(before),
        "metrics_after":summarize(after),
    }
    sha=_insert_receipt(db,"application",payload)
    return {"sha256":sha,"snapshot_after":payload["snapshot_after"],
            "metrics_before":payload["metrics_before"],
            "metrics_after":payload["metrics_after"]}


def saved_outcome_flags(db,tenant:str,project_id:str,scenario_id:str,
                        status:str)->dict:
    application=_read_receipt(db,"application",tenant,project_id,scenario_id)
    rollback=_read_receipt(db,"rollback",tenant,project_id,scenario_id)
    if rollback is not None and application is None:
        raise ScenarioLibraryDenied("Rollback receipt without application")
    if rollback and rollback.get("application_sha256")!=application["sha256"]:
        raise ScenarioLibraryDenied("Rollback references different application")
    if (application is not None and status!="applied") or (
          rollback is not None and status!="applied"):
        raise ScenarioLibraryDenied("Application receipt does not match scenario state")
    return {
        "effective_status":"rolled_back" if rollback else status,
        "rollback_recorded":rollback is not None,
        "rollback_supported":bool(application and not rollback and status=="applied"),
        "application_recorded":application is not None,
    }


def _rollback_preflight(db,*,tenant:str,project_id:str,
                        application:dict)->list[tuple[dict,dict]]:
    tasks=[]
    for saved in application["task_changes"]:
        try:
            current=_read(db,tenant,project_id,saved["task_id"])
            if (current["version"]!=saved["version_after"] or
                current["assignee"]!=saved["after_assignee"] or
                digest(current)!=saved["digest_after"]):
                raise ScenarioLibraryDenied(
                    "Tasks changed after application; rollback denied")
            _eligible(db,tenant,project_id,saved["before_assignee"])
        except TaskDenied as exc:
            raise ScenarioLibraryDenied(
                "Rollback blocked by changed task or inactive previous assignee"
            ) from exc
        tasks.append((current,saved))
    return tasks


def outcome_detail(runtime:"LocalAppRuntime",*,tenant:str,project_id:str,
                   actor:str,scenario_id:str)->dict:
    _uuid(scenario_id)
    with runtime.drafts._db() as db:
        db.execute("BEGIN")
        _principal(runtime,db,tenant,project_id,actor,"task.manage")
        scenario=_find(db,tenant,project_id,scenario_id)
        application=_read_receipt(db,"application",tenant,project_id,scenario_id)
        rollback=_read_receipt(db,"rollback",tenant,project_id,scenario_id)
        flags=saved_outcome_flags(db,tenant,project_id,scenario_id,scenario["status"])
        current=_project_forecast_db(runtime,db,
                                     tenant=tenant,project_id=project_id,actor=actor)
        eligible=False
        if flags["rollback_supported"]:
            try:
                _rollback_preflight(db,tenant=tenant,project_id=project_id,
                                    application=application)
                eligible=True
            except (ValueError,):
                pass
        return {
            "scenario_id":scenario_id,"scenario_version":scenario["version"],
            **flags,
            "rollback_ready":eligible,
            "application":application,
            "rollback":rollback,
            "current_snapshot":current["input_snapshot"],
            "current_metrics":summarize(current),
            "changed_since_application":(
                current["input_snapshot"]!=application["snapshot_after"]
                if application else None),
            "local_only":True,"production_published":False,
        }


def rollback_application(runtime:"LocalAppRuntime",*,tenant:str,
                         project_id:str,actor:str,scenario_id:str,
                         expected_version:int,expected_snapshot:str,
                         confirmation:str,idempotency_key:str)->dict:
    _uuid(scenario_id);_version(expected_version);_snapshot(expected_snapshot)
    if type(confirmation) is not str or confirmation!=ROLLBACK_PHRASE:
        raise ScenarioLibraryDenied("Exact explicit rollback confirmation is required")
    runtime.records._key(idempotency_key)
    request=digest({
        "op":"scenario.rollback","tenant":tenant,"project":project_id,
        "actor":actor,"scenario_id":scenario_id,
        "version":expected_version,"snapshot":expected_snapshot,
        "confirmation":confirmation,
    })
    with runtime.drafts._tx() as db:
        _owner(runtime,db,tenant,project_id,actor)
        # The authenticated prior response is stable even after the rollback
        # changed task versions. A different request using the key is rejected.
        replay=runtime.records._seen(
            db,tenant,project_id,idempotency_key,request)
        if replay is not None:return replay
        scenario=_find(db,tenant,project_id,scenario_id)
        if scenario["status"]!="applied" or scenario["version"]!=expected_version:
            raise ScenarioLibraryDenied("Only a current applied plan can be rolled back")
        application=_read_receipt(db,"application",tenant,project_id,scenario_id)
        if application is None:
            raise ScenarioLibraryDenied(
                "Historical application predates verified rollback receipts")
        if _read_receipt(db,"rollback",tenant,project_id,scenario_id) is not None:
            raise ScenarioLibraryDenied("Plan has already been rolled back")
        before=_project_forecast_db(runtime,db,tenant=tenant,
                                     project_id=project_id,actor=actor)
        if before["input_snapshot"]!=expected_snapshot:
            raise ScenarioLibraryDenied("Forecast changed; refresh before rollback")
        tasks=_rollback_preflight(db,tenant=tenant,project_id=project_id,
                                  application=application)
        reversed_changes=[]
        for current,saved in tasks:
            now=max(int(time.time()),current["updated_epoch"])
            new={**current,"assignee":saved["before_assignee"],
                 "version":current["version"]+1,
                 "updated_by":actor,"updated_epoch":now}
            changed=db.execute(
                """UPDATE director_tasks SET assignee=?,version=?,
                   updated_by=?,updated_epoch=?,task_digest=?
                   WHERE tenant=? AND project_id=? AND task_id=?
                     AND version=? AND task_digest=?""",
                (new["assignee"],new["version"],actor,now,digest(new),
                 tenant,project_id,current["task_id"],
                 current["version"],digest(current)),
            ).rowcount
            if changed!=1:
                raise ScenarioLibraryDenied("Concurrent rollback conflict; no task changed")
            _event(runtime,db,new,actor=actor,operation="UPDATE",
                   before=current,changed=["assignee"])
            reversed_changes.append({
                "task_id":current["task_id"],
                "before_assignee":current["assignee"],
                "after_assignee":new["assignee"],
                "version_before":current["version"],
                "version_after":new["version"],
                "digest_before":digest(current),
                "digest_after":digest(new),
            })
        after=_project_forecast_db(runtime,db,tenant=tenant,
                                    project_id=project_id,actor=actor)
        if before["input_snapshot"]==after["input_snapshot"]:
            raise ScenarioLibraryDenied("Rollback did not change real assignment inputs")
        receipt={
            "schema":ROLLBACK_SCHEMA,"tenant":tenant,"project_id":project_id,
            "scenario_id":scenario_id,"actor":actor,"at_epoch":int(time.time()),
            "application_sha256":application["sha256"],
            "scenario_version":expected_version,
            "snapshot_before":before["input_snapshot"],
            "snapshot_after":after["input_snapshot"],
            "task_changes":reversed_changes,
            "metrics_before":summarize(before),
            "metrics_after":summarize(after),
        }
        sha=_insert_receipt(db,"rollback",receipt)
        response={
            "scenario_id":scenario_id,"effective_status":"rolled_back",
            "reverted_count":len(reversed_changes),
            "tasks":[{"task_id":x["task_id"],
                      "assignee":x["after_assignee"],
                      "version":x["version_after"]}
                     for x in reversed_changes],
            "receipt_sha256":sha,"atomic":True,
            "persisted_locally":True,"production_published":False,
        }
        runtime.records._remember(
            db,tenant,project_id,idempotency_key,request,response)
        return response
