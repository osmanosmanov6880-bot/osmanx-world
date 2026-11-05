"""M206 append-only, tenant-scoped local evidence journal.

Each domain has an independent SHA-256 chain. These are local integrity checks,
not cryptographic signatures or independently trusted external attestations.
"""
from __future__ import annotations

from hashlib import sha256
import json

from osgard_m192.runtime import Invalid, Conflict, canonical

GENESIS="0"*64
DOMAINS=frozenset(("diagnostics","forecast"))
MAX_EVENTS=3500


def digest(value):
    return sha256(canonical(value).encode("ascii")).hexdigest()


def append(db,tenant,plan,domain,actor,action,details,at):
    if domain not in DOMAINS:
        raise Invalid("unknown M206 evidence domain")
    prior=db.execute(
        """SELECT event_hash FROM m206_events
           WHERE tenant_id=? AND plan_id=? AND domain=?
           ORDER BY seq DESC LIMIT 1""",
        (tenant,plan,domain)
    ).fetchone()
    previous=prior["event_hash"] if prior else GENESIS
    envelope={"tenant_id":tenant,"plan_id":plan,"domain":domain,
              "actor":actor,"action":action,"details":details,
              "at":at,"previous_hash":previous}
    head=digest(envelope)
    db.execute(
        """INSERT INTO m206_events
           (tenant_id,plan_id,domain,actor,action,details_json,
            at,previous_hash,event_hash)
           VALUES (?,?,?,?,?,?,?,?,?)""",
        (tenant,plan,domain,actor,action,canonical(details),at,previous,head)
    )
    return head


def verified(db,tenant,plan,domain):
    if domain not in DOMAINS:
        raise Invalid("unknown M206 evidence domain")
    rows=db.execute(
        """SELECT * FROM m206_events
           WHERE tenant_id=? AND plan_id=? AND domain=?
           ORDER BY seq LIMIT ?""",
        (tenant,plan,domain,MAX_EVENTS+1)
    ).fetchall()
    if len(rows)>MAX_EVENTS:
        raise Invalid("M206 evidence history exceeds bounded verifier")
    previous=GENESIS
    result=[]
    for row in rows:
        try:
            details=json.loads(row["details_json"])
            normalized=canonical(details)
        except (ValueError,TypeError,OverflowError) as exc:
            raise Conflict("M206 evidence event invalid JSON") from exc
        envelope={"tenant_id":tenant,"plan_id":plan,"domain":domain,
                  "actor":row["actor"],"action":row["action"],
                  "details":details,"at":row["at"],
                  "previous_hash":previous}
        head=digest(envelope)
        if (normalized!=row["details_json"] or
                row["previous_hash"]!=previous or
                row["event_hash"]!=head):
            raise Conflict("M206 evidence chain mismatch")
        previous=head
        result.append({"actor":row["actor"],"action":row["action"],
                       "details":details,"at":row["at"],"event_hash":head})
    return {"items":result,"count":len(result),"head":previous,
            "external_anchor":False,"independent_signature":False}


def require_mappable(record,keys,label):
    for field in keys:
        if record.get(field) is None and field not in record:
            raise Conflict(label+" missing "+field)


def ensure_row_matches_event(row,original,fields,label):
    if original is None:
        raise Conflict(label+" does not appear in evidence history")
    for k in fields:
        if row[k]!=original[k]:
            raise Conflict(label+" diverges from immutable evidence: "+k)
