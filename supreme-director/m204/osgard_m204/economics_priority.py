"""M204 transparent, owner-entered priority matrix for financial action plans.

Ranking is only a consistent sort of subjective owner inputs, not an
algorithmic promise of profit or externally validated recommendation.
"""
from __future__ import annotations

from osgard_m192.runtime import Invalid, Conflict, _text, _object
from osgard_m193.runtime import _version
from osgard_m203.plans import find_plan
from .economics_ledger import verify, event, ledger
from .economics_roi import integer

FIELDS=("urgency","impact","effort","confidence")


def assessment(db,tenant,plan_id):
    return db.execute(
        "SELECT * FROM economics_priorities WHERE tenant_id=? AND plan_id=?",
        (tenant,plan_id)
    ).fetchone()


def set_priority(db,identity,p,now):
    _object(p,{"plan_id","expected_version","urgency","impact",
               "effort","confidence","rationale"})
    tenant,actor=identity["tenant_id"],identity["actor"]
    plan=find_plan(db,tenant,p["plan_id"])
    verify(db,tenant,plan["id"])
    values={field:integer(p[field],field,1,5) for field in FIELDS}
    rationale=_text(p["rationale"],"rationale",600)
    if len(rationale)<10:
        raise Invalid("explain prioritization in at least 10 characters")
    prior=assessment(db,tenant,plan["id"])
    version=integer(p["expected_version"],"expected_version",0,1000000)
    if (prior is None and version!=0) or (prior and prior["version"]!=version):
        raise Conflict("priority version changed")
    if prior and all(prior[field]==values[field] for field in FIELDS) and prior["rationale"]==rationale:
        raise Conflict("priority assessment unchanged")
    new_version=version+1
    values.update({"rationale":rationale,"version":new_version,
                   "updated_by":actor,"updated_at":now})
    if prior:
        db.execute(
            """UPDATE economics_priorities
               SET urgency=?,impact=?,effort=?,confidence=?,rationale=?,
                   version=?,updated_by=?,updated_at=?
               WHERE tenant_id=? AND plan_id=?""",
            tuple(values[k] for k in FIELDS)+
            (rationale,new_version,actor,now,tenant,plan["id"])
        )
    else:
        db.execute(
            """INSERT INTO economics_priorities
               (tenant_id,plan_id,urgency,impact,effort,confidence,
                rationale,version,updated_by,updated_at)
               VALUES(?,?,?,?,?,?,?,?,?,?)""",
            (tenant,plan["id"])+tuple(values[k] for k in FIELDS)+
            (rationale,new_version,actor,now)
        )
    head=event(db,tenant,plan["id"],actor,"priority_set",
               {"assessment":values},now)
    return {
        "plan_id":plan["id"],**values,
        "score_x100":values["urgency"]*values["impact"]*values["confidence"]*100//values["effort"],
        "score_formula":"urgency * impact * confidence / effort",
        "score_basis":"OWNER_SUBJECTIVE_INPUTS_ONLY",
        "head":head,"bank_verified":False,
    }


def board(db,tenant,p,now):
    _object(p,set(),{"limit","include_closed"})
    limit=integer(p.get("limit",100),"limit",1,200)
    include_closed=p.get("include_closed",False)
    if type(include_closed) is not bool:
        raise Invalid("include_closed must be boolean")
    data=list(db.execute(
        """SELECT id,title,rule,status,due_at,created_at
           FROM financial_action_plans WHERE tenant_id=?
           ORDER BY created_at,id LIMIT 501""",(tenant,)
    ))
    if len(data)>500:
        raise Invalid("portfolio exceeds 500 plans; paginate or archive")
    rows=[]
    for plan in data:
        if not include_closed and plan["status"] in ("model_reviewed","cancelled"):
            continue
        info=ledger(db,tenant,plan["id"],limit=1)
        priority=assessment(db,tenant,plan["id"])
        sums=info["totals_minor"]
        score=None
        if priority:
            score=priority["urgency"]*priority["impact"]*priority["confidence"]*100//priority["effort"]
        rows.append({
            "plan_id":plan["id"],"title":plan["title"],
            "rule":plan["rule"],"status":plan["status"],
            "due_at":plan["due_at"],"overdue":plan["due_at"]<now and plan["status"]=="active",
            "manual_score_x100":score,
            "priority":dict(priority) if priority else None,
            "projected_cost_basis_available":sums["cost_planned"]>0 or sums["cost_incurred"]>0,
            "monthly_benefit_forecast_available":sums["benefit_forecast_monthly"]>0,
            "self_reported_benefit_available":sums["benefit_reported_once"]>0,
            "cost_planned_minor":sums["cost_planned"],
            "cost_incurred_minor":sums["cost_incurred"],
            "forecast_monthly_minor":sums["benefit_forecast_monthly"],
            "cost_and_forecast_combination_unverified":True,
        })
    rows.sort(key=lambda r:(
        r["manual_score_x100"] is None,
        -(r["manual_score_x100"] or 0),
        r["due_at"],r["plan_id"]
    ))
    for rank,r in enumerate((x for x in rows if x["manual_score_x100"] is not None),1):
        r["rank"]=rank
    for item in rows:
        if item["manual_score_x100"] is None:
            item["rank"]=None
    return {
        "items":rows[:limit],"total":len(rows),"truncated":len(rows)>limit,
        "ranked_count":sum(x["rank"] is not None for x in rows),
        "unranked_count":sum(x["rank"] is None for x in rows),
        "scoring_formula":"urgency * impact * confidence / effort",
        "scoring_scale":"inputs 1..5, score_x100 integer",
        "assessments_subjective":True,
        "ranking_not_profit_forecast":True,
        "ranking_never_uses_unknown_roi_as_zero":True,
        "bank_verified":False,
    }
