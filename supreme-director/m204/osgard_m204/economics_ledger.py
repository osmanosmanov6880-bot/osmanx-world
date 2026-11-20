"""M204 cost & benefit claims: append-only, tenant-bounded economic ledger.

Every amount is manually entered. It is not independently reconciled to a
bank. Expected monthly benefit and self-reported one-off benefit never mix.
"""
from __future__ import annotations

from hashlib import sha256
import json

from osgard_m192.runtime import (
    Invalid, Conflict, canonical, _uid, _identifier, _text, _object
)
from osgard_m193.runtime import _version
from osgard_m203.plans import find_plan, verified_events

GENESIS="0"*64
KINDS=frozenset((
    "cost_planned","cost_incurred","benefit_forecast_monthly",
    "benefit_reported_once"
))
CATEGORIES={
    "cost_planned":"Плановая стоимость (разовый расход)",
    "cost_incurred":"Уже понесённый расход (со слов владельца)",
    "benefit_forecast_monthly":"Ожидаемая ежемесячная выгода (гипотеза)",
    "benefit_reported_once":"Заявленная разовая выгода (со слов владельца)"
}
MAX_RECORDS=500
MAX_AMOUNT=10**12


def entry(db,tenant,entry_id):
    _identifier(entry_id,"entry_id")
    item=db.execute(
        "SELECT * FROM economics_entries WHERE tenant_id=? AND id=?",
        (tenant,entry_id)
    ).fetchone()
    if item is None:
        raise Invalid("economic entry missing or outside organization")
    return item


def event(db,tenant,plan_id,actor,action,details,now):
    previous=db.execute(
        """SELECT event_hash FROM economics_events
           WHERE tenant_id=? AND plan_id=? ORDER BY seq DESC LIMIT 1""",
        (tenant,plan_id)
    ).fetchone()
    prior=previous["event_hash"] if previous else GENESIS
    source={"tenant":tenant,"plan_id":plan_id,"actor":actor,
            "action":action,"details":details,"at":now,"previous_hash":prior}
    digest=sha256(canonical(source).encode("ascii")).hexdigest()
    db.execute(
        """INSERT INTO economics_events
           (tenant_id,plan_id,actor,action,details_json,at,previous_hash,event_hash)
           VALUES (?,?,?,?,?,?,?,?)""",
        (tenant,plan_id,actor,action,canonical(details),now,prior,digest)
    )
    return digest


def _entry_payload(row):
    keys=("id","plan_id","kind","amount_minor","title","evidence_note",
          "evaluation_id","reference","created_by","created_at")
    return {k:row[k] for k in keys}


def verify(db,tenant,plan_id):
    """Verify complete per-plan event chain AND replay against mutable rows."""
    find_plan(db,tenant,plan_id)
    events=list(db.execute(
        """SELECT * FROM economics_events WHERE tenant_id=? AND plan_id=?
           ORDER BY seq""",(tenant,plan_id)
    ))
    if len(events)>MAX_RECORDS*4:
        raise Invalid("economic history too large to validate")
    previous=GENESIS
    records={}
    priority=None
    for row in events:
        details=json.loads(row["details_json"])
        source={"tenant":tenant,"plan_id":plan_id,"actor":row["actor"],
                "action":row["action"],"details":details,"at":row["at"],
                "previous_hash":previous}
        digest=sha256(canonical(source).encode("ascii")).hexdigest()
        if (row["previous_hash"]!=previous or row["event_hash"]!=digest
            or row["details_json"]!=canonical(details)):
            raise Conflict("M204 economic ledger event chain was modified")
        previous=digest
        action=row["action"]
        if action=="entry_added":
            item=details["entry"]
            if item["id"] in records:
                raise Conflict("duplicate economic entry event")
            records[item["id"]]={"created":item,"void":None}
        elif action=="entry_voided":
            entry_id=details["entry_id"]
            if entry_id not in records or records[entry_id]["void"] is not None:
                raise Conflict("invalid void event order")
            records[entry_id]["void"]=details
        elif action=="priority_set":
            priority=details["assessment"]
        else:
            raise Conflict("unknown event type")
    rows=list(db.execute(
        "SELECT * FROM economics_entries WHERE tenant_id=? AND plan_id=?",
        (tenant,plan_id)
    ))
    if len(rows)!=len(records):
        raise Conflict("entry count disagrees with immutable history")
    for row in rows:
        expected=records.get(row["id"])
        if not expected or _entry_payload(row)!=expected["created"]:
            raise Conflict("economic entry changed without a ledger event")
        if expected["void"] is None:
            if row["state"]!="active" or row["version"]!=1 or row["void_reason"] is not None:
                raise Conflict("economic entry active state differs from events")
        else:
            d=expected["void"]
            if (row["state"]!="voided" or row["version"]!=2
                or row["void_reason"]!=d["reason"]
                or row["voided_by"]!=d["actor"]
                or row["voided_at"]!=d["at"]):
                raise Conflict("economic entry void state differs from events")
    current=db.execute(
        "SELECT * FROM economics_priorities WHERE tenant_id=? AND plan_id=?",
        (tenant,plan_id)
    ).fetchone()
    if (priority is None)!=(current is None):
        raise Conflict("priority assessment disagrees with immutable ledger")
    if current is not None:
        fields=("urgency","impact","effort","confidence","rationale",
                "version","updated_by","updated_at")
        if any(current[k]!=priority[k] for k in fields):
            raise Conflict("priority values differ from event history")
    return {"events":len(events),"entries":len(rows),
            "head":previous,"hash_verified":True,
            "external_anchor":False,"bank_verified":False}


def add(db,identity,p,now):
    _object(p,{"plan_id","kind","amount_minor","title","evidence_note"},
            {"evaluation_id","reference"})
    tenant,actor=identity["tenant_id"],identity["actor"]
    plan=find_plan(db,tenant,p["plan_id"])
    verify(db,tenant,plan["id"])
    kind=p["kind"]
    if not isinstance(kind,str) or kind not in KINDS:
        raise Invalid("unknown economic entry kind")
    amount=p["amount_minor"]
    if type(amount) is not int or not 1<=amount<=MAX_AMOUNT:
        raise Invalid("amount_minor must be integer kopecks from 1..10^12")
    title=_text(p["title"],"title",160)
    note=_text(p["evidence_note"],"evidence_note",600)
    if len(note)<10:
        raise Invalid("describe the source or assumption in at least 10 characters")
    ref=p.get("reference")
    if ref is not None:
        ref=_text(ref,"reference",120)
    evaluation_id=p.get("evaluation_id")
    if kind=="benefit_reported_once":
        if plan["status"]!="model_reviewed":
            raise Conflict("reported benefit claim requires reviewed M203 model result")
        if evaluation_id!=plan["latest_evaluation_id"]:
            raise Conflict("claim must cite latest reviewed evaluation for this plan")
        _identifier(evaluation_id,"evaluation_id")
        verified_events(db,tenant,plan["id"])
        approved=db.execute(
            """SELECT 1 FROM financial_action_reviews
               WHERE tenant_id=? AND plan_id=? AND evaluation_id=? AND approved=1""",
            (tenant,plan["id"],evaluation_id)
        ).fetchone()
        if approved is None:
            raise Conflict("evaluation has no approved owner review")
        if ref is None:
            raise Invalid("reported benefit requires a unique source reference")
    elif evaluation_id is not None:
        raise Invalid("evaluation_id only valid for reported benefit claim")
    if kind=="benefit_forecast_monthly" and plan["status"] in ("cancelled","model_reviewed"):
        raise Conflict("cannot add new monthly forecast to closed action plan")
    if kind.startswith("cost_") and plan["status"]=="cancelled":
        # Costs may still surface after cancellation. Do not hide real sunk costs.
        pass
    if ref is not None:
        duplicate=db.execute(
            """SELECT 1 FROM economics_entries
               WHERE tenant_id=? AND plan_id=? AND kind=? AND reference=?
                     AND state='active' LIMIT 1""",
            (tenant,plan["id"],kind,ref)
        ).fetchone()
        if duplicate:
            raise Conflict("same reference already recorded in this category")
    count=db.execute(
        "SELECT COUNT(*) FROM economics_entries WHERE tenant_id=? AND plan_id=?",
        (tenant,plan["id"])
    ).fetchone()[0]
    if count>=MAX_RECORDS:
        raise Invalid("maximum 500 economic entries per plan")
    entry_id=_uid()
    db.execute(
        """INSERT INTO economics_entries
           (id,tenant_id,plan_id,kind,amount_minor,title,evidence_note,
            evaluation_id,reference,state,version,created_by,created_at,
            voided_by,voided_at,void_reason)
           VALUES (?,?,?,?,?,?,?,?,?,'active',1,?,?,NULL,NULL,NULL)""",
        (entry_id,tenant,plan["id"],kind,amount,title,note,
         evaluation_id,ref,actor,now)
    )
    current=entry(db,tenant,entry_id)
    head=event(db,tenant,plan["id"],actor,"entry_added",
               {"entry":_entry_payload(current)},now)
    return {
        "id":entry_id,"plan_id":plan["id"],"kind":kind,
        "amount_minor":amount,"version":1,"state":"active",
        "head":head,"bank_verified":False,
        "source":"MANUAL_ENTRY","causation_proven":False,
    }


def void(db,identity,p,now):
    _object(p,{"entry_id","expected_version","reason"})
    tenant,actor=identity["tenant_id"],identity["actor"]
    item=entry(db,tenant,p["entry_id"])
    verify(db,tenant,item["plan_id"])
    version=_version(p["expected_version"])
    if item["version"]!=version:
        raise Conflict("stale economic entry version")
    if item["state"]!="active":
        raise Conflict("entry has already been voided")
    reason=_text(p["reason"],"reason",500)
    db.execute(
        """UPDATE economics_entries
           SET state='voided',version=2,voided_by=?,voided_at=?,void_reason=?
           WHERE id=? AND tenant_id=? AND version=1""",
        (actor,now,reason,item["id"],tenant)
    )
    head=event(db,tenant,item["plan_id"],actor,"entry_voided",
               {"entry_id":item["id"],"reason":reason,
                "actor":actor,"at":now},now)
    return {"entry_id":item["id"],"state":"voided","version":2,
            "plan_id":item["plan_id"],"head":head,
            "bank_verified":False}


def ledger(db,tenant,plan_id,limit=200):
    if type(limit) is not int or not 1<=limit<=500:
        raise Invalid("limit must be integer from 1 to 500")
    integrity=verify(db,tenant,plan_id)
    rows=list(db.execute(
        """SELECT * FROM economics_entries WHERE tenant_id=? AND plan_id=?
           ORDER BY created_at DESC,id DESC""",(tenant,plan_id)
    ))
    active=[r for r in rows if r["state"]=="active"]
    totals={kind:sum(r["amount_minor"] for r in active if r["kind"]==kind)
            for kind in sorted(KINDS)}
    return {
        "plan_id":plan_id,"total":len(rows),"truncated":len(rows)>limit,
        "items":[dict(r) for r in rows[:limit]],"totals_minor":totals,
        "money_unit":"kopecks","currency":"RUB",
        "integrity":integrity,"source":"MANUAL_UNVERIFIED",
        "bank_verified":False,"external_anchor":False,
    }
