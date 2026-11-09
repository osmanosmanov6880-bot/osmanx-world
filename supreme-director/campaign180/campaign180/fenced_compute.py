"""Wave 14: durable, exactly-once ACCOUNTING for local fixed operations.

An authorized single-use permit and tenant quota are consumed in the SAME
SQLite BEGIN IMMEDIATE transaction. Completion/refund/receipt share another
transaction. If a process dies while running, expiry reclaims held quota;
the permit and task id remain spent and cannot be replayed. Only a closed
set of side-effect-free operations is supported (not general exactly-once
execution, deployment, payment or external worker safety).
"""
from __future__ import annotations
from hashlib import sha256
import json
import math
import secrets
import time

from .contracts import digest
from .local_permits import LocalPermitAuthority,PermitDenied
from .quota_ledger import TenantQuotaLedger,QuotaDenied
from .resource_limits import ResourceLimits
from .sandbox_runtime import run_allowlisted_task, _job
from .contracts import canonical

class ExecutionDenied(ValueError):
    pass

class LocalFencedExecutor:
    def __init__(self,ledger:TenantQuotaLedger,authority:LocalPermitAuthority):
        if type(ledger) is not TenantQuotaLedger or type(authority) is not LocalPermitAuthority:
            raise ExecutionDenied("Trusted shared quota database and signer required")
        self.ledger=ledger
        self.authority=authority
        with ledger._db() as db:
            db.executescript("""CREATE TABLE IF NOT EXISTS local_fixed_execution_receipts(
                tenant TEXT NOT NULL,job_key TEXT NOT NULL,task_id TEXT NOT NULL,
                permit_nonce TEXT NOT NULL,permit_sha256 TEXT NOT NULL,
                task_sha256 TEXT NOT NULL,units INTEGER NOT NULL CHECK(units>0),
                expires INTEGER NOT NULL,
                state TEXT NOT NULL CHECK(state IN ('reserved','completed','failed','expired')),
                result_sha256 TEXT,error_code TEXT,
                PRIMARY KEY(tenant,job_key),UNIQUE(tenant,task_id),
                UNIQUE(tenant,permit_nonce));
            CREATE INDEX IF NOT EXISTS local_fixed_receipts_state
                ON local_fixed_execution_receipts(state,expires);
            CREATE TRIGGER IF NOT EXISTS local_fixed_receipts_no_delete
                BEFORE DELETE ON local_fixed_execution_receipts BEGIN
                SELECT RAISE(ABORT,'execution receipts cannot be deleted');END;""")

    def _expired(self,db,now:int)->int:
        recovered=self.ledger._expire(db,now)
        db.execute("""UPDATE local_fixed_execution_receipts SET state='expired',
            error_code='LEASE_EXPIRED' WHERE state='reserved' AND expires<=?""",
            (now,))
        return recovered

    def reclaim(self,*,now:int)->dict:
        self.ledger._time(now)
        with self.ledger._tx() as db:
            recovered=self._expired(db,now)
            return {"leases_reclaimed":recovered,
                    "permit_replay_allowed":False,"customer_data_returned":False}

    def _prepare(self,*,authorization:dict,permit:dict,
                 tenant:str,actor:str,scopes:set[str],now:int,
                 limits:ResourceLimits):
        signed=self.authority.verify(permit,authorization,tenant=tenant,
                                    actor=actor,scopes=scopes,now=now)
        # Reject input/schema before touching the quota DB.
        _job(authorization["task"]["body"],limits)
        task=authorization["task"]
        job_key=task["idempotency_key"]
        permit_hash=digest(permit)
        units=signed["units"]
        if signed["expires_at"]-now<=0:
            raise ExecutionDenied("Permit cannot reserve a non-positive time window")
        with self.ledger._tx() as db:
            self._expired(db,now)
            seen=db.execute("""SELECT 1 FROM local_fixed_execution_receipts
                WHERE tenant=? AND (job_key=? OR task_id=? OR permit_nonce=?)""",
                (tenant,job_key,task["task_id"],signed["nonce"])).fetchone()
            if seen:
                raise ExecutionDenied("Previously consumed permit or task; replay denied")
            old=db.execute("""SELECT 1 FROM local_compute_leases
                WHERE tenant=? AND job_key=?""",(tenant,job_key)).fetchone()
            if old:
                raise ExecutionDenied("Task has a previously issued resource lease")
            budget=db.execute("""SELECT capacity,held,spent
                FROM local_compute_quotas WHERE tenant=?""",(tenant,)).fetchone()
            if not budget or budget["held"]+budget["spent"]+units>budget["capacity"]:
                raise ExecutionDenied("Trusted tenant compute budget exhausted")
            secret=secrets.token_hex(32)
            db.execute("""UPDATE local_compute_quotas SET held=held+? WHERE tenant=?""",
                       (units,tenant))
            db.execute("""INSERT INTO local_compute_leases
                (tenant,job_key,units,token,generation,expires,state,result_sha256)
                VALUES(?,?,?,?,1,?,'reserved',NULL)""",
                (tenant,job_key,units,secret,signed["expires_at"]))
            db.execute("""INSERT INTO local_fixed_execution_receipts
                (tenant,job_key,task_id,permit_nonce,permit_sha256,task_sha256,
                 units,expires,state,result_sha256,error_code)
                VALUES(?,?,?,?,?,?,?,?,'reserved',NULL,NULL)""",
                (tenant,job_key,task["task_id"],signed["nonce"],
                 permit_hash,signed["task_sha256"],units,signed["expires_at"]))
        return task,signed

    def _settle(self,*,task:dict,signed:dict,tenant:str,now:int,
                result_sha256:str|None,error_code:str|None)->str:
        self.ledger._time(now)
        with self.ledger._tx() as db:
            self._expired(db,now)
            row=db.execute("""SELECT * FROM local_fixed_execution_receipts
                WHERE tenant=? AND job_key=? AND task_id=?""",
                (tenant,task["idempotency_key"],task["task_id"])).fetchone()
            if (row is None or row["permit_nonce"]!=signed["nonce"] or
                row["task_sha256"]!=signed["task_sha256"] or row["state"]!="reserved"):
                raise ExecutionDenied("Stale or altered fenced execution receipt")
            lease=db.execute("""SELECT * FROM local_compute_leases WHERE tenant=?
                AND job_key=?""",(tenant,task["idempotency_key"])).fetchone()
            if (lease is None or lease["state"]!="reserved" or
                lease["expires"]<=now or lease["units"]!=row["units"]):
                raise ExecutionDenied("Expired or conflicting compute lease")
            if result_sha256 is not None:
                state="completed";lease_state="completed"
                charge=row["units"];refund=0
            else:
                state="failed";lease_state="cancelled"
                charge=0;refund=row["units"]
            changed=db.execute("""UPDATE local_compute_leases SET state=?,
                result_sha256=? WHERE tenant=? AND job_key=? AND state='reserved'""",
                (lease_state,result_sha256,tenant,task["idempotency_key"])).rowcount
            if changed!=1:
                raise ExecutionDenied("Lease was consumed by another worker")
            count=db.execute("""UPDATE local_fixed_execution_receipts
                SET state=?,result_sha256=?,error_code=? WHERE tenant=?
                AND job_key=? AND task_id=? AND state='reserved'""",
                (state,result_sha256,error_code,tenant,
                 task["idempotency_key"],task["task_id"])).rowcount
            if count!=1:
                raise ExecutionDenied("Receipt was modified concurrently")
            changed=db.execute("""UPDATE local_compute_quotas SET held=held-?,
                spent=spent+? WHERE tenant=? AND held>=?""",
                (row["units"],charge,tenant,row["units"])).rowcount
            if changed!=1:
                raise ExecutionDenied("Broken reserved budget invariant")
            return state

    def run(self,authorization:dict,permit:dict,*,expected_tenant:str,
            expected_actor:str,scopes:set[str],now:int,
            limits:ResourceLimits|None=None)->dict:
        limits=(limits or ResourceLimits()).checked()
        task,signed=self._prepare(authorization=authorization,permit=permit,
            tenant=expected_tenant,actor=expected_actor,scopes=scopes,now=now,
            limits=limits)
        started=time.monotonic()
        try:
            outcome=run_allowlisted_task(authorization,
                expected_tenant=expected_tenant,expected_actor=expected_actor,
                scopes=scopes,now=now,limits=limits)
        except Exception as exc:
            completed_at=now+math.ceil(time.monotonic()-started)
            try:
                self._settle(task=task,signed=signed,tenant=expected_tenant,
                        now=completed_at,result_sha256=None,
                        error_code="LOCAL_EXECUTION_FAILED")
            except ExecutionDenied:
                pass  # Expired entries are not revived or charged.
            raise ExecutionDenied("Fixed local computation failed; permit spent") from exc
        completed_at=now+math.ceil(time.monotonic()-started)
        state=self._settle(task=task,signed=signed,tenant=expected_tenant,
            now=completed_at,result_sha256=digest(outcome),error_code=None)
        return {**outcome,"receipt_state":state,"permit_replay_allowed":False,
                "quota_units_charged":signed["units"],
                "external_side_effects_authorized":False}

    def inspect(self,*,tenant:str,job_key:str)->dict:
        """Metadata only; never returns permit, HMAC key, raw input or result."""
        self.ledger._tenant(tenant)
        with self.ledger._db() as db:
            row=db.execute("""SELECT task_sha256,units,state,result_sha256,
                error_code FROM local_fixed_execution_receipts
                WHERE tenant=? AND job_key=?""",(tenant,job_key)).fetchone()
            if row is None:
                raise ExecutionDenied("Receipt absent in requested tenant")
            return {**dict(row),"tenant":tenant,"result_payload":None,
                    "permit_replay_allowed":False}
