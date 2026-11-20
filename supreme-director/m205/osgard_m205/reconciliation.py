"""M205 exact-match reconciliation of M204 costs against M198 project expenses.

A link is a local source cross-check, NOT a bank confirmation. M198 and M204
amounts must never be summed twice: M204 remains the only cash basis.
"""
from __future__ import annotations

from osgard_m192.runtime import Conflict, Invalid, _uid, _identifier, _text, _object
from osgard_m193.runtime import _version
from osgard_m203.plans import find_plan
from osgard_m204.economics_ledger import entry, ledger
from .audit import emit, verified

KINDS={"cost_planned":"planned","cost_incurred":"incurred"}
MAX_ROWS=500


def _source(db,tenant,project_id,expense_id):
    _identifier(project_id,"project_id")
    _identifier(expense_id,"expense_id")
    result=db.execute(
        """SELECT * FROM delivery_finance_expenses
           WHERE tenant_id=? AND project_id=? AND id=?""",
        (tenant,project_id,expense_id)
    ).fetchone()
    if result is None:
        raise Invalid("M198 source expense missing or outside organization/project")
    return result


def _get_link(db,tenant,link_id):
    _identifier(link_id,"link_id")
    link=db.execute(
        "SELECT * FROM m205_cost_links WHERE tenant_id=? AND id=?",
        (tenant,link_id)
    ).fetchone()
    if link is None:
        raise Invalid("M205 cost link missing or outside organization")
    return link


def _created_fields(row):
    return {k:row[k] for k in (
        "id","tenant_id","plan_id","economic_entry_id","project_id",
        "expense_id","economic_version","source_version","cost_kind",
        "amount_minor","created_by","created_at"
    )}


def verify_links(db,tenant,plan_id):
    find_plan(db,tenant,plan_id)
    chain=verified(db,tenant,plan_id,"reconciliation")
    records={}
    for event in chain["events"]:
        name,details=event["action"],event["details"]
        if name=="link_created":
            initial=details["row"]
            if initial["id"] in records:
                raise Conflict("repeated creation of cost link in history")
            records[initial["id"]]={"created":initial,"unlinked":None}
        elif name=="link_unlinked":
            target=details["link_id"]
            if target not in records or records[target]["unlinked"] is not None:
                raise Conflict("invalid cost unlink event")
            records[target]["unlinked"]=details
        else:
            raise Conflict("unrecognized cost reconciliation event")
    rows=db.execute(
        "SELECT * FROM m205_cost_links WHERE tenant_id=? AND plan_id=? LIMIT ?",
        (tenant,plan_id,MAX_ROWS+1)
    ).fetchall()
    if len(rows)>MAX_ROWS:
        raise Invalid("M205 cost reconciliation row limit exceeded")
    if len(rows)!=len(records):
        raise Conflict("reconciliation row count differs from event history")
    for row in rows:
        rec=records.get(row["id"])
        if not rec or _created_fields(row)!=rec["created"]:
            raise Conflict("cost link immutable fields were modified")
        removal=rec["unlinked"]
        if removal is None:
            if (row["state"]!="active" or row["version"]!=1 or
                row["unlinked_by"] is not None or row["unlinked_at"] is not None or
                row["unlink_reason"] is not None):
                raise Conflict("active link state modified outside event log")
        else:
            if (row["state"]!="unlinked" or row["version"]!=2 or
                row["unlinked_by"]!=removal["actor"] or
                row["unlinked_at"]!=removal["at"] or
                row["unlink_reason"]!=removal["reason"]):
                raise Conflict("unlink fields do not match immutable event")
    return {
        "events":chain["count"],"links":len(rows),
        "head":chain["head"],"externally_anchored":False,
        "bank_verified":False,
    }


def link(db,identity,p,now):
    _object(p,{
        "plan_id","economic_entry_id","project_id","expense_id",
        "expected_economic_version","expected_expense_version"
    })
    tenant,actor=identity["tenant_id"],identity["actor"]
    plan=find_plan(db,tenant,p["plan_id"])
    ledger(db,tenant,plan["id"],limit=1)
    verify_links(db,tenant,plan["id"])
    economic=entry(db,tenant,p["economic_entry_id"])
    if economic["plan_id"]!=plan["id"]:
        raise Invalid("economic entry belongs to another plan")
    if economic["state"]!="active" or economic["kind"] not in KINDS:
        raise Conflict("only active cost entries can link to project expenses")
    if economic["version"]!=_version(p["expected_economic_version"]):
        raise Conflict("economic entry version changed")
    source=_source(db,tenant,p["project_id"],p["expense_id"])
    if source["version"]!=_version(p["expected_expense_version"]):
        raise Conflict("M198 expense version changed")
    if source["state"]!="active":
        raise Conflict("M198 expense is no longer active")
    if (source["kind"]!=KINDS[economic["kind"]] or
        source["amount_minor"]!=economic["amount_minor"]):
        raise Conflict("M198 kind/amount mismatch: do not auto-reconcile")
    occupied=db.execute(
        """SELECT id FROM m205_cost_links WHERE tenant_id=? AND state='active'
           AND (economic_entry_id=? OR expense_id=?) LIMIT 1""",
        (tenant,economic["id"],source["id"])
    ).fetchone()
    if occupied:
        raise Conflict("economic entry or M198 expense already reconciled")
    link_id=_uid()
    db.execute(
        """INSERT INTO m205_cost_links
           (id,tenant_id,plan_id,economic_entry_id,project_id,expense_id,
            economic_version,source_version,cost_kind,amount_minor,
            created_by,created_at,state,version,unlinked_by,unlinked_at,unlink_reason)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,'active',1,NULL,NULL,NULL)""",
        (link_id,tenant,plan["id"],economic["id"],source["project_id"],
         source["id"],economic["version"],source["version"],
         economic["kind"],economic["amount_minor"],actor,now)
    )
    record=_get_link(db,tenant,link_id)
    head=emit(db,tenant,plan["id"],"reconciliation",actor,"link_created",
              {"row":_created_fields(record)},now)
    return {
        "link_id":link_id,"plan_id":plan["id"],"state":"active",
        "version":1,"source":"M198_LOCAL_EXPENSE",
        "amount_minor":source["amount_minor"],"kind":economic["kind"],
        "head":head,"bank_verified":False,
        "counted_in_m204_only":True,
        "external_payment_verified":False,
    }


def unlink(db,identity,p,now):
    _object(p,{"link_id","expected_version","reason"})
    tenant,actor=identity["tenant_id"],identity["actor"]
    row=_get_link(db,tenant,p["link_id"])
    verify_links(db,tenant,row["plan_id"])
    if row["version"]!=_version(p["expected_version"]):
        raise Conflict("stale reconciliation link version")
    if row["state"]!="active":
        raise Conflict("link already unlinked")
    reason=_text(p["reason"],"reason",400)
    db.execute(
        """UPDATE m205_cost_links SET state='unlinked',version=2,
            unlinked_by=?,unlinked_at=?,unlink_reason=?
           WHERE tenant_id=? AND id=?""",
        (actor,now,reason,tenant,row["id"])
    )
    head=emit(db,tenant,row["plan_id"],"reconciliation",actor,
              "link_unlinked",{
                  "link_id":row["id"],"reason":reason,"actor":actor,"at":now
              },now)
    return {"link_id":row["id"],"state":"unlinked",
            "version":2,"head":head,"bank_verified":False}


def _link_status(db,tenant,row):
    economic=db.execute(
        """SELECT kind,amount_minor,state,version FROM economics_entries
           WHERE tenant_id=? AND id=? AND plan_id=?""",
        (tenant,row["economic_entry_id"],row["plan_id"])
    ).fetchone()
    source=db.execute(
        """SELECT kind,amount_minor,state,version FROM delivery_finance_expenses
           WHERE tenant_id=? AND project_id=? AND id=?""",
        (tenant,row["project_id"],row["expense_id"])
    ).fetchone()
    if economic is None or source is None:
        return "SOURCE_MISSING"
    if economic["state"]!="active" or source["state"]!="active":
        return "SOURCE_VOIDED"
    if (economic["version"]!=row["economic_version"]
            or source["version"]!=row["source_version"]):
        return "SOURCE_VERSION_CHANGED"
    if (economic["kind"]!=row["cost_kind"] or
        source["kind"]!=KINDS.get(row["cost_kind"]) or
        source["amount_minor"]!=row["amount_minor"] or
        economic["amount_minor"]!=row["amount_minor"]):
        return "AMOUNT_OR_KIND_CHANGED"
    return "MATCHED_LOCAL_RECORDS"


def inspect(db,tenant,plan_id,limit=100):
    if type(limit) is not int or not 1<=limit<=200:
        raise Invalid("limit must be integer from 1 to 200")
    economic=ledger(db,tenant,plan_id,limit=1)
    integrity=verify_links(db,tenant,plan_id)
    all_entries=db.execute(
        """SELECT * FROM economics_entries
           WHERE tenant_id=? AND plan_id=? AND state='active'
           AND kind IN ('cost_planned','cost_incurred')""",
        (tenant,plan_id)
    ).fetchall()
    links=db.execute(
        """SELECT * FROM m205_cost_links
           WHERE tenant_id=? AND plan_id=? ORDER BY created_at,id""",
        (tenant,plan_id)
    ).fetchall()
    by_economic={r["economic_entry_id"]:r for r in links if r["state"]=="active"}
    evaluated=[]
    for row in links:
        item=dict(row)
        item["match_status"]=(_link_status(db,tenant,row)
                              if row["state"]=="active" else "UNLINKED")
        evaluated.append(item)
    status_by_id={row["economic_entry_id"]:row["match_status"]
                  for row in evaluated if row["state"]=="active"}
    basis={}
    candidates=[]
    for kind,source_kind in KINDS.items():
        entries=[v for v in all_entries if v["kind"]==kind]
        matched=[v for v in entries
                 if status_by_id.get(v["id"])=="MATCHED_LOCAL_RECORDS"]
        stale=[v for v in entries
               if v["id"] in by_economic and
               status_by_id.get(v["id"])!="MATCHED_LOCAL_RECORDS"]
        missing=[v for v in entries if v["id"] not in by_economic]
        basis[kind]={
            "entry_count":len(entries),
            "linked_valid_count":len(matched),
            "unlinked_count":len(missing),
            "stale_link_count":len(stale),
            "total_cost_minor":sum(v["amount_minor"] for v in entries),
            "linked_cost_minor":sum(v["amount_minor"] for v in matched),
            "complete":bool(entries) and len(matched)==len(entries),
            "bank_verified":False,
        }
        # Suggestions are NOT evidence. Equal amount/type may be coincidence.
        for item in missing[:30]:
            rows=db.execute(
                """SELECT e.id,e.project_id,e.amount_minor,e.kind,e.version
                   FROM delivery_finance_expenses e
                   WHERE e.tenant_id=? AND e.kind=? AND e.state='active'
                     AND e.amount_minor=?
                     AND NOT EXISTS (
                       SELECT 1 FROM m205_cost_links l
                       WHERE l.tenant_id=e.tenant_id
                         AND l.expense_id=e.id AND l.state='active'
                     )
                   ORDER BY e.created_at,e.id LIMIT 6""",
                (tenant,source_kind,item["amount_minor"])
            ).fetchall()
            if rows:
                candidates.append({
                    "economic_entry_id":item["id"],
                    "potential_matches":[dict(r) for r in rows[:5]],
                    "candidates_truncated":len(rows)>5,
                    "must_confirm_manually":True,
                })
    return {
        "plan_id":plan_id,"basis":basis,
        "links":evaluated[-limit:],"links_total":len(evaluated),
        "links_truncated":len(evaluated)>limit,
        "candidate_groups":candidates,
        "candidate_groups_truncated":sum(v["unlinked_count"] for v in basis.values())>60,
        "integrity":integrity,
        "double_count_prevention":"USE_M204_ENTRY_ONCE; M198_IS_EVIDENCE_ONLY",
        "expense_source":"M198_LOCAL_MANUAL_DATA",
        "bank_verified":False,
        "independently_audited":False,
    }
