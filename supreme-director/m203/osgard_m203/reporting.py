"""M203 executive action accountability and safe UTF-8 CSV export.

Counts come from tenant-scoped SQLite records; no invented uplift, causality
claim, direct bank balance, payment or independent acceptance is asserted.
"""
from __future__ import annotations

from collections import Counter
import csv
import io

from osgard_m192.runtime import Invalid
from osgard_m202.runtime import _plain_csv
from .plans import expose_plan, verified_events

MAX_PLANS=500


def management_report(db,identity,now):
    tenant=identity["tenant_id"]
    rows=db.execute(
        """SELECT * FROM financial_action_plans
           WHERE tenant_id=? ORDER BY created_at DESC,id DESC
           LIMIT ?""",(tenant,MAX_PLANS+1)
    ).fetchall()
    if len(rows)>MAX_PLANS:
        raise Invalid("over 500 plans, report refused rather than silently truncated")
    statuses=Counter()
    overdue=0
    tasks_done=0
    tasks_total=0
    active_without_steps=0
    completed_model_reviews=0
    actions=[]
    for row in rows:
        verified_events(db,tenant,row["id"])
        item=expose_plan(db,tenant,row)
        statuses[item["status"]]+=1
        tasks_done+=item["done_steps"]
        tasks_total+=item["total_steps"]
        if (item["status"]=="active" and item["due_at"]<now):
            overdue+=1
        if item["status"]=="active" and item["total_steps"]==0:
            active_without_steps+=1
        if item["status"]=="model_reviewed":
            completed_model_reviews+=1
        # Summarize all step links; financial target remains hypothesis only.
        actions.append(item)
    return {
        "schema":"osgard.m203.accountability/1",
        "generated_at":now,
        "tenant_id":tenant,
        "plan_count":len(rows),
        "statuses":{status:statuses[status] for status in
                   ("draft","active","model_reviewed","cancelled")},
        "overdue_active_plan_count":overdue,
        "active_without_steps":active_without_steps,
        "task_count":tasks_total,
        "task_completed_count":tasks_done,
        "model_reviewed_count":completed_model_reviews,
        "items":actions,
        "currency":"RUB","money_unit":"kopecks",
        "financial_outcome_proven":False,
        "causation_proven":False,"bank_verified":False,
        "independent_audit_complete":False,
        "production_authorized":False,
        "original_tasks_independently_accepted":0,
        "warnings":[
            "Task completion is not financial impact.",
            "Compared values are manually entered or locally modeled.",
            "An owner's acceptance is a review of model evidence, not bank audit.",
            "M203 does not initiate payments or external notifications.",
        ]
    }


def export_report(db,identity,now):
    report=management_report(db,identity,now)
    output=io.StringIO(newline="")
    writer=csv.writer(output,delimiter=";",lineterminator="\r\n")
    writer.writerow((
        "План ID","Название","Правило","Статус","Гипотеза",
        "Начальное значение","Цель","Направление",
        "Дедлайн UTC epoch","Создан UTC epoch",
        "Всего задач","Завершено задач","Последнее наблюдение",
        "Вывод модели","Самоподтверждение владельца","Доказанная прибыль"
    ))
    for p in report["items"]:
        latest=p["latest_evaluation"] or {}
        writer.writerow([_plain_csv(v) for v in [
            p["id"],p["title"],p["rule"],p["status"],p["hypothesis"],
            p["baseline_value"],p["target_value"],p["direction"],
            p["due_at"],p["created_at"],p["total_steps"],p["done_steps"],
            latest.get("observed_value"),latest.get("judgement"),
            p["status"]=="model_reviewed",False
        ]])
    return {
        "filename":"osgard-m203-action-results.csv",
        "mime":"text/csv; charset=utf-8",
        "content":"\ufeff"+output.getvalue(),
        "rows":len(report["items"]),
        "formula_injection_guard":True,
        "financial_outcome_proven":False,
        "bank_verified":False,"production_authorized":False,
    }
