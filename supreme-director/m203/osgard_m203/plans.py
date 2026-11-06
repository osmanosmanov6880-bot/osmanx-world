"""M203 owner-approved risk action plans and atomic M195 employee tasks.

All money and impact inputs are hypothetical local figures. M203 does not
alter payment records or mark an action successful because a task was closed.
"""
from __future__ import annotations

from hashlib import sha256
import json

from osgard_m192.runtime import (
    Conflict, Invalid, Unauthorized, canonical, _uid, _identifier, _text, _object
)
from osgard_m193.runtime import _version
from osgard_m195.runtime import _due, _active_actor, _record, _notice
from osgard_m201.runtime import _alert
from osgard_m202.risk_history import verified_history

GENESIS="0"*64
RULE_DIRECTIONS={
    "CASH_GAP":"decrease",
    "BALANCE_FLOOR":"increase",
    "OVERDUE_RECEIPTS":"decrease",
    "UNSCHEDULED_COSTS":"decrease",
    "OVER_BUDGET_PROJECTS":"decrease",
}
STATES=("draft","active","model_reviewed","cancelled")


def find_plan(db,tenant,plan_id):
    _identifier(plan_id,"plan_id")
    result=db.execute(
        "SELECT * FROM financial_action_plans WHERE tenant_id=? AND id=?",
        (tenant,plan_id)
    ).fetchone()
    if result is None:
        raise Invalid("action plan is absent from this organization")
    return result


def plan_event(db,tenant,plan_id,actor,action,details,now):
    prior=db.execute(
        """SELECT event_hash FROM financial_action_events
           WHERE tenant_id=? AND plan_id=? ORDER BY seq DESC LIMIT 1""",
        (tenant,plan_id)
    ).fetchone()
    previous=prior["event_hash"] if prior else GENESIS
    entry={
        "tenant":tenant,"plan_id":plan_id,"actor":actor,
        "action":action,"details":details,"at":now,"previous_hash":previous,
    }
    digest=sha256(canonical(entry).encode("ascii")).hexdigest()
    db.execute(
        """INSERT INTO financial_action_events
           (tenant_id,plan_id,actor,action,details_json,at,previous_hash,event_hash)
           VALUES (?,?,?,?,?,?,?,?)""",
        (tenant,plan_id,actor,action,canonical(details),now,previous,digest)
    )
    return digest


def verified_events(db,tenant,plan_id):
    find_plan(db,tenant,plan_id)
    rows=list(db.execute(
        """SELECT * FROM financial_action_events
           WHERE tenant_id=? AND plan_id=? ORDER BY seq""",
        (tenant,plan_id)
    ))
    if len(rows)>2000:
        raise Invalid("action history too long to verify safely")
    prior=GENESIS
    result=[]
    for row in rows:
        data=json.loads(row["details_json"])
        entry={"tenant":tenant,"plan_id":plan_id,"actor":row["actor"],
               "action":row["action"],"details":data,"at":row["at"],
               "previous_hash":prior}
        digest=sha256(canonical(entry).encode("ascii")).hexdigest()
        if (row["previous_hash"]!=prior or row["event_hash"]!=digest
            or row["details_json"]!=canonical(data)):
            raise Conflict("M203 action plan history integrity violation")
        prior=digest
        result.append({"actor":row["actor"],"action":row["action"],
                       "details":data,"at":row["at"],"event_hash":digest})
    return {"items":result[-200:],"total":len(result),"head":prior,
            "external_anchor":False,"bank_verified":False}


def _observed_rule(snapshot,rule):
    rows=[value for value in snapshot["rules"] if value["rule"]==rule]
    if len(rows)!=1:
        raise Conflict("source snapshot has unexpected rule set")
    return rows[0]


def source_snapshot(db,tenant,snapshot_id,rule):
    _identifier(snapshot_id,"snapshot_id")
    all_snapshots=verified_history(db,tenant)
    for seq,row in enumerate(all_snapshots):
        if row["id"]==snapshot_id:
            return seq,row,_observed_rule(row,rule)
    raise Invalid("snapshot missing or outside organization")


def create_plan(db,identity,p,now):
    _object(p,{"alert_id","expected_alert_version","baseline_snapshot_id",
               "title","hypothesis","target_value","due_at"})
    tenant,actor=identity["tenant_id"],identity["actor"]
    alert=_alert(db,tenant,p["alert_id"])
    if alert["version"]!=_version(p["expected_alert_version"]):
        raise Conflict("stale alert version")
    if alert["status"] not in ("open","acknowledged"):
        raise Conflict("only open or acknowledged alerts can receive an action plan")
    rule=alert["rule"]
    if rule not in RULE_DIRECTIONS:
        raise Invalid("unsupported financial risk rule")
    _,base,observed=source_snapshot(db,tenant,p["baseline_snapshot_id"],rule)
    if base["created_at"] < alert["created_at"] or base["created_at"] > now:
        raise Conflict("baseline observation must be within alert lifetime")
    if base["policy_version"]!=alert["policy_version"]:
        raise Conflict("baseline and alert policy versions differ")
    if not observed["present"]:
        raise Conflict("baseline did not contain the target risk")
    target=p["target_value"]
    if type(target) is not int or not 0<=target<=1_000_000_000_000_000:
        raise Invalid("target must be an integer from 0 to 10^15")
    if rule=="OVER_BUDGET_PROJECTS" and target>1000:
        raise Invalid("project-count target must be <=1000")
    if RULE_DIRECTIONS[rule]=="decrease" and target>observed["observed"]:
        raise Invalid("a decrease target cannot exceed observed value")
    if RULE_DIRECTIONS[rule]=="increase" and target<observed["observed"]:
        raise Invalid("an increase target cannot be lower than baseline")
    title=_text(p["title"],"title",160)
    hypothesis=_text(p["hypothesis"],"hypothesis",1200)
    due=_due(p["due_at"],now)
    if due is None or due<now:
        raise Invalid("plan deadline must be in the future")
    duplicate=db.execute(
        """SELECT 1 FROM financial_action_plans
           WHERE tenant_id=? AND alert_id=?
             AND status IN ('draft','active') LIMIT 1""",
        (tenant,alert["id"])
    ).fetchone()
    if duplicate:
        raise Conflict("an open action plan already exists for this alert")
    plan_id=_uid()
    db.execute(
        """INSERT INTO financial_action_plans
           (id,tenant_id,alert_id,rule,title,hypothesis,target_value,
            direction,baseline_snapshot_id,baseline_value,policy_version,
            due_at,status,version,latest_evaluation_id,created_by,
            created_at,started_at,updated_at,reviewed_at,cancelled_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
        (plan_id,tenant,alert["id"],rule,title,hypothesis,target,
         RULE_DIRECTIONS[rule],base["id"],observed["observed"],
         base["policy_version"],due,"draft",1,None,actor,
         now,None,now,None,None)
    )
    head=plan_event(db,tenant,plan_id,actor,"created",{
        "alert_id":alert["id"],"baseline_snapshot_id":base["id"],
        "baseline_hash":base["chain_hash"],"baseline_value":observed["observed"],
        "target_value":target,"due_at":due
    },now)
    return {"id":plan_id,"version":1,"status":"draft",
            "baseline_value":observed["observed"],
            "target_value":target,"direction":RULE_DIRECTIONS[rule],
            "history_head":head,"bank_verified":False}


def add_step(db,identity,p,now):
    _object(p,{"plan_id","expected_version","title","description",
               "assignee","due_at"})
    tenant,actor=identity["tenant_id"],identity["actor"]
    plan=find_plan(db,tenant,p["plan_id"])
    if plan["version"]!=_version(p["expected_version"]):
        raise Conflict("stale plan version")
    if plan["status"] not in ("draft","active"):
        raise Conflict("cannot add work to a closed action plan")
    count=db.execute(
        "SELECT COUNT(*) FROM financial_action_steps WHERE tenant_id=? AND plan_id=?",
        (tenant,plan["id"])
    ).fetchone()[0]
    if count>=30:
        raise Invalid("maximum 30 steps in an action plan")
    assignee=_active_actor(db,tenant,p["assignee"],now)
    title=_text(p["title"],"title",160)
    description=_text(p["description"],"description",1200)
    due=_due(p["due_at"],now)
    if due is None or due<now:
        raise Invalid("task deadline must be in the future")
    if due>plan["due_at"]:
        raise Invalid("step deadline exceeds the plan deadline")
    work_id=_uid()
    full_description=(
        "OSGARD M203: "+description+"; проверка исполнения в локальной системе. "
        "Выполненная задача не доказывает улучшение финансовых показателей."
    )
    db.execute(
        """INSERT INTO team_work VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
        (work_id,tenant,title,full_description,assignee,actor,"high",
         "open",None,due,1,now,now,None)
    )
    task_head=_record(db,tenant,work_id,actor,"created",{
        "title":title,"description":full_description,"priority":"high",
        "assignee":assignee,"due_at":due,"crm_activity_id":None
    },now)
    if assignee!=actor:
        _notice(db,tenant,assignee,work_id,"assignment",1,
                "Вам назначена задача плана M203: "+title,now)
    step_id=_uid()
    db.execute(
        """INSERT INTO financial_action_steps
           (id,tenant_id,plan_id,work_id,created_by,created_at)
           VALUES (?,?,?,?,?,?)""",
        (step_id,tenant,plan["id"],work_id,actor,now)
    )
    db.execute(
        """UPDATE financial_action_plans SET version=version+1,
           latest_evaluation_id=NULL,updated_at=? WHERE tenant_id=? AND id=?""",
        (now,tenant,plan["id"])
    )
    head=plan_event(db,tenant,plan["id"],actor,"step_created",{
        "step_id":step_id,"work_id":work_id,"assignee":assignee,"due_at":due,
        "plan_version":plan["version"]+1
    },now)
    return {"step_id":step_id,"work_id":work_id,"task_version":1,
            "plan_id":plan["id"],"plan_version":plan["version"]+1,
            "assignee":assignee,"history_head":head,
            "task_history_head":task_head,"external_notifications_sent":False}


def start_plan(db,identity,p,now):
    _object(p,{"plan_id","expected_version"})
    tenant,actor=identity["tenant_id"],identity["actor"]
    row=find_plan(db,tenant,p["plan_id"])
    if row["version"]!=_version(p["expected_version"]):
        raise Conflict("stale plan version")
    if row["status"]!="draft":
        raise Conflict("only a draft plan can be started")
    count=db.execute(
        """SELECT COUNT(*) FROM financial_action_steps
           WHERE tenant_id=? AND plan_id=?""",(tenant,row["id"])
    ).fetchone()[0]
    if count==0:
        raise Conflict("add at least one responsible employee task before starting")
    if row["due_at"]<now:
        raise Conflict("plan deadline has already passed")
    db.execute(
        """UPDATE financial_action_plans SET status='active',
           version=version+1,started_at=?,updated_at=?
           WHERE tenant_id=? AND id=?""",
        (now,now,tenant,row["id"])
    )
    head=plan_event(db,tenant,row["id"],actor,"started",{
        "step_count":count,"plan_version":row["version"]+1
    },now)
    return {"plan_id":row["id"],"status":"active",
            "version":row["version"]+1,"history_head":head}


def cancel_plan(db,identity,p,now):
    _object(p,{"plan_id","expected_version","reason"})
    tenant,actor=identity["tenant_id"],identity["actor"]
    row=find_plan(db,tenant,p["plan_id"])
    if row["version"]!=_version(p["expected_version"]):
        raise Conflict("stale plan version")
    if row["status"] not in ("draft","active"):
        raise Conflict("plan is already closed")
    reason=_text(p["reason"],"reason",500)
    tasks=[dict(v) for v in db.execute(
        """SELECT w.id,w.status FROM financial_action_steps s
           JOIN team_work w ON w.tenant_id=s.tenant_id AND w.id=s.work_id
           WHERE s.tenant_id=? AND s.plan_id=?""",(tenant,row["id"])
    )]
    db.execute(
        """UPDATE financial_action_plans SET status='cancelled',
           version=version+1,updated_at=?,cancelled_at=?
           WHERE tenant_id=? AND id=?""",
        (now,now,tenant,row["id"])
    )
    head=plan_event(db,tenant,row["id"],actor,"cancelled",{
        "reason":reason,"linked_task_count":len(tasks),
        "tasks_not_auto_cancelled":True
    },now)
    return {"plan_id":row["id"],"status":"cancelled",
            "version":row["version"]+1,
            "remaining_task_ids":[v["id"] for v in tasks
                                  if v["status"] not in ("done","cancelled")],
            "tasks_cancelled_automatically":False,"history_head":head}


def plan_steps(db,tenant,plan_id):
    return [dict(row) for row in db.execute(
        """SELECT s.id AS step_id,s.work_id,w.title,w.description,w.assignee,
                  w.status,w.version AS work_version,w.due_at,
                  w.finished_at,w.created_at
           FROM financial_action_steps s JOIN team_work w
             ON w.id=s.work_id AND w.tenant_id=s.tenant_id
           WHERE s.tenant_id=? AND s.plan_id=? ORDER BY s.created_at,s.id""",
        (tenant,plan_id)
    )]


def expose_plan(db,tenant,row):
    d=dict(row)
    d["steps"]=plan_steps(db,tenant,row["id"])
    d["total_steps"]=len(d["steps"])
    d["done_steps"]=sum(s["status"]=="done" for s in d["steps"])
    d["cancelled_steps"]=sum(s["status"]=="cancelled" for s in d["steps"])
    if d["latest_evaluation_id"]:
        ev=db.execute(
            """SELECT * FROM financial_action_evaluations
               WHERE tenant_id=? AND id=?""",
            (tenant,d["latest_evaluation_id"])
        ).fetchone()
        d["latest_evaluation"]=dict(ev) if ev else None
    else:
        d["latest_evaluation"]=None
    d["model_only"]=True
    d["bank_verified"]=False
    return d


def list_plans(db,tenant,p):
    _object(p,set(),{"status","limit"})
    state=p.get("status")
    if state is not None and state not in STATES:
        raise Invalid("unknown plan status")
    limit=p.get("limit",100)
    if type(limit) is not int or not 1<=limit<=200:
        raise Invalid("limit must be integer from 1 to 200")
    sql="SELECT * FROM financial_action_plans WHERE tenant_id=?"
    params=[tenant]
    if state:
        sql+=" AND status=?"
        params.append(state)
    count=db.execute(
        "SELECT COUNT(*) FROM financial_action_plans WHERE tenant_id=?"+
        (" AND status=?" if state else ""),
        (tenant,state) if state else (tenant,)
    ).fetchone()[0]
    sql+=" ORDER BY created_at DESC,id DESC LIMIT ?"
    params.append(limit)
    items=[expose_plan(db,tenant,row) for row in db.execute(sql,params)]
    return {"items":items,"total":count,"truncated":count>len(items),
            "bank_verified":False}


def mine(db,identity,p):
    _object(p,set(),{"limit"})
    limit=p.get("limit",100)
    if type(limit) is not int or not 1<=limit<=100:
        raise Invalid("limit must be 1..100")
    tenant,actor=identity["tenant_id"],identity["actor"]
    rows=db.execute(
        """SELECT s.work_id,w.title,w.status,w.due_at,w.version AS work_version,
                  p.id AS plan_id,p.title AS plan_title,p.status AS plan_status
           FROM financial_action_steps s
           JOIN team_work w ON w.tenant_id=s.tenant_id AND w.id=s.work_id
           JOIN financial_action_plans p
             ON p.tenant_id=s.tenant_id AND p.id=s.plan_id
           WHERE s.tenant_id=? AND w.assignee=?
           ORDER BY s.created_at DESC,s.id DESC LIMIT ?""",
        (tenant,actor,limit)
    )
    return {"items":[dict(row) for row in rows],
            "scope":"ASSIGNED_WORK_ONLY","financial_metrics_redacted":True}
