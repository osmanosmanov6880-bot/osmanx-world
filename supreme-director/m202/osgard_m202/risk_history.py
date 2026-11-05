"""M202: append-only, hash-chained snapshots of deterministic financial risk checks.

Local SHA-256 detects many alterations, but is not an independent signature.
No person, customer or document bytes are stored in snapshots.
"""
from __future__ import annotations

from hashlib import sha256
import json

from osgard_m192.runtime import Conflict, Invalid, canonical, _uid, _identifier
from osgard_m200.model import integer
from osgard_m201.runtime import _snapshot

GENESIS = "0" * 64
MAX_HISTORY = 5000


def fingerprint(event):
    return sha256(canonical(event).encode("ascii")).hexdigest()


def capture(db, identity, policy_row, policy, at, actor, origin):
    tenant = identity["tenant_id"]
    current = _snapshot(db, identity, policy, at)
    last = db.execute(
        """SELECT seq,chain_hash FROM financial_risk_snapshots
           WHERE tenant_id=? ORDER BY seq DESC LIMIT 1""", (tenant,)
    ).fetchone()
    prev = last["chain_hash"] if last else GENESIS
    record = {
        "tenant_id": tenant, "id": _uid(), "created_at": at, "actor": actor,
        "origin": origin, "policy_version": policy_row["version"],
        "rules": current["rules"], "cashflow": current["cashflow"],
        "over_budget_project_count": current["over_budget_project_count"],
        "previous_hash": prev,
    }
    digest = fingerprint(record)
    db.execute(
        """INSERT INTO financial_risk_snapshots
           (tenant_id,id,created_at,actor,origin,policy_version,
            rules_json,cashflow_json,overbudget_count,previous_hash,chain_hash)
           VALUES (?,?,?,?,?,?,?,?,?,?,?)""",
        (tenant, record["id"], at, actor, origin, policy_row["version"],
         canonical(current["rules"]), canonical(current["cashflow"]),
         current["over_budget_project_count"], prev, digest)
    )
    return {
        "id":record["id"], "created_at":at, "chain_hash":digest,
        "policy_version":policy_row["version"],
        "active_rule_count":sum(x["present"] for x in current["rules"]),
        "bank_verified":False, "external_anchor":False,
    }, current


def _rehydrate(row):
    return {
        "tenant_id":row["tenant_id"],"id":row["id"],
        "created_at":row["created_at"],"actor":row["actor"],
        "origin":row["origin"],"policy_version":row["policy_version"],
        "rules":json.loads(row["rules_json"]),
        "cashflow":json.loads(row["cashflow_json"]),
        "over_budget_project_count":row["overbudget_count"],
        "previous_hash":row["previous_hash"],
    }


def verified_history(db, tenant):
    rows = db.execute(
        """SELECT * FROM financial_risk_snapshots
           WHERE tenant_id=? ORDER BY seq""", (tenant,)
    ).fetchall()
    if len(rows) > MAX_HISTORY:
        raise Invalid("too many snapshots to verify safely; export and archive first")
    prev = GENESIS
    out = []
    for row in rows:
        value = _rehydrate(row)
        if (canonical(value["rules"])!=row["rules_json"]
            or canonical(value["cashflow"])!=row["cashflow_json"]
            or row["previous_hash"] != prev
            or row["chain_hash"] != fingerprint(value)):
            raise Conflict("M202 snapshot chain integrity violation")
        prev = row["chain_hash"]
        out.append({**value, "chain_hash":prev})
    return out


def history(db, tenant, limit=60):
    integer(limit,"limit",1,200)
    rows=verified_history(db,tenant)
    return {
        "total":len(rows), "truncated":len(rows)>limit,
        "head":rows[-1]["chain_hash"] if rows else GENESIS,
        "snapshots":[public_snapshot(row) for row in rows[-limit:]],
        "external_anchor":False,"bank_verified":False,
    }


def public_snapshot(row):
    return {
        "id":row["id"], "created_at":row["created_at"],
        "origin":row["origin"], "policy_version":row["policy_version"],
        "active_rule_count":sum(x["present"] for x in row["rules"]),
        "rules":row["rules"], "cashflow":row["cashflow"],
        "over_budget_project_count":row["over_budget_project_count"],
        "chain_hash":row["chain_hash"],
    }


def comparison(db, tenant, previous_id, current_id):
    _identifier(previous_id,"previous snapshot")
    _identifier(current_id,"current snapshot")
    snapshots=verified_history(db,tenant)
    indexed={r["id"]:r for r in snapshots}
    if previous_id not in indexed or current_id not in indexed:
        raise Invalid("snapshots missing or outside organization")
    old,new=indexed[previous_id],indexed[current_id]
    if old["created_at"] > new["created_at"]:
        raise Invalid("previous snapshot must not be newer than current snapshot")
    before={x["rule"]:x for x in old["rules"]}
    after={x["rule"]:x for x in new["rules"]}
    deltas=[]
    for rule in sorted(set(before)|set(after)):
        a,b=before.get(rule),after.get(rule)
        if not a or not b:
            raise Conflict("risk rule set changed unexpectedly")
        deltas.append({
            "rule":rule, "before":a["observed"],"after":b["observed"],
            "delta":b["observed"]-a["observed"],
            "was_active":a["present"], "is_active":b["present"],
            "became_active":not a["present"] and b["present"],
            "resolved":a["present"] and not b["present"],
            "unit":b["unit"],
        })
    return {
        "previous_id":old["id"],"current_id":new["id"],
        "previous_at":old["created_at"],"current_at":new["created_at"],
        "previous_policy_version":old["policy_version"],
        "current_policy_version":new["policy_version"],
        "deltas":deltas, "bank_verified":False,
    }
