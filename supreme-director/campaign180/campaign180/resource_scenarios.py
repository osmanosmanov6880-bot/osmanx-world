"""Wave 23 — safe, non-persistent what-if task reassignment and overload analysis.

Comparison happens against one read-only SQLite snapshot. No assignment,
capacity, effort, milestone or task revision is ever written by this API.
All results use the exact Wave 22 deterministic scheduler for comparability.
"""
from __future__ import annotations

from datetime import date, datetime, timedelta, timezone
import math
from typing import TYPE_CHECKING, Any

from .contracts import ACTOR_RE
from .resource_forecast import ForecastDenied, _project_forecast_db
from .team_tasks import TaskDenied, _eligible, _principal

if TYPE_CHECKING:
    from .app_runtime import LocalAppRuntime

MAX_MOVES = 20
BACKLOG_HORIZON_WORKDAYS = 10


class ScenarioDenied(ForecastDenied):
    """Unsafe speculative assignment or stale real-data snapshot."""


def _workload(report: dict) -> list[dict]:
    """Per-person backlog relative to a fixed 10-day capacity window.

    10-day pressure describes the *entire remaining backlog*, not an assertion
    that all tasks are due within that horizon. No pressure is inferred where
    effort or productive hours are not both explicitly recorded.
    """
    capacity={x["worker"]:x for x in report["capacities"]}
    people:dict[str,dict] = {}
    for task in report["tasks"]:
        if task["status"]=="done" or task["assignee"] is None:
            continue
        worker=task["assignee"]
        row=people.setdefault(worker,{
            "worker":worker,
            "open_tasks":0,
            "estimated_hours":0,
            "unknown_estimates":0,
            "late_tasks":0,
            "scheduled_tasks":0,
            "unforecastable_tasks":0,
            "projected_last_finish":None,
        })
        row["open_tasks"]+=1
        if task["effort_hours"] is None:
            row["unknown_estimates"]+=1
        else:
            row["estimated_hours"]+=task["effort_hours"]
        if task["state"]=="scheduled":
            row["scheduled_tasks"]+=1
            ending=task["estimated_finish"]
            if row["projected_last_finish"] is None or ending>row["projected_last_finish"]:
                row["projected_last_finish"]=ending
            if (task["variance_calendar_days"] is not None
                    and task["variance_calendar_days"]>0):
                row["late_tasks"]+=1
        else:
            row["unforecastable_tasks"]+=1
    for worker, cap in capacity.items():
        people.setdefault(worker,{
            "worker":worker,"open_tasks":0,"estimated_hours":0,
            "unknown_estimates":0,"late_tasks":0,"scheduled_tasks":0,
            "unforecastable_tasks":0,"projected_last_finish":None,
        })
    output=[]
    for worker in sorted(people):
        row=people[worker]
        cap=capacity.get(worker)
        hours=cap["hours_per_day"] if cap and cap["active"] else None
        known=row["unknown_estimates"]==0 and hours is not None
        row.update({
            "active":cap["active"] if cap else None,
            "hours_per_day":hours,
            "backlog_workdays":math.ceil(row["estimated_hours"]/hours)
            if known else None,
            "backlog_pressure_10d_percent":round(
                100*row["estimated_hours"]/(hours*BACKLOG_HORIZON_WORKDAYS))
                if known else None,
            "overloaded_10d":(row["estimated_hours"] >
                             hours*BACKLOG_HORIZON_WORKDAYS)
                             if known else None,
        })
        output.append(row)
    return output


def _compact(report: dict) -> dict:
    members=_workload(report)
    metrics=report["metrics"]
    return {
        "metrics":{
            "open_tasks":metrics["open_tasks"],
            "scheduled_tasks":metrics["scheduled_tasks"],
            "unforecastable_tasks":metrics["unforecastable_tasks"],
            "at_risk_tasks":metrics["at_risk_tasks"],
            "at_risk_milestones":metrics["at_risk_milestones"],
            "potential_finish":metrics["potential_finish"],
            "coverage_complete":metrics["coverage_complete"],
            "overloaded_workers":sum(x["overloaded_10d"] is True for x in members),
            "unknown_load_workers":sum(
                x["overloaded_10d"] is None and x["open_tasks"]>0
                for x in members),
        },
        "workers":members,
    }


def workload_report(runtime: "LocalAppRuntime", *, tenant: str,
                    project_id: str, actor: str) -> dict:
    report=runtime.project_resource_forecast(
        tenant=tenant,project_id=project_id,actor=actor)
    result=_compact(report)
    return {
        **result,
        "input_snapshot":report["input_snapshot"],
        "as_of_utc":report["as_of_utc"],
        "model":{
            "horizon_workdays":BACKLOG_HORIZON_WORKDAYS,
            "capacity_units":"productive hours per weekday",
            "pressure_means":"all open backlog / 10 working days capacity",
            "holidays_not_modeled":True,
            "missing_inputs_are_unknown":True,
        },
        "local_only":True,
        "production_published":False,
    }


def compare_reassignment(runtime: "LocalAppRuntime", *, tenant: str,
                         project_id: str, actor: str,
                         expected_snapshot: str,
                         moves: list[dict]) -> dict:
    if (type(expected_snapshot) is not str or len(expected_snapshot)!=64 or
        any(x not in "0123456789abcdef" for x in expected_snapshot)):
        raise ScenarioDenied("Exact current forecast snapshot required")
    if type(moves) is not list or not 1<=len(moves)<=MAX_MOVES:
        raise ScenarioDenied("Scenario needs 1–20 proposed reassignments")
    proposed={}
    for move in moves:
        if (type(move) is not dict or set(move)!={"task_id","assignee"}
                or type(move["task_id"]) is not str
                or type(move["assignee"]) is not str
                or not ACTOR_RE.fullmatch(move["assignee"])):
            raise ScenarioDenied("Invalid scenario move")
        task_id=move["task_id"]
        if task_id in proposed:
            raise ScenarioDenied("Duplicate task reassignment")
        proposed[task_id]=move["assignee"]
    with runtime.drafts._db() as db:
        db.execute("BEGIN")  # both forecasts see the same SQLite read snapshot
        _principal(runtime,db,tenant,project_id,actor,"task.manage")
        original=_project_forecast_db(runtime,db,
                                       tenant=tenant,project_id=project_id,
                                       actor=actor)
        if original["input_snapshot"]!=expected_snapshot:
            raise ScenarioDenied("Source data changed; refresh forecast first")
        task_map={x["task_id"]:x for x in original["tasks"]}
        for tid,worker in proposed.items():
            if tid not in task_map or task_map[tid]["status"]=="done":
                raise ScenarioDenied("Only existing open tasks can be moved")
            if task_map[tid]["assignee"]==worker:
                raise ScenarioDenied("Scenario cannot contain a no-op reassignment")
            try:
                _eligible(db,tenant,project_id,worker)
            except TaskDenied as exc:
                raise ScenarioDenied("Proposed worker must be an active task member") from exc
        alternative=_project_forecast_db(runtime,db,
                                          tenant=tenant,project_id=project_id,
                                          actor=actor,overrides=proposed)
        if alternative["input_snapshot"]!=expected_snapshot:
            raise ScenarioDenied("Scenario comparison snapshot drift")
    before=_compact(original)
    after=_compact(alternative)
    baseline_rows={x["task_id"]:x for x in original["tasks"]}
    alternate_rows={x["task_id"]:x for x in alternative["tasks"]}
    changed=[]
    for task_id,target in sorted(proposed.items()):
        a=baseline_rows[task_id]
        b=alternate_rows[task_id]
        changed.append({
            "task_id":task_id,"title":a["title"],
            "old_assignee":a["assignee"],"new_assignee":target,
            "before_state":a["state"],"after_state":b["state"],
            "before_finish":a["estimated_finish"],
            "after_finish":b["estimated_finish"],
        })
    orig_date=before["metrics"]["potential_finish"]
    new_date=after["metrics"]["potential_finish"]
    # No "saved days" claim unless both scenarios have complete coverage.
    delta=(date.fromisoformat(new_date)-date.fromisoformat(orig_date)).days \
        if orig_date and new_date else None
    return {
        "as_of_utc":original["as_of_utc"],
        "input_snapshot":expected_snapshot,
        "baseline":before,
        "scenario":after,
        "moves":changed,
        "comparison":{
            "finish_delta_calendar_days":delta,
            "risk_task_delta":after["metrics"]["at_risk_tasks"]-
                              before["metrics"]["at_risk_tasks"],
            "overload_worker_delta":after["metrics"]["overloaded_workers"]-
                                    before["metrics"]["overloaded_workers"],
            "milestone_risk_delta":after["metrics"]["at_risk_milestones"]-
                                   before["metrics"]["at_risk_milestones"],
            "comparable_project_finish":delta is not None,
        },
        "policy":{
            "simulation_only":True,
            "no_real_assignments_changed":True,
            "no_database_writes":True,
            "same_scheduler":True,
            "horizon_workdays":BACKLOG_HORIZON_WORKDAYS,
            "workdays":"Monday-Friday UTC; holidays not modeled",
            "missing_inputs_are_unknown":True,
            "scenario_is_not_a_delivery_guarantee":True,
        },
        "local_only":True,
        "production_published":False,
    }
