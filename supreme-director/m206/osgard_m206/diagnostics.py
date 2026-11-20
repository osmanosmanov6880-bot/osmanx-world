"""M206 deterministic contradictions, immutable diagnostic snapshots, owner review.

A diagnostic finding is evidence of an inconsistency or missing local input,
not proof of wrongdoing, double payment or a verified bank error.
"""
from __future__ import annotations

import json

from osgard_m192.runtime import Invalid, Conflict, _uid, _text, _object, canonical, _identifier
from osgard_m203.plans import find_plan, verified_events
from osgard_m204.economics_ledger import ledger
from osgard_m205.reconciliation import inspect
from osgard_m205.recurring import calendar
from .journal import GENESIS, append, verified, digest, ensure_row_matches_event

MAX_SCANS=100
MAX_FINDINGS=500
SCAN_FIELDS=("id","tenant_id","plan_id","created_at","created_by",
             "payload_json","payload_hash","previous_hash","head_hash")
ACK_FIELDS=("id","tenant_id","plan_id","scan_id","finding_id",
            "reason","actor","created_at")


def _item(plan_id,code,severity,ref,detail):
    return {
        "id":digest({"plan_id":plan_id,"code":code,"ref":ref})[:32],
        "code":code,"severity":severity,
        "source_ref":ref,"detail":detail,
        "bank_verified":False,"auto_resolved":False,
    }


def detect(db,tenant,plan_id):
    plan=find_plan(db,tenant,plan_id)
    history=verified_events(db,tenant,plan_id)
    economic=ledger(db,tenant,plan_id,limit=500)
    matching=inspect(db,tenant,plan_id,limit=200)
    if matching["links_truncated"] or economic["truncated"]:
        raise Invalid("M206 scan needs full underlying records, not truncated lists")
    planned=calendar(db,tenant,plan_id,"planned",36)
    reported=calendar(db,tenant,plan_id,"reported",36)
    findings=[]
    def add(code,severity,ref,detail):
        findings.append(_item(plan_id,code,severity,ref,detail))
        if len(findings)>MAX_FINDINGS:
            raise Invalid("too many M206 findings to snapshot safely")

    for source in matching["links"]:
        if source["state"]=="active" and source["match_status"]!="MATCHED_LOCAL_RECORDS":
            add("SOURCE_LINK_DRIFT","warning",source["id"],{
                "match_status":source["match_status"],
                "economic_entry_id":source["economic_entry_id"],
                "m198_expense_id":source["expense_id"],
            })
    for record in economic["items"]:
        if record["state"]!="active" or record["kind"] not in (
            "cost_planned","cost_incurred"):
            continue
        linked=[l for l in matching["links"] if l["state"]=="active"
                and l["economic_entry_id"]==record["id"]]
        if not linked:
            add("UNLINKED_MANUAL_COST","review",record["id"],{
                "kind":record["kind"],"amount_minor":record["amount_minor"],
                "reason":"not matched to M198, which is optional unless required",
            })
    for group in matching["candidate_groups"]:
        if len(group["potential_matches"])>1 or group["candidates_truncated"]:
            add("AMBIGUOUS_LOCAL_MATCH","review",group["economic_entry_id"],{
                "possible_local_matches":len(group["potential_matches"]),
                "truncated":group["candidates_truncated"],
                "manual_confirmation_required":True,
            })
    # A shared reference across planned and incurred may be a valid lifecycle;
    # flag it for owner review rather than labelling it a confirmed duplicate.
    by_ref={}
    for e in economic["items"]:
        if (e["state"]=="active" and e["kind"] in (
            "cost_planned","cost_incurred") and e["reference"]):
            by_ref.setdefault(e["reference"],set()).add(e["kind"])
    for ref,kinds in by_ref.items():
        if len(kinds)>1:
            add("CROSS_BASIS_REFERENCE_REVIEW","review",ref,{
                "kinds":sorted(kinds),
                "possible_valid_planned_to_incurred_transition":True,
            })
    amounts=economic["totals_minor"]
    if not (amounts["cost_planned"] or amounts["cost_incurred"]):
        add("NO_ONE_TIME_COST_BASIS","info","m204.costs",{
            "status":"missing_in_both_basis"})
    if not amounts["benefit_forecast_monthly"]:
        add("NO_MONTHLY_BENEFIT_FORECAST","info","m204.benefit_forecast_monthly",{
            "status":"missing_manual_assumption"})
    if not planned["active_records"] and not reported["active_records"]:
        add("RECURRING_SOURCE_UNKNOWN","info","m205.recurring",{
            "status":"absence_is_not_zero",
            "explicit_zero_cost_assumption_required_in_each_calculation":True,
        })
    # Same source reference used for two different plans is a question, not
    # proof of duplicate cost: allocations across plans can be legitimate.
    referenced={e["reference"]:e for e in economic["items"]
                if e["state"]=="active" and e["reference"] and
                e["kind"] in ("cost_planned","cost_incurred")}
    for ref,e in referenced.items():
        similar=db.execute(
            """SELECT e.plan_id,e.id FROM economics_entries e
               WHERE e.tenant_id=? AND e.reference=? AND e.kind=?
                     AND e.amount_minor=? AND e.state='active'
                     AND e.plan_id!=?
               LIMIT 2""",
            (tenant,ref,e["kind"],e["amount_minor"],plan_id)
        ).fetchall()
        if similar:
            add("CROSS_PLAN_SOURCE_REFERENCE","review",e["id"],{
                "same_reference_in_other_plan":True,
                "other_plan_ids":[r["plan_id"] for r in similar],
                "might_be_valid_allocation":True,
            })
    findings.sort(key=lambda f:(f["severity"],f["code"],f["source_ref"]))
    counts={s:sum(v["severity"]==s for v in findings)
            for s in ("warning","review","info")}
    return {
        "schema":"osgard.m206.diagnostic/1",
        "plan_id":plan_id,"plan_version":plan["version"],
        "plan_status":plan["status"],
        "findings":findings,"counts":counts,
        "source_heads":{
            "m203_plan":history["head"],
            "m204_ledger":economic["integrity"]["head"],
            "m205_links":matching["integrity"]["head"],
            "m205_recurring":planned["integrity"]["head"],
        },
        "complete_local_scan":True,
        "missing_data_is_not_zero":True,
        "findings_are_not_bank_discrepancies":True,
        "bank_verified":False,"external_anchor":False,
    }


def _snapshot_record(row):
    return {k:row[k] for k in SCAN_FIELDS}


def _ack_record(row):
    return {k:row[k] for k in ACK_FIELDS}


def _verify(db,tenant,plan_id):
    find_plan(db,tenant,plan_id)
    events=verified(db,tenant,plan_id,"diagnostics")
    rows=db.execute(
        """SELECT * FROM m206_scans WHERE tenant_id=? AND plan_id=?
           ORDER BY rowid LIMIT ?""",
        (tenant,plan_id,MAX_SCANS+1)
    ).fetchall()
    if len(rows)>MAX_SCANS:
        raise Invalid("M206 diagnostic scan quota exceeded")
    reviews=db.execute(
        """SELECT * FROM m206_reviews WHERE tenant_id=? AND plan_id=?
           ORDER BY created_at,id LIMIT 1001""",
        (tenant,plan_id)
    ).fetchall()
    if len(reviews)>1000:
        raise Invalid("too many M206 manual review records")
    scans_from_events={}
    reviews_from_events={}
    for event in events["items"]:
        kind,data=event["action"],event["details"]
        if kind=="scan_created":
            rec=data["row"]
            if rec["id"] in scans_from_events:
                raise Conflict("duplicate scan in M206 history")
            scans_from_events[rec["id"]]=rec
        elif kind=="finding_acknowledged":
            rec=data["row"]
            if rec["id"] in reviews_from_events:
                raise Conflict("duplicate manual review in M206 history")
            reviews_from_events[rec["id"]]=rec
        else:
            raise Conflict("unknown M206 diagnostic event type")
    if len(rows)!=len(scans_from_events) or len(reviews)!=len(reviews_from_events):
        raise Conflict("M206 diagnostic records differ from event history")
    previous=GENESIS
    for row in rows:
        ensure_row_matches_event(row,scans_from_events.get(row["id"]),
                                 SCAN_FIELDS,"diagnostic scan")
        if row["previous_hash"]!=previous or row["payload_hash"]!=digest(
            json.loads(row["payload_json"])
        ) or row["payload_json"]!=canonical(json.loads(row["payload_json"])):
            raise Conflict("M206 diagnostic snapshot content mismatch")
        computed=digest({
            "previous_hash":previous,"payload_hash":row["payload_hash"],
            "created_at":row["created_at"],"created_by":row["created_by"],
            "tenant_id":tenant,"plan_id":plan_id
        })
        if computed!=row["head_hash"]:
            raise Conflict("M206 diagnostic snapshot chain mismatch")
        previous=computed
    for row in reviews:
        ensure_row_matches_event(row,reviews_from_events.get(row["id"]),
                                 ACK_FIELDS,"diagnostic review")
        target=scans_from_events.get(row["scan_id"])
        if target is None:
            raise Conflict("M206 acknowledgement references unknown scan")
        if row["finding_id"] not in {
            f["id"] for f in json.loads(target["payload_json"])["findings"]
        }:
            raise Conflict("M206 acknowledgement references unknown finding")
    return {"scans":rows,"reviews":reviews,"events":events["count"],
            "chain_head":events["head"],"snapshot_head":previous,
            "hash_verified":True,"external_anchor":False}


def scan(db,identity,p,now):
    _object(p,{"plan_id"})
    tenant,actor=identity["tenant_id"],identity["actor"]
    verified_current=_verify(db,tenant,p["plan_id"])
    if len(verified_current["scans"])>=MAX_SCANS:
        raise Invalid("M206 maximum diagnostic snapshots reached")
    snapshot=detect(db,tenant,p["plan_id"])
    snapshot["captured_at"]=now
    prev=verified_current["snapshot_head"]
    payload_json=canonical(snapshot)
    payload_hash=digest(snapshot)
    head=digest({"previous_hash":prev,"payload_hash":payload_hash,
                 "created_at":now,"created_by":actor,
                 "tenant_id":tenant,"plan_id":p["plan_id"]})
    scan_id=_uid()
    db.execute(
        """INSERT INTO m206_scans
           (id,tenant_id,plan_id,created_at,created_by,payload_json,
            payload_hash,previous_hash,head_hash)
           VALUES (?,?,?,?,?,?,?,?,?)""",
        (scan_id,tenant,p["plan_id"],now,actor,payload_json,
         payload_hash,prev,head)
    )
    row=db.execute(
        "SELECT * FROM m206_scans WHERE tenant_id=? AND id=?",
        (tenant,scan_id)
    ).fetchone()
    event_head=append(db,tenant,p["plan_id"],"diagnostics",actor,
                      "scan_created",{"row":_snapshot_record(row)},now)
    return {"scan_id":scan_id,"snapshot":snapshot,"snapshot_head":head,
            "event_head":event_head,"external_anchor":False,
            "bank_verified":False}


def latest(db,tenant,p):
    _object(p,{"plan_id"})
    state=_verify(db,tenant,p["plan_id"])
    if not state["scans"]:
        return {"exists":False,"plan_id":p["plan_id"],
                "bank_verified":False,"external_anchor":False}
    row=state["scans"][-1]
    reviewed={r["finding_id"] for r in state["reviews"]
              if r["scan_id"]==row["id"]}
    payload=json.loads(row["payload_json"])
    return {
        "exists":True,"scan_id":row["id"],
        "captured_at":row["created_at"],"snapshot":payload,
        "acknowledged_finding_ids":sorted(reviewed),
        "acknowledged_does_not_mean_resolved":True,
        "verified_local_hash":state["snapshot_head"],
        "event_head":state["chain_head"],
        "external_anchor":False,"bank_verified":False,
    }


def acknowledge(db,identity,p,now):
    _object(p,{"plan_id","scan_id","finding_id","reason"})
    tenant,actor=identity["tenant_id"],identity["actor"]
    _identifier(p["scan_id"],"scan_id")
    _identifier(p["finding_id"],"finding_id")
    state=_verify(db,tenant,p["plan_id"])
    scans=state["scans"]
    if not scans or scans[-1]["id"]!=p["scan_id"]:
        raise Conflict("M206 review must refer to latest completed diagnostic")
    payload=json.loads(scans[-1]["payload_json"])
    if p["finding_id"] not in {f["id"] for f in payload["findings"]}:
        raise Invalid("finding is not in latest scan")
    reason=_text(p["reason"],"reason",500)
    if len(reason)<10:
        raise Invalid("manual acknowledgement requires a meaningful explanation")
    if any(r["scan_id"]==p["scan_id"] and r["finding_id"]==p["finding_id"]
           for r in state["reviews"]):
        raise Conflict("this finding already acknowledged in this scan")
    review_id=_uid()
    db.execute(
        """INSERT INTO m206_reviews
           (id,tenant_id,plan_id,scan_id,finding_id,reason,actor,created_at)
           VALUES (?,?,?,?,?,?,?,?)""",
        (review_id,tenant,p["plan_id"],p["scan_id"],p["finding_id"],
         reason,actor,now)
    )
    row=db.execute(
        "SELECT * FROM m206_reviews WHERE tenant_id=? AND id=?",
        (tenant,review_id)
    ).fetchone()
    head=append(db,tenant,p["plan_id"],"diagnostics",actor,
                "finding_acknowledged",{"row":_ack_record(row)},now)
    return {
        "review_id":review_id,"finding_id":p["finding_id"],
        "scan_id":p["scan_id"],"status":"ACKNOWLEDGED_NOT_RESOLVED",
        "event_head":head,"bank_verified":False,
    }


def history(db,tenant,p):
    _object(p,{"plan_id"},{"limit"})
    limit=p.get("limit",20)
    if type(limit) is not int or not 1<=limit<=100:
        raise Invalid("diagnostic history limit must be integer 1..100")
    state=_verify(db,tenant,p["plan_id"])
    return {
        "plan_id":p["plan_id"],"total":len(state["scans"]),
        "reviews_total":len(state["reviews"]),
        "items":[{"scan_id":r["id"],"captured_at":r["created_at"],
                  "findings":len(json.loads(r["payload_json"])["findings"]),
                  "payload_hash":r["payload_hash"],
                  "head_hash":r["head_hash"]}
                 for r in state["scans"][-limit:]],
        "event_head":state["chain_head"],"external_anchor":False,
        "bank_verified":False,
    }
