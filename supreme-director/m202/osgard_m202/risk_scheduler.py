"""M202 local schedule configuration and due-only evaluation.

There is deliberately no daemon. A trusted OS scheduler may invoke the
one-shot CLI using a token from stdin. No HTTP egress or external messaging.
"""
from __future__ import annotations
import json

from osgard_m192.runtime import Conflict, Invalid, _object
from osgard_m200.model import integer
from osgard_m201.runtime import _policy, _snapshot
from .risk_history import capture

MIN_INTERVAL = 3600
MAX_INTERVAL = 7*86400


def schedule_status(db, tenant):
    row = db.execute("SELECT * FROM financial_monitor_schedule WHERE tenant_id=?",
                     (tenant,)).fetchone()
    if row is None:
        return {
            "exists":False, "enabled":False, "version":0,
            "interval_seconds":None, "next_due_at":None,
            "last_ran_at":None, "ack_sla_seconds":None,
            "resolve_sla_seconds":None,
            "background_process_running":False,
            "external_messages_sent":False,
        }
    return {
        "exists":True, "enabled":bool(row["enabled"]),
        "version":row["version"], "interval_seconds":row["interval_seconds"],
        "next_due_at":row["next_due_at"],"last_ran_at":row["last_ran_at"],
        "ack_sla_seconds":row["ack_sla_seconds"],
        "resolve_sla_seconds":row["resolve_sla_seconds"],
        "background_process_running":False,"external_messages_sent":False,
    }


def configure(db, identity, payload, now):
    _object(payload,{
        "expected_version", "enabled", "interval_seconds",
        "ack_sla_seconds", "resolve_sla_seconds",
    })
    tenant,actor=identity["tenant_id"],identity["actor"]
    expected=integer(payload["expected_version"],"expected_version",0,1000000)
    if type(payload["enabled"]) is not bool:
        raise Invalid("enabled must be a boolean")
    interval=integer(payload["interval_seconds"],"interval_seconds",
                     MIN_INTERVAL,MAX_INTERVAL)
    ack=integer(payload["ack_sla_seconds"],"ack_sla_seconds",300,7*86400)
    resolution=integer(payload["resolve_sla_seconds"],"resolve_sla_seconds",
                       ack,30*86400)
    # A scan without a policy is not meaningful, and cannot be enabled.
    if payload["enabled"]:
        _policy(db,tenant)
    previous=db.execute(
        "SELECT * FROM financial_monitor_schedule WHERE tenant_id=?",(tenant,)
    ).fetchone()
    if previous and previous["version"]!=expected:
        raise Conflict("stale scheduler version")
    if not previous and expected:
        raise Conflict("initial scheduler version must be 0")
    next_at=(now+interval) if payload["enabled"] else None
    if previous and (bool(previous["enabled"])==payload["enabled"]
         and previous["interval_seconds"]==interval
         and previous["ack_sla_seconds"]==ack
         and previous["resolve_sla_seconds"]==resolution):
        raise Conflict("scheduler configuration unchanged")
    if previous:
        db.execute("""
            UPDATE financial_monitor_schedule
            SET enabled=?, interval_seconds=?, next_due_at=?,
                ack_sla_seconds=?, resolve_sla_seconds=?,
                version=version+1,updated_by=?,updated_at=?
            WHERE tenant_id=?
        """,(int(payload["enabled"]),interval,next_at,ack,resolution,
             actor,now,tenant))
    else:
        db.execute("""
            INSERT INTO financial_monitor_schedule
            (tenant_id,enabled,interval_seconds,next_due_at,ack_sla_seconds,
             resolve_sla_seconds,version,updated_by,updated_at,last_ran_at)
            VALUES(?,?,?,?,?,?,?,?,?,?)
        """,(tenant,int(payload["enabled"]),interval,next_at,ack,resolution,
             1,actor,now,None))
    return schedule_status(db,tenant)


def run_due(db, engine, identity, expected_version, now):
    tenant,actor=identity["tenant_id"],identity["actor"]
    expected=integer(expected_version,"expected_schedule_version",1,1000000)
    config=db.execute(
        "SELECT * FROM financial_monitor_schedule WHERE tenant_id=?",
        (tenant,)
    ).fetchone()
    if not config or config["version"]!=expected:
        raise Conflict("scheduler missing or version changed")
    if not config["enabled"]:
        return {
            "status":"DISABLED","ran":False,"external_messages_sent":False,
            "next_due_at":None,
        }
    if now < config["next_due_at"]:
        return {
            "status":"NOT_DUE","ran":False,"next_due_at":config["next_due_at"],
            "external_messages_sent":False,
        }
    policy,cfg=_policy(db,tenant)
    # All scan/snapshot/SLA state changes commit atomically under the calling
    # authenticated BEGIN IMMEDIATE transaction.
    data=_snapshot(db,identity,cfg,now)
    scanned=engine._scan(db,identity,policy,data,now)
    snap, _ = capture(db,identity,policy,cfg,now,actor,"scheduled")
    from .risk_sla import refresh_sla
    sla=refresh_sla(db,identity,config,now,actor)
    due=config["next_due_at"]
    next_due=now+config["interval_seconds"]  # skip missed intervals, no burst
    db.execute("""
      UPDATE financial_monitor_schedule
      SET next_due_at=?,last_ran_at=?,updated_at=?
      WHERE tenant_id=? AND version=?
    """,(next_due,now,now,tenant,config["version"]))
    output={
        "status":"EXECUTED","ran":True,
        "scheduled_for":due,"ran_at":now,"next_due_at":next_due,
        "alert_changes":scanned,"snapshot":snap,
        "sla_changes":sla,
        "external_messages_sent":False,"bank_verified":False,
        "production_authorized":False,
    }
    db.execute("""
      INSERT INTO financial_monitor_runs
        (id,tenant_id,scheduled_for,ran_at,policy_version,
         schedule_version,snapshot_id,result_json)
      VALUES(?,?,?,?,?,?,?,?)
    """,(snap["id"],tenant,due,now,policy["version"],config["version"],
         snap["id"],json.dumps(output,sort_keys=True,ensure_ascii=True)))
    return output


def runs(db, tenant, limit=30):
    integer(limit,"limit",1,100)
    total=db.execute("SELECT COUNT(*) FROM financial_monitor_runs WHERE tenant_id=?",
                     (tenant,)).fetchone()[0]
    rows=db.execute("""
      SELECT scheduled_for,ran_at,policy_version,schedule_version,snapshot_id
      FROM financial_monitor_runs WHERE tenant_id=?
      ORDER BY ran_at DESC,id DESC LIMIT ?
    """,(tenant,limit)).fetchall()
    return {
        "items":[dict(r) for r in rows],"total":total,
        "truncated":total>len(rows),"external_messages_sent":False,
    }
