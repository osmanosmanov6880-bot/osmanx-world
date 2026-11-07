"""Wave 22 — explicit-capacity, dependency-aware local delivery forecasting.

This is deterministic scenario planning, not a predictive AI or a contractual
delivery commitment. Effort (hours) and productive capacity (hours/business
day) are supplied by managers; the system does not infer them from task counts.
A forecast is withheld for missing/blocked inputs and their dependents.
Task execution is serial per assignee, Monday-Friday UTC, excluding no public
holidays; resource leveling uses earliest due dates, not optimal scheduling.
"""
from __future__ import annotations

from datetime import date, datetime, timedelta, timezone
import heapq
import json
import math
import time
from typing import TYPE_CHECKING, Any
import uuid

from .contracts import ACTOR_RE, canonical, digest
from .team_tasks import TaskDenied, _principal, _read, _visible, _eligible
from .task_planning import _all_edges
from .delivery_plan import _phase_and_milestones

if TYPE_CHECKING:
    from .app_runtime import LocalAppRuntime

MAX_REPORT_TASKS = 2000
MAX_FORECAST_EVENTS = 6000
MAX_HORIZON_DAYS = 730
MAX_ESTIMATE_HOURS = 2000
MAX_CAPACITY_HOURS = 12
SCHEMA = "osgard.original180.resource-forecast/1"


class ForecastDenied(TaskDenied):
    """Unsafe forecast input, corrupt stored data, stale version or bad scope."""


def init_forecast(runtime: "LocalAppRuntime") -> None:
    with runtime.drafts._db() as db:
        db.executescript("""
          CREATE TABLE IF NOT EXISTS director_task_effort(
            tenant TEXT NOT NULL,project_id TEXT NOT NULL,task_id TEXT NOT NULL,
            effort_hours INTEGER NOT NULL CHECK(effort_hours BETWEEN 1 AND 2000),
            version INTEGER NOT NULL CHECK(version>=1),
            updated_by TEXT NOT NULL,updated_epoch INTEGER NOT NULL,
            row_digest TEXT NOT NULL,
            PRIMARY KEY(tenant,project_id,task_id)
          );
          CREATE TABLE IF NOT EXISTS director_worker_capacity(
            tenant TEXT NOT NULL,project_id TEXT NOT NULL,worker TEXT NOT NULL,
            hours_per_day INTEGER NOT NULL CHECK(hours_per_day BETWEEN 1 AND 12),
            version INTEGER NOT NULL CHECK(version>=1),
            updated_by TEXT NOT NULL,updated_epoch INTEGER NOT NULL,
            row_digest TEXT NOT NULL,
            PRIMARY KEY(tenant,project_id,worker)
          );
          CREATE TABLE IF NOT EXISTS director_forecast_events(
            event_id TEXT PRIMARY KEY,
            tenant TEXT NOT NULL,project_id TEXT NOT NULL,
            subject_id TEXT NOT NULL,subject_type TEXT NOT NULL
              CHECK(subject_type IN ('effort','capacity')),
            actor TEXT NOT NULL,version INTEGER NOT NULL,
            at_epoch INTEGER NOT NULL,event_json TEXT NOT NULL,
            event_digest TEXT NOT NULL
          );
          CREATE INDEX IF NOT EXISTS director_forecast_events_scope
            ON director_forecast_events(tenant,project_id,at_epoch);
          CREATE TRIGGER IF NOT EXISTS director_forecast_event_no_update
            BEFORE UPDATE ON director_forecast_events BEGIN
              SELECT RAISE(ABORT,'forecast events append-only'); END;
          CREATE TRIGGER IF NOT EXISTS director_forecast_event_no_delete
            BEFORE DELETE ON director_forecast_events BEGIN
              SELECT RAISE(ABORT,'forecast events append-only'); END;
        """)


def _uuid(value: Any) -> str:
    try:
        if type(value) is not str or str(uuid.UUID(value)) != value:
            raise ValueError()
    except ValueError as exc:
        raise ForecastDenied("Canonical task UUID required") from exc
    return value


def _positive_int(value: Any, *, label: str, minimum: int, maximum: int) -> int:
    if type(value) is not int or not minimum <= value <= maximum:
        raise ForecastDenied(label + " outside supported integer range")
    return value


def _checked(row, *, capacity: bool) -> dict:
    keys = (("tenant","project_id","worker","hours_per_day",
             "version","updated_by","updated_epoch")
            if capacity else ("tenant","project_id","task_id","effort_hours",
                               "version","updated_by","updated_epoch"))
    value = {k: row[k] for k in keys}
    if digest(value) != row["row_digest"]:
        raise ForecastDenied("Resource input integrity mismatch")
    hours = value["hours_per_day"] if capacity else value["effort_hours"]
    _positive_int(hours,label="Persisted work hours",minimum=1,
                  maximum=MAX_CAPACITY_HOURS if capacity else MAX_ESTIMATE_HOURS)
    _positive_int(value["version"],label="Persisted input version",
                  minimum=1,maximum=1000000)
    if capacity:
        if type(value["worker"]) is not str or not ACTOR_RE.fullmatch(value["worker"]):
            raise ForecastDenied("Invalid stored worker ID")
    else:
        _uuid(value["task_id"])
    return value


def _audit(db, *, old: dict | None, new: dict,
           subject_type: str, actor: str) -> None:
    tenant, project = new["tenant"], new["project_id"]
    n = db.execute(
        """SELECT COUNT(*) FROM director_forecast_events
           WHERE tenant=? AND project_id=?""",
        (tenant,project)).fetchone()[0]
    if n >= MAX_FORECAST_EVENTS:
        raise ForecastDenied("Local forecast event quota reached")
    event = {
        "schema": SCHEMA, "event_id": str(uuid.uuid4()),
        "tenant": tenant, "project_id": project,
        "subject_id": new["worker"] if subject_type=="capacity" else new["task_id"],
        "subject_type": subject_type, "actor": actor,
        "version": new["version"], "at_epoch": new["updated_epoch"],
        "before": old, "after": new,
    }
    db.execute(
        """INSERT INTO director_forecast_events(
           event_id,tenant,project_id,subject_id,subject_type,actor,version,
           at_epoch,event_json,event_digest) VALUES(?,?,?,?,?,?,?,?,?,?)""",
        (event["event_id"],tenant,project,event["subject_id"],subject_type,
         actor,new["version"],new["updated_epoch"],
         canonical(event).decode("utf-8"),digest(event)),
    )


def _modify(runtime: "LocalAppRuntime", *,
            tenant: str, project_id: str, actor: str,
            subject_id: str, hours: int, expected_version: int,
            idempotency_key: str, capacity: bool) -> dict:
    _positive_int(expected_version,label="Expected version",minimum=0,maximum=1000000)
    _positive_int(hours,label="Working hours",minimum=1,
                  maximum=MAX_CAPACITY_HOURS if capacity else MAX_ESTIMATE_HOURS)
    if capacity:
        if type(subject_id) is not str or not ACTOR_RE.fullmatch(subject_id):
            raise ForecastDenied("Valid worker actor required")
    else:
        _uuid(subject_id)
    runtime.records._key(idempotency_key)
    kind = "capacity" if capacity else "effort"
    table = "director_worker_capacity" if capacity else "director_task_effort"
    id_field = "worker" if capacity else "task_id"
    value_field = "hours_per_day" if capacity else "effort_hours"
    request = digest({
        "operation": "forecast."+kind, "tenant": tenant,"project_id": project_id,
        "actor": actor,"subject": subject_id,"hours": hours,
        "expected_version": expected_version,
    })
    with runtime.drafts._tx() as db:
        _principal(runtime,db,tenant,project_id,actor,"task.manage")
        if capacity:
            # An inactive member cannot be assigned new capacity or replay a write.
            _eligible(db,tenant,project_id,subject_id)
        else:
            _read(db,tenant,project_id,subject_id)
        previous = db.execute(
            f"""SELECT * FROM {table} WHERE tenant=? AND project_id=?
                AND {id_field}=?""",(tenant,project_id,subject_id)).fetchone()
        old = None if previous is None else _checked(previous,capacity=capacity)
        replay = runtime.records._seen(db,tenant,project_id,idempotency_key,request)
        if replay is not None:
            return replay
        if expected_version != (old["version"] if old else 0):
            raise ForecastDenied("Stale resource input version")
        if old is not None and old[value_field] == hours:
            raise ForecastDenied("Resource input unchanged")
        now=max(int(time.time()),old["updated_epoch"] if old else 0)
        new = {
            "tenant":tenant,"project_id":project_id,
            id_field:subject_id,value_field:hours,
            "version":expected_version+1,"updated_by":actor,
            "updated_epoch":now,
        }
        if old is None:
            db.execute(
                f"""INSERT INTO {table}(
                    tenant,project_id,{id_field},{value_field},version,
                    updated_by,updated_epoch,row_digest)
                    VALUES(?,?,?,?,?,?,?,?)""",
                (tenant,project_id,subject_id,hours,1,actor,now,digest(new)),
            )
        else:
            changed=db.execute(
                f"""UPDATE {table} SET {value_field}=?,version=?,
                    updated_by=?,updated_epoch=?,row_digest=?
                    WHERE tenant=? AND project_id=? AND {id_field}=?
                    AND version=? AND row_digest=?""",
                (hours,new["version"],actor,now,digest(new),
                 tenant,project_id,subject_id,old["version"],digest(old)),
            ).rowcount
            if changed != 1:
                raise ForecastDenied("Concurrent resource change rejected")
        _audit(db,old=old,new=new,subject_type=kind,actor=actor)
        out = {
            "subject": subject_id,"type":kind,
            "hours":hours,"version":new["version"],
            "persisted_locally":True,"production_published":False,
        }
        runtime.records._remember(db,tenant,project_id,idempotency_key,request,out)
        return out


def set_effort(runtime: "LocalAppRuntime", *, tenant: str,project_id: str,
               actor: str,task_id: str,effort_hours: int,
               expected_version: int,idempotency_key: str) -> dict:
    return _modify(runtime,tenant=tenant,project_id=project_id,actor=actor,
                   subject_id=task_id,hours=effort_hours,
                   expected_version=expected_version,
                   idempotency_key=idempotency_key,capacity=False)


def set_capacity(runtime: "LocalAppRuntime", *, tenant: str,project_id: str,
                 actor: str,worker: str,hours_per_day: int,
                 expected_version: int,idempotency_key: str) -> dict:
    return _modify(runtime,tenant=tenant,project_id=project_id,actor=actor,
                   subject_id=worker,hours=hours_per_day,
                   expected_version=expected_version,
                   idempotency_key=idempotency_key,capacity=True)


def _business_day(day: date) -> date:
    while day.weekday() >= 5:
        day += timedelta(days=1)
    return day


def _after(day: date) -> date:
    return _business_day(day + timedelta(days=1))


def _finish(start: date, days: int) -> date | None:
    # Avoid claiming a date outside the supported two-year planning horizon.
    current=start
    for _ in range(days-1):
        current=_after(current)
    return current


def project_forecast(runtime: "LocalAppRuntime", *, tenant: str,
                     project_id: str, actor: str) -> dict:
    with runtime.drafts._db() as db:
        role=_principal(runtime,db,tenant,project_id,actor,"task.manage")
        tasks=_visible(db,tenant,project_id,actor,role)
        if len(tasks)>MAX_REPORT_TASKS:
            raise ForecastDenied("Forecast requires a smaller project scope")
        task_map={task["task_id"]:task for task in tasks}
        effort_rows=db.execute(
            """SELECT * FROM director_task_effort
               WHERE tenant=? AND project_id=? LIMIT ?""",
            (tenant,project_id,MAX_REPORT_TASKS+1)).fetchall()
        capacities=db.execute(
            """SELECT * FROM director_worker_capacity
               WHERE tenant=? AND project_id=? LIMIT ?""",
            (tenant,project_id,MAX_REPORT_TASKS+1)).fetchall()
        if len(effort_rows)>MAX_REPORT_TASKS or len(capacities)>MAX_REPORT_TASKS:
            raise ForecastDenied("Resource inputs exceed reporting bounds")
        effort={}
        for raw in effort_rows:
            e=_checked(raw,capacity=False)
            if e["task_id"] not in task_map:
                raise ForecastDenied("Orphaned effort input")
            effort[e["task_id"]]=e
        capacity={}
        for raw in capacities:
            e=_checked(raw,capacity=True)
            capacity[e["worker"]]=e
        members=db.execute(
            """SELECT actor,role,active FROM app_memberships
               WHERE tenant=? AND project_id=? LIMIT ?""",
            (tenant,project_id,MAX_REPORT_TASKS+1)).fetchall()
        if len(members)>MAX_REPORT_TASKS:
            raise ForecastDenied("Member list exceeds planning bound")
        active={m["actor"] for m in members if m["active"]==1}
        graph=_all_edges(db,tenant,project_id)
        if any(child not in task_map or
               any(pred not in task_map for pred in before)
               for child,before in graph.items()):
            raise ForecastDenied("Dangling or cross-project prerequisite")
        # Conservative resource safety: if any open task lacks effort or is
        # blocked, all its assignee's serial workload is indeterminate.
        incomplete_workers=set()
        open_items=[t for t in tasks if t["status"]!="done"]
        for t in open_items:
            if t["assignee"] is not None and (
                t["task_id"] not in effort or t["status"]=="blocked"):
                incomplete_workers.add(t["assignee"])
        successors={tid:set() for tid in task_map}
        remaining={tid:len(graph.get(tid,set())) for tid in task_map}
        for child,befores in graph.items():
            for pred in befores:
                successors[pred].add(child)
        weight={"urgent":0,"high":1,"normal":2,"low":3}
        def ranking(tid):
            t=task_map[tid]
            return (t["due_date"] or "9999-12-31",weight[t["priority"]],tid)
        ready=[]
        for tid,degree in remaining.items():
            if degree==0:heapq.heappush(ready,ranking(tid))
        as_of=datetime.now(timezone.utc).date()
        today=_business_day(as_of)
        resource_next:dict[str,date]={}
        scheduled:dict[str,dict]={}
        processed=0
        for _ in range(len(task_map)):
            if not ready:break
            _,__,tid=heapq.heappop(ready)
            task=task_map[tid]
            prior=graph.get(tid,set())
            result={
                "task_id":tid,"title":task["title"],
                "assignee":task["assignee"],"due_date":task["due_date"],
                "status":task["status"],"priority":task["priority"],
                "effort_hours":effort[tid]["effort_hours"] if tid in effort else None,
                "estimated_start":None,"estimated_finish":None,
                "estimated_workdays":None,"variance_calendar_days":None,
                "state":"unforecastable",
            }
            if task["status"]=="done":
                result["state"]="completed"
            elif task["status"]=="blocked":
                result["state"]="blocked_status"
            elif task["assignee"] is None:
                result["state"]="unassigned"
            elif task["assignee"] not in active:
                result["state"]="inactive_assignee"
            elif task["assignee"] not in capacity:
                result["state"]="capacity_missing"
            elif task["assignee"] in incomplete_workers:
                result["state"]="incomplete_assignee_inputs"
            elif tid not in effort:
                result["state"]="effort_missing"
            elif any(task_map[pred]["status"]!="done" and
                     scheduled[pred]["estimated_finish"] is None for pred in prior):
                result["state"]="prerequisite_unforecastable"
            else:
                release=today
                for pred in prior:
                    if task_map[pred]["status"]!="done":
                        release=max(release,_after(date.fromisoformat(
                            scheduled[pred]["estimated_finish"])))
                earliest=max(release,resource_next.get(task["assignee"],today))
                duration=math.ceil(effort[tid]["effort_hours"]/
                                   capacity[task["assignee"]]["hours_per_day"])
                finish=_finish(earliest,duration)
                if (finish-as_of).days>MAX_HORIZON_DAYS:
                    result["state"]="beyond_2_year_horizon"
                else:
                    result.update({
                        "state":"scheduled","estimated_start":earliest.isoformat(),
                        "estimated_finish":finish.isoformat(),
                        "estimated_workdays":duration,
                    })
                    if task["due_date"]:
                        result["variance_calendar_days"]=(
                            finish-date.fromisoformat(task["due_date"])).days
                    resource_next[task["assignee"]]=_after(finish)
            scheduled[tid]=result
            processed+=1
            for dependent in successors[tid]:
                remaining[dependent]-=1
                if remaining[dependent]==0:
                    heapq.heappush(ready,ranking(dependent))
        if processed!=len(task_map):
            raise ForecastDenied("Dependency cycle detected while forecasting")
        # Milestone exposure is calculated from saved links and baseline; no
        # conclusion is inferred for milestones without linked/forecastable work.
        _,milestones=_phase_and_milestones(db,tenant,project_id)
        milestones_out=[]
        for mile in milestones:
            if mile["completed_on"] is not None or mile["linked_task_id"] is None:
                continue
            task=scheduled.get(mile["linked_task_id"])
            if task is None:
                raise ForecastDenied("Milestone references a foreign or missing task")
            task_done=task["state"]=="completed"
            forecast=task["estimated_finish"]
            slip=(date.fromisoformat(forecast)-date.fromisoformat(
                mile["forecast_due"])).days if forecast else None
            milestones_out.append({
                "milestone_id":mile["milestone_id"],"name":mile["name"],
                "linked_task_id":mile["linked_task_id"],
                "baseline_due":mile["baseline_due"],
                "current_forecast_due":mile["forecast_due"],
                "task_estimated_finish":forecast,
                "state":"ready_for_confirmation" if task_done else
                    ("unforecastable" if forecast is None else
                     "potential_slip" if slip>0 else "within_forecast"),
                "potential_slip_days":slip,
            })
        output=sorted(scheduled.values(),key=lambda x:(
            x["estimated_finish"] is None,
            x["estimated_finish"] or "9999-12-31",x["task_id"]))
        open_results=[x for x in output if x["status"]!="done"]
        forecastable=[x for x in open_results if x["state"]=="scheduled"]
        missing=[x for x in open_results if x["state"]!="scheduled"]
        latest=max((x["estimated_finish"] for x in forecastable),default=None)
        return {
            "as_of_utc":as_of.isoformat(),
            "policy":{
                "workdays":"Monday-Friday UTC; public holidays not modeled",
                "resource_model":"One serial task per assignee; due-date priority",
                "inputs":"Only explicit effort hours and team hours per workday",
                "horizon_days":MAX_HORIZON_DAYS,
                "no_predictive_model":True,
            },
            "capacities":[{
                "worker":x["worker"],"hours_per_day":x["hours_per_day"],
                "version":x["version"],"active":x["worker"] in active}
                for x in sorted(capacity.values(),key=lambda c:c["worker"])],
            "efforts":[{
                "task_id":x["task_id"],"effort_hours":x["effort_hours"],
                "version":x["version"]} for x in
                sorted(effort.values(),key=lambda t:t["task_id"])],
            "tasks":output,
            "milestone_exposure":milestones_out,
            "metrics":{
                "open_tasks":len(open_items),
                "scheduled_tasks":len(forecastable),
                "unforecastable_tasks":len(missing),
                "at_risk_tasks":sum((x["variance_calendar_days"] or 0)>0
                                    for x in forecastable),
                "at_risk_milestones":sum(m["state"]=="potential_slip"
                                          for m in milestones_out),
                "potential_finish":latest if not missing and open_items else None,
                "coverage_complete":not missing,
            },
            "local_only":True,"production_published":False,
        }


def forecast_history(runtime: "LocalAppRuntime", *, tenant: str,
                     project_id: str, actor: str, limit: int=30) -> dict:
    _positive_int(limit,label="History page size",minimum=1,maximum=50)
    with runtime.drafts._db() as db:
        _principal(runtime,db,tenant,project_id,actor,"task.manage")
        rows=db.execute(
            """SELECT * FROM director_forecast_events
               WHERE tenant=? AND project_id=?
               ORDER BY at_epoch DESC,event_id DESC LIMIT ?""",
            (tenant,project_id,limit)).fetchall()
        result=[]
        for row in rows:
            try:
                event=json.loads(row["event_json"])
            except (ValueError,TypeError) as exc:
                raise ForecastDenied("Unreadable forecast audit event") from exc
            if (digest(event)!=row["event_digest"] or
                canonical(event).decode("utf-8")!=row["event_json"] or
                event.get("schema")!=SCHEMA or
                any(event.get(key)!=row[key] for key in (
                    "event_id","tenant","project_id","subject_id",
                    "subject_type","actor","version","at_epoch"))):
                raise ForecastDenied("Forecast history integrity failure")
            result.append({
                "subject_id":event["subject_id"],"subject_type":event["subject_type"],
                "version":event["version"],"actor":event["actor"],
                "at_epoch":event["at_epoch"],"sha256":row["event_digest"],
            })
        return {"events":result,"immutable":True,"local_only":True}
