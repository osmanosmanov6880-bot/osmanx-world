"""M205 local append-only evidence: per-tenant, per-plan, per-domain SHA-256.

A hash chain in the same SQLite is a tamper-evident convenience, NOT an
externally anchored signature. Rows are revalidated against its events.
"""
from __future__ import annotations

from hashlib import sha256
import json

from osgard_m192.runtime import Conflict, Invalid, canonical

GENESIS="0"*64
DOMAINS=frozenset(("reconciliation","recurring"))
MAX_EVENTS=3000


def emit(db,tenant,plan_id,domain,actor,action,details,now):
    if domain not in DOMAINS:
        raise Invalid("unknown M205 audit domain")
    row=db.execute(
        """SELECT event_hash FROM m205_events
           WHERE tenant_id=? AND plan_id=? AND domain=?
           ORDER BY seq DESC LIMIT 1""",
        (tenant,plan_id,domain)
    ).fetchone()
    previous=row["event_hash"] if row else GENESIS
    event={"tenant_id":tenant,"plan_id":plan_id,"domain":domain,
           "actor":actor,"action":action,"details":details,
           "at":now,"previous_hash":previous}
    h=sha256(canonical(event).encode("ascii")).hexdigest()
    db.execute(
        """INSERT INTO m205_events
           (tenant_id,plan_id,domain,actor,action,details_json,at,
            previous_hash,event_hash)
           VALUES (?,?,?,?,?,?,?,?,?)""",
        (tenant,plan_id,domain,actor,action,canonical(details),now,previous,h)
    )
    return h


def verified(db,tenant,plan_id,domain):
    if domain not in DOMAINS:
        raise Invalid("unknown M205 audit domain")
    rows=db.execute(
        """SELECT * FROM m205_events
           WHERE tenant_id=? AND plan_id=? AND domain=?
           ORDER BY seq LIMIT ?""",
        (tenant,plan_id,domain,MAX_EVENTS+1)
    ).fetchall()
    if len(rows)>MAX_EVENTS:
        raise Invalid("M205 event verification limit exceeded")
    previous=GENESIS
    data=[]
    for r in rows:
        try:
            details=json.loads(r["details_json"])
            canonical_details=canonical(details)
        except (ValueError,TypeError,OverflowError) as exc:
            raise Conflict("M205 audit event payload corrupted") from exc
        event={"tenant_id":r["tenant_id"],"plan_id":r["plan_id"],
               "domain":r["domain"],"actor":r["actor"],
               "action":r["action"],"details":details,
               "at":r["at"],"previous_hash":previous}
        h=sha256(canonical(event).encode("ascii")).hexdigest()
        if (r["previous_hash"]!=previous or r["event_hash"]!=h
                or canonical_details!=r["details_json"]):
            raise Conflict("M205 local event chain integrity violation")
        previous=h
        data.append({"action":r["action"],"details":details,
                     "at":r["at"],"actor":r["actor"],"hash":h})
    return {"events":data,"count":len(data),"head":previous,
            "externally_anchored":False}
