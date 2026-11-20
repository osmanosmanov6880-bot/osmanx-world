"""M206 frozen scenario snapshots and self-reported monthly forecast backtests.

Observations are owner-reported, not bank evidence. A forecast is frozen
before observations are entered, so later edits cannot rewrite predictions.
No model-quality claim is made about future real-world accuracy.
"""
from __future__ import annotations

import json

from osgard_m192.runtime import Invalid, Conflict, _object, _text, _uid, _identifier, canonical
from osgard_m193.runtime import _version
from osgard_m203.plans import find_plan
from osgard_m204.economics_ledger import ledger
from osgard_m205.net_roi import calculate
from osgard_m205.reconciliation import inspect
from osgard_m205.recurring import calendar

from .journal import append, verified, digest, ensure_row_matches_event

MAX_BASELINES=30
MAX_OBSERVATIONS=800
BASE_FIELDS=("id","tenant_id","plan_id","captured_at","created_by",
             "payload_json","payload_hash")
OBS_INITIAL=("id","tenant_id","plan_id","baseline_id","month_index",
             "reported_gross_minor","reported_operating_minor",
             "evidence_note","reference","created_at","created_by")


def _records(db,tenant,plan_id):
    find_plan(db,tenant,plan_id)
    chain=verified(db,tenant,plan_id,"forecast")
    recorded={}
    captured={}
    for event in chain["items"]:
        details=event["details"]
        name=event["action"]
        if name=="baseline_created":
            row=details["row"]
            if row["id"] in recorded:
                raise Conflict("duplicate forecast baseline event")
            recorded[row["id"]]=row
        elif name=="observation_created":
            row=details["row"]
            if row["id"] in captured:
                raise Conflict("duplicate monthly observation event")
            captured[row["id"]]={"created":row,"void":None}
        elif name=="observation_voided":
            rec=captured.get(details["id"])
            if rec is None or rec["void"] is not None:
                raise Conflict("invalid forecast observation void event order")
            rec["void"]=details
        else:
            raise Conflict("unknown M206 forecast evidence event")
    bases=db.execute(
        """SELECT * FROM m206_forecasts WHERE tenant_id=? AND plan_id=?
           ORDER BY rowid LIMIT ?""",
        (tenant,plan_id,MAX_BASELINES+1)
    ).fetchall()
    observations=db.execute(
        """SELECT * FROM m206_observations WHERE tenant_id=? AND plan_id=?
           ORDER BY rowid LIMIT ?""",
        (tenant,plan_id,MAX_OBSERVATIONS+1)
    ).fetchall()
    if len(bases)>MAX_BASELINES or len(observations)>MAX_OBSERVATIONS:
        raise Invalid("M206 frozen forecast record count exceeds verifier capacity")
    if len(bases)!=len(recorded) or len(observations)!=len(captured):
        raise Conflict("forecast evidence history and database rows disagree")
    for row in bases:
        ensure_row_matches_event(row,recorded.get(row["id"]),
                                 BASE_FIELDS,"frozen baseline")
        try:
            payload=json.loads(row["payload_json"])
            if (row["payload_json"]!=canonical(payload) or
                    row["payload_hash"]!=digest(payload)):
                raise Conflict("frozen forecast snapshot changed")
        except (ValueError,TypeError,OverflowError) as exc:
            raise Conflict("frozen forecast snapshot is unreadable") from exc
    baseline_ids=set(recorded)
    for row in observations:
        rec=captured.get(row["id"])
        if rec is None:
            raise Conflict("monthly observation absent from history")
        ensure_row_matches_event(row,rec["created"],
                                 OBS_INITIAL,"monthly observation")
        if row["baseline_id"] not in baseline_ids:
            raise Conflict("monthly observation belongs to unknown baseline")
        removal=rec["void"]
        if removal is None:
            if (row["state"]!="active" or row["version"]!=1 or
                row["void_reason"] is not None or row["voided_at"] is not None
                or row["voided_by"] is not None):
                raise Conflict("active observation modified outside journal")
        else:
            if (row["state"]!="voided" or row["version"]!=2 or
                row["void_reason"]!=removal["reason"] or
                row["voided_at"]!=removal["at"] or
                row["voided_by"]!=removal["actor"]):
                raise Conflict("voided observation differs from event")
    return {"baselines":bases,"observations":observations,
            "event_head":chain["head"],"events":chain["count"],
            "hash_verified":True,"external_anchor":False}


def _baseline(state,baseline_id):
    _identifier(baseline_id,"baseline_id")
    for row in state["baselines"]:
        if row["id"]==baseline_id:
            return row
    raise Invalid("forecast baseline missing or outside organization")


def freeze(db,identity,p,now):
    _object(p,{
        "plan_id","cost_basis","recurring_basis","horizon_months",
        "realization_rates_bp","scenario_index",
        "require_reconciled_costs","assume_zero_recurring","rationale"
    })
    tenant,actor=identity["tenant_id"],identity["actor"]
    state=_records(db,tenant,p["plan_id"])
    if len(state["baselines"])>=MAX_BASELINES:
        raise Invalid("maximum 30 frozen baselines per action plan")
    selected=p["scenario_index"]
    if type(selected) is not int or selected not in (0,1,2):
        raise Invalid("scenario_index must be integer 0..2")
    rationale=_text(p["rationale"],"rationale",600)
    if len(rationale)<10:
        raise Invalid("explain why this prediction is being frozen")
    options={k:v for k,v in p.items() if k not in ("scenario_index","rationale")}
    simulated=calculate(db,tenant,options)
    case=simulated["scenarios"][selected]
    if case["status"]!="PROJECTED_MANUAL_NET_ROI":
        raise Conflict("only a complete M205 forecast can be frozen: "+case["status"])
    cost=ledger(db,tenant,p["plan_id"],limit=1)
    match=inspect(db,tenant,p["plan_id"],limit=1)
    operating=calendar(db,tenant,p["plan_id"],p["recurring_basis"],
                       p["horizon_months"])
    plan=find_plan(db,tenant,p["plan_id"])
    snapshot={
        "schema":"osgard.m206.frozen-forecast/1",
        "plan_id":p["plan_id"],"captured_at":now,
        "rationale":rationale,"scenario_index":selected,
        "scenario_rate_bp":case["rate_bp"],
        "horizon_months":simulated["horizon_months"],
        "cost_basis":simulated["cost_basis"],
        "recurring_basis":simulated["recurring_basis"],
        "assume_zero_recurring":p["assume_zero_recurring"],
        "require_reconciled_costs":p["require_reconciled_costs"],
        "one_off_cost_minor":simulated["one_off_cost_minor"],
        "forecast_gross_monthly_minor":simulated["monthly_benefit_forecast_minor"],
        "months":case["months"],
        "projected_roi_bp":case["projected_roi_bp"],
        "source_heads":{
            "m204_ledger":cost["integrity"]["head"],
            "m205_links":match["integrity"]["head"],
            "m205_recurring":operating["integrity"]["head"],
        },
        "plan_version":plan["version"],
        "all_inputs_are_manual":True,
        "future_accuracy_unknown":True,
        "bank_verified":False,"causation_proven":False,
        "external_anchor":False,
    }
    baseline_id=_uid()
    encoded=canonical(snapshot)
    payload_hash=digest(snapshot)
    db.execute(
        """INSERT INTO m206_forecasts
           (id,tenant_id,plan_id,captured_at,created_by,payload_json,payload_hash)
           VALUES (?,?,?,?,?,?,?)""",
        (baseline_id,tenant,p["plan_id"],now,actor,encoded,payload_hash)
    )
    row=db.execute(
        "SELECT * FROM m206_forecasts WHERE id=? AND tenant_id=?",
        (baseline_id,tenant)
    ).fetchone()
    event_head=append(db,tenant,p["plan_id"],"forecast",actor,
                      "baseline_created",{"row":{k:row[k] for k in BASE_FIELDS}},now)
    return {
        "baseline_id":baseline_id,"plan_id":p["plan_id"],
        "forecast_snapshot":snapshot,
        "payload_hash":payload_hash,"event_head":event_head,
        "historical_prediction_not_editable":True,
        "bank_verified":False,
    }


def add_observation(db,identity,p,now):
    _object(p,{
        "baseline_id","month_index","reported_gross_minor",
        "reported_operating_minor","evidence_note","reference"
    })
    tenant,actor=identity["tenant_id"],identity["actor"]
    _identifier(p["baseline_id"],"baseline_id")
    found=db.execute(
        """SELECT plan_id FROM m206_forecasts
           WHERE id=? AND tenant_id=?""",
        (p["baseline_id"],tenant)
    ).fetchone()
    if found is None:
        raise Invalid("forecast baseline outside organization")
    plan_id=found["plan_id"]
    state=_records(db,tenant,plan_id)
    baseline=_baseline(state,p["baseline_id"])
    snapshot=json.loads(baseline["payload_json"])
    month=p["month_index"]
    if type(month) is not int or not 1<=month<=snapshot["horizon_months"]:
        raise Invalid("month_index outside frozen prediction horizon")
    for name in ("reported_gross_minor","reported_operating_minor"):
        x=p[name]
        if type(x) is not int or not 0<=x<=10**12:
            raise Invalid(name+" must be explicit integer kopecks, including zero if observed")
    evidence=_text(p["evidence_note"],"evidence_note",700)
    if len(evidence)<10:
        raise Invalid("a monthly observation requires source explanation")
    reference=_text(p["reference"],"reference",160)
    duplicate=db.execute(
        """SELECT 1 FROM m206_observations
           WHERE tenant_id=? AND baseline_id=? AND month_index=? AND state='active'
           LIMIT 1""",
        (tenant,p["baseline_id"],month)
    ).fetchone()
    if duplicate:
        raise Conflict("a report for this forecast/month already exists; void it first")
    if len(state["observations"])>=MAX_OBSERVATIONS:
        raise Invalid("M206 observation record quota reached")
    obs_id=_uid()
    db.execute(
        """INSERT INTO m206_observations
           (id,tenant_id,plan_id,baseline_id,month_index,
            reported_gross_minor,reported_operating_minor,evidence_note,
            reference,created_at,created_by,state,version,void_reason,
            voided_at,voided_by)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,'active',1,NULL,NULL,NULL)""",
        (obs_id,tenant,plan_id,p["baseline_id"],month,
         p["reported_gross_minor"],p["reported_operating_minor"],
         evidence,reference,now,actor)
    )
    row=db.execute(
        "SELECT * FROM m206_observations WHERE tenant_id=? AND id=?",
        (tenant,obs_id)
    ).fetchone()
    head=append(db,tenant,plan_id,"forecast",actor,
                "observation_created",
                {"row":{k:row[k] for k in OBS_INITIAL}},now)
    return {
        "observation_id":obs_id,"baseline_id":p["baseline_id"],
        "month_index":month,"version":1,"state":"active",
        "event_head":head,"source":"OWNER_REPORTED_MANUAL",
        "independently_verified":False,"bank_verified":False,
    }


def void_observation(db,identity,p,now):
    _object(p,{"observation_id","expected_version","reason"})
    tenant,actor=identity["tenant_id"],identity["actor"]
    _identifier(p["observation_id"],"observation_id")
    row=db.execute(
        "SELECT * FROM m206_observations WHERE tenant_id=? AND id=?",
        (tenant,p["observation_id"])
    ).fetchone()
    if row is None:
        raise Invalid("monthly report does not exist in this organization")
    _records(db,tenant,row["plan_id"])
    if row["version"]!=_version(p["expected_version"]):
        raise Conflict("stale monthly observation version")
    if row["state"]!="active":
        raise Conflict("monthly report already voided")
    reason=_text(p["reason"],"reason",500)
    db.execute(
        """UPDATE m206_observations
           SET state='voided',version=2,void_reason=?,voided_at=?,voided_by=?
           WHERE tenant_id=? AND id=? AND version=1""",
        (reason,now,actor,tenant,row["id"])
    )
    head=append(db,tenant,row["plan_id"],"forecast",actor,
                "observation_voided",{
                    "id":row["id"],"reason":reason,"at":now,"actor":actor
                },now)
    return {"observation_id":row["id"],"state":"voided",
            "version":2,"event_head":head,"bank_verified":False}


def list_baselines(db,tenant,p):
    _object(p,{"plan_id"})
    state=_records(db,tenant,p["plan_id"])
    active={b["id"]:0 for b in state["baselines"]}
    for row in state["observations"]:
        if row["state"]=="active":
            active[row["baseline_id"]]+=1
    return {
        "plan_id":p["plan_id"],"total":len(state["baselines"]),
        "items":[{
            "baseline_id":b["id"],"captured_at":b["captured_at"],
            "created_by":b["created_by"],
            "payload_hash":b["payload_hash"],
            "scenario_rate_bp":json.loads(b["payload_json"])["scenario_rate_bp"],
            "horizon_months":json.loads(b["payload_json"])["horizon_months"],
            "active_observations":active[b["id"]],
        } for b in state["baselines"]],
        "event_head":state["event_head"],
        "verified_local_history":True,
        "bank_verified":False,"external_anchor":False,
    }


def backtest(db,tenant,p):
    _object(p,{"baseline_id"})
    _identifier(p["baseline_id"],"baseline_id")
    row=db.execute(
        "SELECT plan_id FROM m206_forecasts WHERE tenant_id=? AND id=?",
        (tenant,p["baseline_id"])
    ).fetchone()
    if row is None:
        raise Invalid("baseline missing or outside organization")
    state=_records(db,tenant,row["plan_id"])
    baseline=_baseline(state,p["baseline_id"])
    frozen=json.loads(baseline["payload_json"])
    obs={r["month_index"]:r for r in state["observations"]
         if r["baseline_id"]==p["baseline_id"] and r["state"]=="active"}
    months=[]
    total_abs=0
    total_signed=0
    for predicted in frozen["months"]:
        month=predicted["month"]
        reported=obs.get(month)
        expected=predicted["projected_net_before_investment_minor"]
        if reported is None:
            months.append({"month":month,
                           "status":"NO_OWNER_REPORTED_OBSERVATION",
                           "predicted_net_minor":expected,
                           "reported_net_minor":None,"error_minor":None})
            continue
        actual=reported["reported_gross_minor"]-reported["reported_operating_minor"]
        error=actual-expected
        total_abs+=abs(error)
        total_signed+=error
        months.append({
            "month":month,"status":"OWNER_REPORTED_NOT_VERIFIED",
            "predicted_net_minor":expected,
            "reported_gross_minor":reported["reported_gross_minor"],
            "reported_operating_minor":reported["reported_operating_minor"],
            "reported_net_minor":actual,
            "error_minor":error,
            "reference":reported["reference"],
            "observation_id":reported["id"],
        })
    count=len(obs)
    horizon=frozen["horizon_months"]
    led=ledger(db,tenant,row["plan_id"],limit=1)
    matched=inspect(db,tenant,row["plan_id"],limit=1)
    recurring=calendar(db,tenant,row["plan_id"],frozen["recurring_basis"],horizon)
    current={
        "m204_ledger":led["integrity"]["head"],
        "m205_links":matched["integrity"]["head"],
        "m205_recurring":recurring["integrity"]["head"],
    }
    changes=[key for key in current if
             current[key]!=frozen["source_heads"][key]]
    return {
        "schema":"osgard.m206.manual-backtest/1",
        "baseline_id":p["baseline_id"],"plan_id":row["plan_id"],
        "baseline_captured_at":frozen["captured_at"],
        "baseline_payload_hash":baseline["payload_hash"],
        "horizon_months":horizon,"observed_months":count,
        "missing_months":horizon-count,
        "coverage_bp":count*10000//horizon,
        "mean_absolute_error_minor":total_abs//count if count else None,
        "mean_signed_error_minor":total_signed//count if count else None,
        "cumulative_signed_error_minor":total_signed if count else None,
        "interpretation":(
            "NO_OBSERVATIONS" if not count else
            "COMPLETE_BUT_SELF_REPORTED" if count==horizon else
            "PARTIAL_SELF_REPORTED"
        ),
        "months":months,
        "source_heads_at_freeze":frozen["source_heads"],
        "source_heads_current":current,
        "sources_changed_since_freeze":changes,
        "frozen_prediction_not_recomputed":True,
        "sample_only_covers_reported_months":True,
        "bank_verified":False,
        "independent_outcome_evidence":False,
        "causation_proven":False,
        "external_anchor":False,
        "event_head":state["event_head"],
    }
