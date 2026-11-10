"""M205 manually reported monthly operating costs and month-by-month calendar.

No artificial zero spending: absent rows are UNCONFIRMED_ZERO until the user
explicitly selects a zero-cost assumption for a particular calculation.
"""
from __future__ import annotations

from osgard_m192.runtime import Conflict, Invalid, _uid, _identifier, _text, _object
from osgard_m193.runtime import _version
from osgard_m203.plans import find_plan
from osgard_m204.economics_ledger import ledger
from .audit import emit, verified

KINDS=frozenset(("planned","reported"))
MAX_ROWS=200
MAX_MINOR=10**12


def _get(db,tenant,row_id):
    _identifier(row_id,"recurring_id")
    row=db.execute(
        "SELECT * FROM m205_recurring_costs WHERE tenant_id=? AND id=?",
        (tenant,row_id)
    ).fetchone()
    if row is None:
        raise Invalid("recurring cost missing or outside organization")
    return row


def _initial(row):
    return {k:row[k] for k in (
        "id","tenant_id","plan_id","basis","title","amount_minor",
        "start_month","end_month","evidence_note","reference",
        "created_by","created_at"
    )}


def verify_recurring(db,tenant,plan_id):
    find_plan(db,tenant,plan_id)
    chain=verified(db,tenant,plan_id,"recurring")
    replay={}
    for event in chain["events"]:
        name,details=event["action"],event["details"]
        if name=="created":
            original=details["row"]
            if original["id"] in replay:
                raise Conflict("duplicate recurring cost creation")
            replay[original["id"]]={"initial":original,"void":None}
        elif name=="voided":
            row_id=details["id"]
            if row_id not in replay or replay[row_id]["void"] is not None:
                raise Conflict("recurring void event has no corresponding active cost")
            replay[row_id]["void"]=details
        else:
            raise Conflict("unknown recurring event")
    rows=db.execute(
        "SELECT * FROM m205_recurring_costs WHERE tenant_id=? AND plan_id=? LIMIT ?",
        (tenant,plan_id,MAX_ROWS+1)
    ).fetchall()
    if len(rows)>MAX_ROWS:
        raise Invalid("too many recurring cost records to validate")
    if len(rows)!=len(replay):
        raise Conflict("recurring cost count does not match immutable journal")
    for row in rows:
        expected=replay.get(row["id"])
        if expected is None or _initial(row)!=expected["initial"]:
            raise Conflict("recurring cost content differs from event history")
        removal=expected["void"]
        if removal is None:
            if (row["state"]!="active" or row["version"]!=1 or
                row["void_reason"] is not None or
                row["voided_by"] is not None or row["voided_at"] is not None):
                raise Conflict("active recurring cost modified without event")
        else:
            if (row["state"]!="voided" or row["version"]!=2 or
                row["void_reason"]!=removal["reason"] or
                row["voided_by"]!=removal["actor"] or
                row["voided_at"]!=removal["at"]):
                raise Conflict("voided recurring cost differs from journal")
    return {"events":chain["count"],"records":len(rows),
            "head":chain["head"],"externally_anchored":False,
            "bank_verified":False}


def create(db,identity,p,now):
    _object(p,{"plan_id","basis","title","amount_minor",
               "start_month","end_month","evidence_note","reference"})
    tenant,actor=identity["tenant_id"],identity["actor"]
    plan=find_plan(db,tenant,p["plan_id"])
    ledger(db,tenant,plan["id"],limit=1)
    verify_recurring(db,tenant,plan["id"])
    basis=p["basis"]
    if type(basis) is not str or basis not in KINDS:
        raise Invalid("recurring basis must be planned or reported")
    if basis=="planned" and plan["status"] in ("cancelled","model_reviewed"):
        raise Conflict("cannot create forecast recurring cost on a closed plan")
    minor=p["amount_minor"]
    if type(minor) is not int or not 1<=minor<=MAX_MINOR:
        raise Invalid("monthly cost must be positive integer kopecks")
    start=p["start_month"];end=p["end_month"]
    if (type(start) is not int or type(end) is not int
        or not 1<=start<=end<=36):
        raise Invalid("month interval must be integer range 1..36")
    title=_text(p["title"],"title",160)
    note=_text(p["evidence_note"],"evidence_note",600)
    if len(note)<10:
        raise Invalid("evidence note must describe manual source in at least 10 chars")
    ref=_text(p["reference"],"reference",120)
    count=db.execute(
        "SELECT COUNT(*) FROM m205_recurring_costs WHERE tenant_id=? AND plan_id=?",
        (tenant,plan["id"])
    ).fetchone()[0]
    if count>=MAX_ROWS:
        raise Invalid("at most 200 recurring records per plan")
    duplicate=db.execute(
        """SELECT 1 FROM m205_recurring_costs
           WHERE tenant_id=? AND plan_id=? AND basis=? AND reference=?
                 AND state='active' LIMIT 1""",
        (tenant,plan["id"],basis,ref)
    ).fetchone()
    if duplicate:
        raise Conflict("active recurring cost with this source reference exists")
    row_id=_uid()
    db.execute(
        """INSERT INTO m205_recurring_costs
           (id,tenant_id,plan_id,basis,title,amount_minor,start_month,end_month,
            evidence_note,reference,state,version,created_by,created_at,
            voided_by,voided_at,void_reason)
           VALUES (?,?,?,?,?,?,?,?,?,?,'active',1,?,?,NULL,NULL,NULL)""",
        (row_id,tenant,plan["id"],basis,title,minor,start,end,note,ref,actor,now)
    )
    row=_get(db,tenant,row_id)
    head=emit(db,tenant,plan["id"],"recurring",actor,
              "created",{"row":_initial(row)},now)
    return {
        "id":row_id,"plan_id":plan["id"],"basis":basis,
        "amount_minor":minor,"start_month":start,"end_month":end,
        "state":"active","version":1,"head":head,
        "source":"MANUAL_COST_ASSUMPTION","bank_verified":False,
    }


def void(db,identity,p,now):
    _object(p,{"recurring_id","expected_version","reason"})
    tenant,actor=identity["tenant_id"],identity["actor"]
    row=_get(db,tenant,p["recurring_id"])
    verify_recurring(db,tenant,row["plan_id"])
    if row["version"]!=_version(p["expected_version"]):
        raise Conflict("stale recurring cost version")
    if row["state"]!="active":
        raise Conflict("recurring cost already voided")
    reason=_text(p["reason"],"reason",400)
    db.execute(
        """UPDATE m205_recurring_costs
           SET state='voided',version=2,voided_by=?,voided_at=?,void_reason=?
           WHERE tenant_id=? AND id=? AND version=1""",
        (actor,now,reason,tenant,row["id"])
    )
    head=emit(db,tenant,row["plan_id"],"recurring",actor,
              "voided",{"id":row["id"],"reason":reason,
                        "actor":actor,"at":now},now)
    return {
        "id":row["id"],"plan_id":row["plan_id"],"state":"voided",
        "version":2,"head":head,"bank_verified":False,
    }


def listed(db,tenant,plan_id,limit=100):
    if type(limit) is not int or not 1<=limit<=200:
        raise Invalid("limit must be integer in 1..200")
    integrity=verify_recurring(db,tenant,plan_id)
    rows=db.execute(
        """SELECT * FROM m205_recurring_costs
           WHERE tenant_id=? AND plan_id=?
           ORDER BY created_at DESC,id DESC""",
        (tenant,plan_id)
    ).fetchall()
    return {
        "plan_id":plan_id,"total":len(rows),
        "items":[dict(r) for r in rows[:limit]],
        "truncated":len(rows)>limit,
        "integrity":integrity,"bank_verified":False,
    }


def calendar(db,tenant,plan_id,basis,months):
    if type(basis) is not str or basis not in KINDS:
        raise Invalid("recurring basis must be planned or reported")
    if type(months) is not int or not 1<=months<=36:
        raise Invalid("horizon_months must be integer 1..36")
    integrity=verify_recurring(db,tenant,plan_id)
    rows=db.execute(
        """SELECT * FROM m205_recurring_costs
           WHERE tenant_id=? AND plan_id=? AND basis=? AND state='active'""",
        (tenant,plan_id,basis)
    ).fetchall()
    out=[0]*months
    for row in rows:
        for month in range(row["start_month"],min(months,row["end_month"])+1):
            out[month-1]+=row["amount_minor"]
    return {
        "plan_id":plan_id,"basis":basis,
        "horizon_months":months,
        "active_records":len(rows),
        "per_month_minor":out,
        "total_minor":sum(out),
        "no_records_explicit_zero_not_confirmed":len(rows)==0,
        "integrity":integrity,
        "bank_verified":False,
        "verified_external_bills":False,
    }
