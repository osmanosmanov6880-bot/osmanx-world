"""M203 before/after measurement with explicit owner review.

A target reached in local model data is NOT proof of causation, collected
money, or real-world financial impact. Acceptance is labelled model-only.
"""
from __future__ import annotations

from osgard_m192.runtime import Conflict, Invalid, _uid, _object, _text, _identifier
from osgard_m193.runtime import _version
from osgard_m202.risk_history import verified_history
from .plans import find_plan, plan_steps, plan_event, verified_events, _observed_rule


def _snapshots(db,tenant):
    return verified_history(db,tenant)


def evaluate(db,identity,p,now):
    _object(p,{"plan_id","expected_version","outcome_snapshot_id"})
    tenant,actor=identity["tenant_id"],identity["actor"]
    plan=find_plan(db,tenant,p["plan_id"])
    if plan["version"]!=_version(p["expected_version"]):
        raise Conflict("stale plan version")
    if plan["status"]!="active":
        raise Conflict("only active plans can be evaluated")
    verified_events(db,tenant,plan["id"])
    _identifier(p["outcome_snapshot_id"],"outcome_snapshot_id")
    source=_snapshots(db,tenant)
    positions={s["id"]:i for i,s in enumerate(source)}
    base_idx=positions.get(plan["baseline_snapshot_id"])
    latest_idx=positions.get(p["outcome_snapshot_id"])
    if base_idx is None or latest_idx is None:
        raise Invalid("baseline or outcome snapshot does not exist for this tenant")
    if latest_idx<=base_idx:
        raise Conflict("outcome snapshot must be later than baseline")
    baseline,latest=source[base_idx],source[latest_idx]
    if baseline["policy_version"]!=plan["policy_version"]:
        raise Conflict("baseline policy version changed")
    if latest["policy_version"]!=plan["policy_version"]:
        raise Conflict("cannot compare observations under different policy versions")
    if latest["created_at"]<=plan["started_at"] or latest["created_at"]>now:
        raise Conflict("outcome observation must follow plan activation")
    base_metric=_observed_rule(baseline,plan["rule"])
    metric=_observed_rule(latest,plan["rule"])
    if base_metric["observed"]!=plan["baseline_value"]:
        raise Conflict("baseline value and stored plan disagree")
    if base_metric["unit"]!=metric["unit"]:
        raise Conflict("financial metric units are not comparable")
    existing=db.execute(
        """SELECT id FROM financial_action_evaluations
           WHERE tenant_id=? AND plan_id=? AND snapshot_id=?""",
        (tenant,plan["id"],latest["id"])
    ).fetchone()
    if existing:
        raise Conflict("that snapshot was already evaluated for this plan")
    steps=plan_steps(db,tenant,plan["id"])
    if not steps:
        raise Conflict("plan has no responsible employee tasks")
    finished=sum(s["status"]=="done" for s in steps)
    all_done=finished==len(steps)
    observed=metric["observed"]
    improvement=(observed-plan["baseline_value"] if
                 plan["direction"]=="increase" else
                 plan["baseline_value"]-observed)
    metric_reached=(observed>=plan["target_value"] if
                    plan["direction"]=="increase" else
                    observed<=plan["target_value"])
    target_met=bool(metric_reached and not metric["present"])
    if target_met and all_done:
        judgement="MODEL_TARGET_REACHED_REVIEW_REQUIRED"
    elif not target_met:
        judgement="TARGET_NOT_REACHED"
    else:
        judgement="TASKS_NOT_FINISHED"
    evaluation_id=_uid()
    db.execute(
        """INSERT INTO financial_action_evaluations
           (id,tenant_id,plan_id,snapshot_id,snapshot_hash,
            policy_version,baseline_value,observed_value,improvement_value,
            target_met,finished_tasks,total_tasks,judgement,created_by,created_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
        (evaluation_id,tenant,plan["id"],latest["id"],latest["chain_hash"],
         latest["policy_version"],plan["baseline_value"],observed,improvement,
         int(target_met),finished,len(steps),judgement,actor,now)
    )
    db.execute(
        """UPDATE financial_action_plans
           SET latest_evaluation_id=?,version=version+1,updated_at=?
           WHERE tenant_id=? AND id=?""",
        (evaluation_id,now,tenant,plan["id"])
    )
    head=plan_event(db,tenant,plan["id"],actor,"evaluated",{
        "evaluation_id":evaluation_id,"snapshot_id":latest["id"],
        "snapshot_hash":latest["chain_hash"],"observed":observed,
        "target_met":target_met,"finished_tasks":finished,
        "total_tasks":len(steps),"judgement":judgement,
        "plan_version":plan["version"]+1
    },now)
    return {
        "evaluation_id":evaluation_id,"plan_id":plan["id"],
        "plan_version":plan["version"]+1,
        "baseline_value":plan["baseline_value"],"observed_value":observed,
        "improvement_value":improvement,"target_value":plan["target_value"],
        "target_met":target_met,"tasks_done":finished,
        "tasks_total":len(steps),"judgement":judgement,
        "snapshot_hash":latest["chain_hash"],"history_head":head,
        "causation_proven":False,"bank_verified":False,
        "independently_audited":False,
    }


def review(db,identity,p,now):
    _object(p,{"plan_id","expected_version","evaluation_id",
               "approved","reason"})
    tenant,actor=identity["tenant_id"],identity["actor"]
    plan=find_plan(db,tenant,p["plan_id"])
    if plan["version"]!=_version(p["expected_version"]):
        raise Conflict("stale plan version")
    if plan["status"]!="active":
        raise Conflict("only active plans can be reviewed")
    if type(p["approved"]) is not bool:
        raise Invalid("approved must be boolean")
    reason=_text(p["reason"],"review reason",600)
    _identifier(p["evaluation_id"],"evaluation_id")
    if plan["latest_evaluation_id"]!=p["evaluation_id"]:
        raise Conflict("review requires latest evaluation")
    evaluation=db.execute(
        """SELECT * FROM financial_action_evaluations
           WHERE tenant_id=? AND plan_id=? AND id=?""",
        (tenant,plan["id"],p["evaluation_id"])
    ).fetchone()
    if evaluation is None:
        raise Invalid("evaluation missing or from another plan")
    verified_events(db,tenant,plan["id"])
    history=_snapshots(db,tenant)
    if not history or history[-1]["id"]!=evaluation["snapshot_id"]:
        raise Conflict("a newer snapshot exists; reevaluate current results")
    if history[-1]["chain_hash"]!=evaluation["snapshot_hash"]:
        raise Conflict("evaluation evidence hash mismatch")
    if p["approved"]:
        if evaluation["judgement"]!="MODEL_TARGET_REACHED_REVIEW_REQUIRED":
            raise Conflict("model target and tasks must both be completed")
        tasks=plan_steps(db,tenant,plan["id"])
        if not tasks or any(s["status"]!="done" for s in tasks):
            raise Conflict("task state changed since evaluation")
    existing=db.execute(
        "SELECT 1 FROM financial_action_reviews WHERE tenant_id=? AND evaluation_id=?",
        (tenant,evaluation["id"])
    ).fetchone()
    if existing:
        raise Conflict("evaluation already reviewed")
    review_id=_uid()
    decision="MODEL_RESULT_ACCEPTED" if p["approved"] else "RETURNED_FOR_WORK"
    db.execute(
        """INSERT INTO financial_action_reviews
           (id,tenant_id,plan_id,evaluation_id,approved,reason,reviewed_by,created_at)
           VALUES (?,?,?,?,?,?,?,?)""",
        (review_id,tenant,plan["id"],evaluation["id"],int(p["approved"]),
         reason,actor,now)
    )
    new_status="model_reviewed" if p["approved"] else "active"
    db.execute(
        """UPDATE financial_action_plans SET status=?,version=version+1,
           latest_evaluation_id=?,updated_at=?,reviewed_at=?
           WHERE tenant_id=? AND id=?""",
        (new_status,None if not p["approved"] else evaluation["id"],
         now,now if p["approved"] else None,tenant,plan["id"])
    )
    head=plan_event(db,tenant,plan["id"],actor,"reviewed",{
        "review_id":review_id,"evaluation_id":evaluation["id"],
        "decision":decision,"reason":reason,
        "plan_version":plan["version"]+1
    },now)
    return {
        "review_id":review_id,"plan_id":plan["id"],"status":new_status,
        "decision":decision,"plan_version":plan["version"]+1,
        "history_head":head,"bank_verified":False,
        "causation_proven":False,
        "human_reviewed_model_result":bool(p["approved"]),
        "external_payment_executed":False,
    }
