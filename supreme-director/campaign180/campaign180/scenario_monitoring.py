"""Wave 26 / feature 3+4: observed task progress, forecast variance and rules.

Separates observed database facts from modeled future dates. "done" is a live
task status, not external proof of delivery or a reconstructed completion date.
Risk findings are deterministic checks; there is no polling, AI scoring, or
phantom economic performance estimate.
"""
from __future__ import annotations

from datetime import date,datetime,timezone
from typing import TYPE_CHECKING

from .resource_forecast import _project_forecast_db
from .scenario_library import _uuid
from .scenario_outcomes import summarize
from .scenario_checkpoints import _application,_observe,_snapshot_chain
from .team_tasks import _principal

if TYPE_CHECKING:
    from .app_runtime import LocalAppRuntime


def _counts(tasks:list[dict],as_of:date)->dict:
    return {
        "total":len(tasks),
        "done":sum(t["status"]=="done" for t in tasks),
        "in_progress":sum(t["status"]=="in_progress" for t in tasks),
        "blocked":sum(t["status"]=="blocked" for t in tasks),
        "todo":sum(t["status"]=="todo" for t in tasks),
        "overdue_open":sum(
            t["status"]!="done" and t["due_date"] is not None
            and date.fromisoformat(t["due_date"])<as_of for t in tasks),
    }


def _risk_rules(tasks:list[dict],application:dict,
                as_of:date,chain:list[dict],rolled_back:bool)->list[dict]:
    if rolled_back:return []
    applied={x["task_id"]:x for x in application["task_changes"]}
    alerts=[]
    for t in tasks:
        base=applied[t["task_id"]]
        task=t["task_id"]
        if t["assignee"]!=base["after_assignee"]:
            alerts.append({
                "code":"ASSIGNEE_CHANGED","severity":"medium",
                "task_id":task,
                "message":"Фактический исполнитель отличается от назначения по выбранному плану",
                "evidence":{
                    "expected_assignee":base["after_assignee"],
                    "observed_assignee":t["assignee"],
                },
            })
        if t["status"]=="done":
            continue
        if t["status"]=="blocked":
            alerts.append({
                "code":"TASK_BLOCKED","severity":"high","task_id":task,
                "message":"Задача отмечена как заблокированная",
                "evidence":{"status":"blocked","task_version":t["version"]},
            })
        if t["due_date"] is not None:
            due=date.fromisoformat(t["due_date"])
            if due<as_of:
                alerts.append({
                    "code":"TASK_OVERDUE","severity":"high","task_id":task,
                    "message":"Срок задачи уже прошёл, а статус не завершён",
                    "evidence":{"due_date":t["due_date"],
                                "days_overdue":(as_of-due).days},
                })
        if t["forecast_finish"] is None:
            alerts.append({
                "code":"FORECAST_MISSING","severity":"medium","task_id":task,
                "message":"Невозможно вычислить срок этой открытой задачи",
                "evidence":{"forecast_state":t["forecast_state"]},
            })
        elif (t["variance_calendar_days"] is not None
                and t["variance_calendar_days"]>0):
            alerts.append({
                "code":"FORECAST_LATE","severity":"medium","task_id":task,
                "message":"Расчётный срок позже планового срока задачи",
                "evidence":{"forecast_finish":t["forecast_finish"],
                            "variance_days":t["variance_calendar_days"]},
            })
    # This signal is only about missing manual check-ins, NOT proof that the
    # team has made no progress.
    reference=datetime.fromtimestamp(
        chain[-1]["created_epoch"] if chain else application["at_epoch"],
        timezone.utc).date()
    if (as_of-reference).days>=7:
        alerts.append({
            "code":"CHECKPOINT_STALE","severity":"low","task_id":None,
            "message":"Контрольный замер не выполнялся семь и более календарных дней",
            "evidence":{"last_observed_on":reference.isoformat(),
                        "days_since_check":(as_of-reference).days},
        })
    return sorted(alerts,key=lambda x:(
        {"high":0,"medium":1,"low":2}[x["severity"]],
        x["task_id"] or "",x["code"]))


def _observed_series(chain:list[dict],as_of:date)->list[dict]:
    return [{
        "sequence":p["sequence"],
        "at_epoch":p["created_epoch"],
        "observed_on_utc":p["observed_on_utc"],
        "source_snapshot":p["source_snapshot"],
        "done":_counts(p["task_observations"],
                       date.fromisoformat(p["observed_on_utc"]))["done"],
        "blocked":_counts(p["task_observations"],
                          date.fromisoformat(p["observed_on_utc"]))["blocked"],
        "open":sum(t["status"]!="done" for t in p["task_observations"]),
        "forecast_finish":p["metrics"]["potential_finish"],
        "forecast_risks":p["metrics"]["at_risk_tasks"],
        "sha256":p["sha256"],
    } for p in chain]


def monitoring_report(runtime:"LocalAppRuntime",*,tenant:str,
                      project_id:str,actor:str,scenario_id:str)->dict:
    _uuid(scenario_id)
    with runtime.drafts._db() as db:
        db.execute("BEGIN")  # one consistent read for all task/checkpoint facts
        _principal(runtime,db,tenant,project_id,actor,"task.manage")
        scenario,application,rollback=_application(
            db,tenant,project_id,scenario_id)
        chain=_snapshot_chain(db,tenant,project_id,scenario_id)
        forecast=_project_forecast_db(
            runtime,db,tenant=tenant,project_id=project_id,actor=actor)
        tasks=_observe(db,tenant=tenant,project_id=project_id,
                       applied=application,forecast=forecast)
        as_of=date.fromisoformat(forecast["as_of_utc"])
        baseline=application["metrics_after"]
        current=summarize(forecast)
        expected=baseline["potential_finish"]
        observed=current["potential_finish"]
        finish_delta=(date.fromisoformat(observed)-
                      date.fromisoformat(expected)).days \
            if expected and observed else None
        task_counts=_counts(tasks,as_of)
        risks=_risk_rules(tasks,application,as_of,chain,rollback is not None)
        numeric=("at_risk_tasks","at_risk_milestones",
                 "unforecastable_tasks","overloaded_workers")
        delta={k:current[k]-baseline[k] for k in numeric}
        first=chain[0] if chain else None
        last=chain[-1] if chain else None
        progress_diff=(
            _counts(last["task_observations"],as_of)["done"]-
            _counts(first["task_observations"],as_of)["done"]
            if first is not None and last is not None else None
        )
        return {
            "scenario_id":scenario_id,"scenario_title":scenario["title"],
            "as_of_utc":forecast["as_of_utc"],
            "effective_status":"rolled_back" if rollback else "applied",
            "application_sha256":application["sha256"],
            "applied_at_epoch":application["at_epoch"],
            "source_snapshot":forecast["input_snapshot"],
            "last_checkpoint_sha256":last["sha256"] if last else None,
            "last_checkpoint_epoch":last["created_epoch"] if last else None,
            "checkpoint_count":len(chain),
            "history_chain_verified":True,
            "applied_project_metrics":baseline,
            "current_project_metrics":current,
            "metric_delta_since_apply":delta,
            "projected_finish_shift_calendar_days":finish_delta,
            "project_finish_comparable":finish_delta is not None,
            "affected_tasks":tasks,
            "affected_progress":task_counts,
            "observed_done_count_change_first_to_last":progress_diff,
            "series":_observed_series(chain,as_of),
            "risks":risks,
            "risk_counts":{
                "high":sum(x["severity"]=="high" for x in risks),
                "medium":sum(x["severity"]=="medium" for x in risks),
                "low":sum(x["severity"]=="low" for x in risks),
            },
            "interpretation":{
                "actual_source":"Current SQLite task status and assignment; no external proof",
                "forecast_source":"Wave22 deterministic resource model, not actual completion date",
                "finish_delta":"Forecast date compared with recorded application-time forecast",
                "checkpoints":"Only manager-triggered captures; no automatic polling",
                "after_rollback":"Old checkpoints retained; alerts suppressed for rolled-back plans",
            },
            "local_only":True,"production_published":False,
        }
