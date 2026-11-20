"""M202 employee response SLA and escalation ledger, strictly local.

Escalations are recorded on an explicit refresh or due schedule run.
No employee is autonomously messaged, billed or reassigned.
"""
from __future__ import annotations
from hashlib import sha256
import json
from osgard_m192.runtime import Conflict, Invalid, canonical, _uid
from osgard_m200.model import integer

GENESIS = "0"*64
KINDS = ("ACK_OVERDUE","RESOLUTION_OVERDUE","WORK_DUE_OVERDUE")
MAX_EVENTS = 10000


def _event(db,tenant,escalation_id,actor,kind,reason,now):
    row=db.execute(
        """SELECT event_hash FROM financial_sla_events
           WHERE tenant_id=? AND escalation_id=? ORDER BY seq DESC LIMIT 1""",
        (tenant,escalation_id)
    ).fetchone()
    previous=row["event_hash"] if row else GENESIS
    source={"tenant":tenant,"escalation_id":escalation_id,
            "actor":actor,"kind":kind,"reason":reason,"at":now,
            "previous_hash":previous}
    digest=sha256(canonical(source).encode("ascii")).hexdigest()
    db.execute(
        """INSERT INTO financial_sla_events
           (tenant_id,escalation_id,actor,kind,reason_json,at,
            previous_hash,event_hash)
           VALUES(?,?,?,?,?,?,?,?)""",
        (tenant,escalation_id,actor,kind,canonical(reason),now,previous,digest))
    return digest


def verify_events(db,tenant):
    rows=db.execute(
        "SELECT * FROM financial_sla_events WHERE tenant_id=? ORDER BY seq",
        (tenant,)
    ).fetchall()
    if len(rows)>MAX_EVENTS:
        raise Invalid("too many SLA events to verify; archive with an external anchor")
    prev={}
    for r in rows:
        key=r["escalation_id"]
        prior=prev.get(key,GENESIS)
        reason=json.loads(r["reason_json"])
        source={"tenant":r["tenant_id"],"escalation_id":key,
                "actor":r["actor"],"kind":r["kind"],
                "reason":reason,"at":r["at"],"previous_hash":prior}
        digest=sha256(canonical(source).encode("ascii")).hexdigest()
        if (r["previous_hash"]!=prior or r["event_hash"]!=digest
            or r["reason_json"]!=canonical(reason)):
            raise Conflict("SLA append-only history verification failed")
        prev[key]=digest
    return {"events":len(rows),"checked":True,"independently_anchored":False}


def _candidates(db,tenant,now,ack_sla,resolution_sla):
    rows=db.execute("""
      SELECT a.id,a.rule,a.status,a.created_at,a.work_id,
             w.assignee AS work_assignee,w.status AS work_status,
             w.due_at AS work_due
      FROM financial_alerts a
      LEFT JOIN team_work w
        ON w.tenant_id=a.tenant_id AND w.id=a.work_id
      WHERE a.tenant_id=?
      ORDER BY a.created_at,a.id
    """,(tenant,)).fetchall()
    active={}
    for row in rows:
        r=dict(row)
        if r["status"] not in ("open","acknowledged"):
            continue
        alert_id=r["id"]
        if r["status"]=="open" and now > r["created_at"]+ack_sla:
            active[(alert_id,"ACK_OVERDUE")]={
                "rule":r["rule"],"assignee":r["work_assignee"],
                "deadline":r["created_at"]+ack_sla,
            }
        if now > r["created_at"]+resolution_sla:
            active[(alert_id,"RESOLUTION_OVERDUE")]={
                "rule":r["rule"],"assignee":r["work_assignee"],
                "deadline":r["created_at"]+resolution_sla,
            }
        if (r["work_id"] and r["work_status"] in ("open","in_progress")
            and r["work_due"] is not None and now > r["work_due"]):
            active[(alert_id,"WORK_DUE_OVERDUE")]={
                "rule":r["rule"],"assignee":r["work_assignee"],
                "deadline":r["work_due"],
            }
    return active


def _episode(db,tenant,alert_id,kind):
    return db.execute(
        """SELECT e.* FROM financial_sla_state s
           JOIN financial_sla_episodes e ON e.id=s.episode_id
                  AND e.tenant_id=s.tenant_id
           WHERE s.tenant_id=? AND s.alert_id=? AND s.kind=?""",
        (tenant,alert_id,kind)
    ).fetchone()


def refresh_sla(db,identity,settings,now,actor):
    tenant=identity["tenant_id"]
    verify_events(db,tenant)
    active=_candidates(db,tenant,now,settings["ack_sla_seconds"],
                       settings["resolve_sla_seconds"])
    created,cleared,suppressed=[],[],[]
    prior=db.execute(
        """SELECT s.alert_id,s.kind,s.episode_id,e.episode,e.state
           FROM financial_sla_state s
           JOIN financial_sla_episodes e
             ON e.id=s.episode_id AND e.tenant_id=s.tenant_id
           WHERE s.tenant_id=?""",(tenant,)
    ).fetchall()
    existing={(r["alert_id"],r["kind"]):r for r in prior}
    for key,reason in active.items():
        old=existing.get(key)
        if old and old["state"]=="active":
            suppressed.append(old["episode_id"])
            continue
        incident_id,kind=key
        episode=old["episode"]+1 if old else 1
        ep_id=_uid()
        db.execute("""
          INSERT INTO financial_sla_episodes
          (id,tenant_id,alert_id,kind,episode,state,deadline,
           assignee,created_at,closed_at) VALUES(?,?,?,?,?,?,?,?,?,?)
        """,(ep_id,tenant,incident_id,kind,episode,"active",
             reason["deadline"],reason["assignee"],now,None))
        if old:
            db.execute(
                """UPDATE financial_sla_state SET episode_id=?,updated_at=?
                   WHERE tenant_id=? AND alert_id=? AND kind=?""",
                (ep_id,now,tenant,incident_id,kind)
            )
        else:
            db.execute(
                """INSERT INTO financial_sla_state VALUES(?,?,?,?,?)""",
                (tenant,incident_id,kind,ep_id,now)
            )
        _event(db,tenant,ep_id,actor,"opened",reason,now)
        created.append(ep_id)
    for key,row in existing.items():
        if key in active or row["state"]!="active":
            continue
        db.execute(
            """UPDATE financial_sla_episodes SET state='cleared',closed_at=?
               WHERE tenant_id=? AND id=?""",
            (now,tenant,row["episode_id"])
        )
        _event(db,tenant,row["episode_id"],actor,"cleared",
               {"alert_id":key[0],"kind":key[1]},now)
        cleared.append(row["episode_id"])
    return {
        "created":created,"cleared":cleared,"deduplicated":suppressed,
        "created_count":len(created),"active_count":len(active),
        "external_notifications_sent":False,
    }


def board(db,tenant,now,settings,limit=100):
    integer(limit,"limit",1,200)
    audit=verify_events(db,tenant)
    live=_candidates(db,tenant,now,settings["ack_sla_seconds"],
                     settings["resolve_sla_seconds"])
    total=db.execute("SELECT COUNT(*) FROM financial_sla_episodes WHERE tenant_id=?",
                     (tenant,)).fetchone()[0]
    items=db.execute("""
      SELECT e.*,a.rule,a.label,a.status AS alert_status,w.status AS task_status
      FROM financial_sla_episodes e
      JOIN financial_alerts a
        ON a.tenant_id=e.tenant_id AND a.id=e.alert_id
      LEFT JOIN team_work w
        ON w.tenant_id=e.tenant_id AND w.id=a.work_id
      WHERE e.tenant_id=? ORDER BY e.created_at DESC,e.id DESC LIMIT ?
    """,(tenant,limit)).fetchall()
    result=[]
    for row in items:
        x=dict(row)
        x["live_breach"]=((x["alert_id"],x["kind"]) in live)
        result.append(x)
    return {
        "items":result,"total":total,"truncated":total>len(items),
        "live_breaches_count":len(live),
        "unpersisted_breaches_count":sum(
            1 for key in live if not (row:=_episode(db,tenant,*key))
            or row["state"]!="active"
        ),
        "last_refresh_at":db.execute(
            "SELECT MAX(created_at) FROM financial_sla_episodes WHERE tenant_id=?",
            (tenant,)
        ).fetchone()[0],
        "verified_event_chain":audit["checked"],
        "external_messages_sent":False,
    }
