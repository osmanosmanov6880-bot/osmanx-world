"""M206 owner-only evidence packet, portfolio and safe CSV export.

Packets contain reproducible local source hash references. They are not a
signature, independently anchored audit or verified financial statement.
"""
from __future__ import annotations

import csv
import io

from osgard_m192.runtime import Invalid, _object
from osgard_m202.runtime import _plain_csv

from .diagnostics import latest,history
from .forecast_quality import list_baselines,backtest
from .journal import digest


def packet(db,tenant,p,now):
    _object(p,{"plan_id"})
    scan=latest(db,tenant,{"plan_id":p["plan_id"]})
    scans=history(db,tenant,{"plan_id":p["plan_id"],"limit":100})
    forecasts=list_baselines(db,tenant,{"plan_id":p["plan_id"]})
    tests=[backtest(db,tenant,{"baseline_id":x["baseline_id"]})
           for x in forecasts["items"]]
    payload={
        "schema":"osgard.m206.evidence-packet/1",
        "tenant_id":tenant,
        "plan_id":p["plan_id"],
        "exported_at":now,
        "latest_diagnostic":scan,
        "diagnostic_history":scans,
        "frozen_forecasts":forecasts,
        "manual_outcome_reviews":tests,
        "bank_verified":False,
        "source_data_unverified":True,
        "external_anchor":False,
        "independent_audit":False,
        "production_authorized":False,
        "limitations":[
            "All source records remain local and are not independently signed.",
            "Owner acknowledgement only records review, not resolution.",
            "Owner-reported monthly outcomes do not prove actual collected revenue.",
            "Forecast error is based only on observed months, not missing months.",
        ],
    }
    return {
        "packet":payload,
        "sha256":digest(payload),
        "sha_is_not_signature":True,
        "external_anchor":False,
        "bank_verified":False,
    }


def portfolio(db,tenant,now):
    plans=db.execute(
        """SELECT id,title,status,created_at FROM financial_action_plans
           WHERE tenant_id=? ORDER BY created_at,id LIMIT 201""",
        (tenant,)
    ).fetchall()
    if len(plans)>200:
        raise Invalid("M206 portfolio supports at most 200 plans per export")
    items=[]
    for plan in plans:
        current=latest(db,tenant,{"plan_id":plan["id"]})
        forecasts=list_baselines(db,tenant,{"plan_id":plan["id"]})
        items.append({
            "plan_id":plan["id"],"title":plan["title"],
            "status":plan["status"],"last_diagnostic_at":
                current.get("captured_at"),
            "scan_status":"CAPTURED" if current["exists"] else "NOT_SCANNED",
            "warning_count":(
                current["snapshot"]["counts"]["warning"]
                if current["exists"] else None
            ),
            "review_count":(
                current["snapshot"]["counts"]["review"]
                if current["exists"] else None
            ),
            "acknowledged_not_resolved":(
                len(current["acknowledged_finding_ids"])
                if current["exists"] else None
            ),
            "frozen_baselines":forecasts["total"],
            "bank_verified":False,
        })
    return {
        "schema":"osgard.m206.assurance-portfolio/1",
        "tenant_id":tenant,"generated_at":now,
        "plans_total":len(items),"items":items,
        "not_scanned_is_not_clean":True,
        "acknowledged_is_not_resolved":True,
        "external_anchor":False,"bank_verified":False,
    }


def export_csv(db,tenant,now):
    data=portfolio(db,tenant,now)
    buf=io.StringIO(newline="")
    writer=csv.writer(buf,delimiter=";",lineterminator="\r\n")
    writer.writerow([
        "ID плана","Название","Статус","Диагностика",
        "Предупреждения","Ручная проверка требуется",
        "Подтверждено прочтение (не исправлено)",
        "Зафиксированных прогнозов","Подтверждено банком",
    ])
    for row in data["items"]:
        writer.writerow([_plain_csv(x) for x in (
            row["plan_id"],row["title"],row["status"],
            row["scan_status"],row["warning_count"],row["review_count"],
            row["acknowledged_not_resolved"],row["frozen_baselines"],False
        )])
    return {
        "filename":"osgard-m206-assurance-portfolio.csv",
        "mime":"text/csv; charset=utf-8",
        "content":"\ufeff"+buf.getvalue(),
        "rows":len(data["items"]),
        "formula_injection_guard":True,
        "bank_verified":False,"external_anchor":False,
    }
