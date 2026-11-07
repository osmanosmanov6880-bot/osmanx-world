"""Wave 26 / feature 5: bounded, formula-safe CSV from verified evidence.

No export is ever generated from user-submitted status values. The monitoring
report verifies tenant scope, application receipt and the checkpoint SHA chain.
Strings beginning with spreadsheet formula triggers are prefixed with a single
apostrophe before CSV quoting; UTF-8 BOM makes Russian text legible in Excel.
"""
from __future__ import annotations

import csv
import hashlib
import io
from typing import TYPE_CHECKING, Any

from .scenario_monitoring import monitoring_report

if TYPE_CHECKING:
    from .app_runtime import LocalAppRuntime

HEADERS=(
    "type","scenario_id","sequence","observed_on_utc","task_id",
    "title","status","assignee","due_date","forecast_finish",
    "forecast_state","variance_days","completed_count","open_count",
    "blocked_count","risk_code","risk_severity","risk_message",
    "source_sha256",
)


def _safe(value:Any)->str:
    if value is None:return ""
    if type(value) is bool:return "true" if value else "false"
    s=str(value)
    leading=s.lstrip()
    if leading and leading[0] in "=+-@\t\r\n":
        return "'"+s
    if s.startswith(("\t","\r","\n")):
        return "'"+s
    return s


def _write_csv(report:dict)->tuple[str,int]:
    memory=io.StringIO(newline="")
    writer=csv.DictWriter(memory,fieldnames=HEADERS,
                          lineterminator="\r\n",extrasaction="raise")
    writer.writeheader()
    count=0
    scenario=report["scenario_id"]

    def add(**kwargs):
        nonlocal count
        data={"type":kwargs.pop("type"),
              "scenario_id":scenario,
              **kwargs}
        writer.writerow({key:_safe(data.get(key)) for key in HEADERS})
        count+=1

    for p in report["series"]:
        add(type="checkpoint",sequence=p["sequence"],
            observed_on_utc=p["observed_on_utc"],
            completed_count=p["done"],
            open_count=p["open"],blocked_count=p["blocked"],
            forecast_finish=p["forecast_finish"],
            source_sha256=p["sha256"])
    for t in report["affected_tasks"]:
        add(type="task_current",
            observed_on_utc=report["as_of_utc"],
            task_id=t["task_id"],title=t["title"],
            status=t["status"],assignee=t["assignee"],
            due_date=t["due_date"],
            forecast_finish=t["forecast_finish"],
            forecast_state=t["forecast_state"],
            variance_days=t["variance_calendar_days"],
            source_sha256=report["source_snapshot"])
    for risk in report["risks"]:
        add(type="risk",
            observed_on_utc=report["as_of_utc"],
            task_id=risk["task_id"],risk_code=risk["code"],
            risk_severity=risk["severity"],
            risk_message=risk["message"],
            source_sha256=report["source_snapshot"])
    return "\ufeff"+memory.getvalue(),count


def export_monitor_csv(runtime:"LocalAppRuntime",*,tenant:str,project_id:str,
                       actor:str,scenario_id:str)->dict:
    report=monitoring_report(runtime,tenant=tenant,project_id=project_id,
                             actor=actor,scenario_id=scenario_id)
    content,row_count=_write_csv(report)
    encoded=content.encode("utf-8")
    return {
        "filename":"osgard_outcome_"+scenario_id[:8]+".csv",
        "csv":content,
        "mime":"text/csv; charset=utf-8",
        "sha256":hashlib.sha256(encoded).hexdigest(),
        "bytes":len(encoded),
        "rows":row_count,
        "verified_history":report["history_chain_verified"],
        "source_snapshot":report["source_snapshot"],
        "generated_on_utc":report["as_of_utc"],
        "local_only":True,"production_published":False,
    }
