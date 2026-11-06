"""TITAN-X27 partial: tenant-scoped, metadata-only chained audit events.

Hash chaining detects accidental and some deliberate tampering. A database
administrator can rewrite the chain; independent externally pinned checkpoints
and signatures are required before production audit claims.
"""
from __future__ import annotations
from contextlib import contextmanager
from pathlib import Path
import json
import re
import sqlite3
import uuid

from .contracts import ACTOR_RE, TENANT_RE, digest

EVENTS=frozenset((
    "TASK_ADMITTED","LOCAL_LEASE_CREATED","CRASH_INJECTED",
    "LEASE_RECOVERED","LOCAL_RESULT_STORED","QUEUE_TAMPER_DENIED",
    "RESTORE_DRILL_VERIFIED","SANDBOX_PREPARED","SANDBOX_DENIED"
))
FIELDS=frozenset(("fence","attempt","recovered","duration_ms","operation_count"))
CODE=re.compile(r"^[A-Z][A-Z0-9_]{2,63}$")
ZERO="0"*64

class AuditDenied(ValueError):
    pass

def _identity(tenant,actor,trace_id,task_id,at_epoch,event,code,fields):
    if (type(tenant) is not str or not TENANT_RE.fullmatch(tenant)
        or type(actor) is not str or not ACTOR_RE.fullmatch(actor)
        or type(at_epoch) is not int or at_epoch<0 or event not in EVENTS):
        raise AuditDenied("Invalid audit identity, event or time")
    for value in (trace_id,task_id):
        if value is None:
            continue
        try:
            if type(value) is not str or str(uuid.UUID(value))!=value:
                raise ValueError()
        except ValueError as exc:
            raise AuditDenied("Audit IDs must be canonical UUID") from exc
    if type(code) is not str or not CODE.fullmatch(code):
        raise AuditDenied("Event code must be an approved machine-readable label")
    if (type(fields) is not dict or not set(fields)<=FIELDS
        or any(type(v) is not int or not 0<=v<=1000000000 for v in fields.values())):
        raise AuditDenied("Only bounded, nonsecret numeric metadata permitted")

class LocalAuditTrail:
    def __init__(self,path: str | Path):
        self.path=str(path)
        with self._db() as db:
            db.executescript("""CREATE TABLE IF NOT EXISTS local_audit_events(
                tenant TEXT NOT NULL, seq INTEGER NOT NULL, actor TEXT NOT NULL,
                trace_id TEXT, task_id TEXT, at_epoch INTEGER NOT NULL,
                event TEXT NOT NULL, code TEXT NOT NULL, fields_json TEXT NOT NULL,
                previous_hash TEXT NOT NULL, event_hash TEXT NOT NULL,
                PRIMARY KEY(tenant,seq));
            CREATE TRIGGER IF NOT EXISTS local_audit_no_update
                BEFORE UPDATE ON local_audit_events BEGIN
                SELECT RAISE(ABORT,'audit events cannot be updated');END;
            CREATE TRIGGER IF NOT EXISTS local_audit_no_delete
                BEFORE DELETE ON local_audit_events BEGIN
                SELECT RAISE(ABORT,'audit events cannot be deleted');END;""")

    def _db(self):
        db=sqlite3.connect(self.path,timeout=15,isolation_level=None)
        db.row_factory=sqlite3.Row
        db.execute("PRAGMA busy_timeout=15000")
        return db

    @contextmanager
    def _tx(self):
        db=self._db()
        try:
            db.execute("BEGIN IMMEDIATE")
            yield db
            db.commit()
        except BaseException:
            db.rollback()
            raise
        finally:
            db.close()

    def append(self,*,tenant:str,actor:str,trace_id:str|None,task_id:str|None,
               at_epoch:int,event:str,code:str,fields:dict) -> dict:
        _identity(tenant,actor,trace_id,task_id,at_epoch,event,code,fields)
        with self._tx() as db:
            last=db.execute("""SELECT seq,event_hash FROM local_audit_events
                WHERE tenant=? ORDER BY seq DESC LIMIT 1""",(tenant,)).fetchone()
            seq=last["seq"]+1 if last else 1
            previous=last["event_hash"] if last else ZERO
            record={"tenant":tenant,"seq":seq,"actor":actor,
                    "trace_id":trace_id,"task_id":task_id,"at_epoch":at_epoch,
                    "event":event,"code":code,"fields":fields,
                    "previous_hash":previous}
            h=digest(record)
            db.execute("""INSERT INTO local_audit_events
                (tenant,seq,actor,trace_id,task_id,at_epoch,event,code,
                 fields_json,previous_hash,event_hash)
                VALUES(?,?,?,?,?,?,?,?,?,?,?)""",
                (tenant,seq,actor,trace_id,task_id,at_epoch,event,code,
                 json.dumps(fields,sort_keys=True,separators=(",",":")),previous,h))
            return {"tenant":tenant,"sequence":seq,"checkpoint_hash":h,
                    "externally_pinned":False,"independently_verified":False}

    def verify(self,tenant:str,*,expected_head:str|None=None)->dict:
        if type(tenant) is not str or not TENANT_RE.fullmatch(tenant):
            raise AuditDenied("Explicit tenant required")
        if expected_head is not None and (type(expected_head) is not str
            or len(expected_head)!=64 or any(c not in "0123456789abcdef" for c in expected_head)):
            raise AuditDenied("Expected checkpoint malformed")
        db=self._db()
        try:
            rows=db.execute("""SELECT * FROM local_audit_events WHERE tenant=?
                ORDER BY seq""",(tenant,)).fetchall()
            prev=ZERO
            for number,row in enumerate(rows,1):
                try:fields=json.loads(row["fields_json"])
                except (ValueError,TypeError) as exc:
                    raise AuditDenied("Audit metadata corrupted") from exc
                _identity(row["tenant"],row["actor"],row["trace_id"],row["task_id"],
                          row["at_epoch"],row["event"],row["code"],fields)
                record={"tenant":row["tenant"],"seq":row["seq"],"actor":row["actor"],
                        "trace_id":row["trace_id"],"task_id":row["task_id"],
                        "at_epoch":row["at_epoch"],"event":row["event"],"code":row["code"],
                        "fields":fields,"previous_hash":row["previous_hash"]}
                if (row["seq"]!=number or row["previous_hash"]!=prev
                    or row["event_hash"]!=digest(record)):
                    raise AuditDenied("Audit hash chain broken")
                prev=row["event_hash"]
            if expected_head is not None and expected_head!=prev:
                raise AuditDenied("Externally supplied audit checkpoint differs")
            return {"tenant":tenant,"events":len(rows),"head_hash":prev,
                    "local_chain_verified":True,
                    "checkpoint_matches":expected_head is not None,
                    "externally_witnessed":False,
                    "independent_acceptance":False}
        finally:
            db.close()
