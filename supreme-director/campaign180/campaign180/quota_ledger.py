"""Transactional tenant compute budgets and non-replayable single-use leases.

TITAN-X10/X15 local evidence only; caller identity and tenant policy must
already be authorized. Quotas are durable, atomic and fail closed.
"""
from __future__ import annotations
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path
import re
import secrets
import sqlite3

from .contracts import IDEMPOTENCY_RE,TENANT_RE

HEX_SHA=re.compile(r"^[a-f0-9]{64}$")

class QuotaDenied(ValueError):
    pass

@dataclass(frozen=True)
class QuotaReservation:
    tenant: str
    job_key: str
    units: int
    token: str
    generation: int
    expires: int

class TenantQuotaLedger:
    def __init__(self,path:str|Path):
        self.path=str(path)
        with self._db() as db:
            db.executescript("""CREATE TABLE IF NOT EXISTS local_compute_quotas(
                tenant TEXT PRIMARY KEY,capacity INTEGER NOT NULL
                  CHECK(capacity>=0),spent INTEGER NOT NULL DEFAULT 0
                  CHECK(spent>=0),held INTEGER NOT NULL DEFAULT 0 CHECK(held>=0));
            CREATE TABLE IF NOT EXISTS local_compute_leases(
                tenant TEXT NOT NULL,job_key TEXT NOT NULL,units INTEGER NOT NULL,
                token TEXT NOT NULL,generation INTEGER NOT NULL,
                expires INTEGER NOT NULL,
                state TEXT NOT NULL CHECK(state IN ('reserved','completed','cancelled','expired')),
                result_sha256 TEXT,PRIMARY KEY(tenant,job_key));
            CREATE INDEX IF NOT EXISTS local_compute_leases_expire
                ON local_compute_leases(state,expires);
            CREATE TRIGGER IF NOT EXISTS local_compute_no_delete
                BEFORE DELETE ON local_compute_leases BEGIN
                SELECT RAISE(ABORT,'append-only compute lease'); END;""")

    @contextmanager
    def _db(self):
        db=sqlite3.connect(self.path,timeout=15,isolation_level=None)
        try:
            db.row_factory=sqlite3.Row
            db.execute("PRAGMA busy_timeout=15000")
            yield db
        finally:
            db.close()

    @contextmanager
    def _tx(self):
        with self._db() as db:
            db.execute("BEGIN IMMEDIATE")
            try:
                yield db
                db.commit()
            except BaseException:
                db.rollback()
                raise

    @staticmethod
    def _tenant(tenant):
        if type(tenant) is not str or not TENANT_RE.fullmatch(tenant):
            raise QuotaDenied("Invalid tenant identifier")
    @staticmethod
    def _time(now):
        if type(now) is not int or now<0:
            raise QuotaDenied("Exact nonnegative epoch required")

    def configure(self,*,tenant:str,capacity:int)->None:
        """Trusted local setup only; do NOT expose this call to HTTP clients."""
        self._tenant(tenant)
        if type(capacity) is not int or not 1<=capacity<=1_000_000_000:
            raise QuotaDenied("Trusted tenant capacity must be positive and bounded")
        with self._tx() as db:
            current=db.execute("SELECT * FROM local_compute_quotas WHERE tenant=?",
                               (tenant,)).fetchone()
            if current is None:
                db.execute("INSERT INTO local_compute_quotas(tenant,capacity) VALUES(?,?)",
                           (tenant,capacity))
            elif current["capacity"]!=capacity:
                raise QuotaDenied("Changing a live capacity requires an explicit new policy")

    def _expire(self,db,now):
        has_fixed=db.execute("""SELECT 1 FROM sqlite_master
            WHERE type='table' AND name='local_fixed_execution_receipts'""").fetchone()
        guard="""
            AND NOT EXISTS(SELECT 1 FROM local_fixed_execution_receipts f
              WHERE f.tenant=local_compute_leases.tenant
              AND f.job_key=local_compute_leases.job_key)
        """ if has_fixed else ""
        # Fixed/permit reservations require their own atomic receipt+event
        # settlement. A generic quota reclaim must NEVER bypass the log.
        expired=db.execute("""SELECT tenant,units FROM local_compute_leases
            WHERE state='reserved' AND expires<=?"""+guard,(now,)).fetchall()
        for row in expired:
            db.execute("""UPDATE local_compute_quotas SET held=held-?
                WHERE tenant=? AND held>=?""",
                (row["units"],row["tenant"],row["units"]))
        db.execute("""UPDATE local_compute_leases SET state='expired'
            WHERE state='reserved' AND expires<=?"""+guard,(now,))
        return len(expired)

    def reclaim_expired(self,*,now:int)->int:
        self._time(now)
        with self._tx() as db:
            return self._expire(db,now)

    def reserve(self,*,tenant:str,job_key:str,units:int,now:int,
                ttl_seconds:int=60)->QuotaReservation:
        self._tenant(tenant);self._time(now)
        if (type(job_key) is not str or not IDEMPOTENCY_RE.fullmatch(job_key)
            or type(units) is not int or not 1<=units<=100000
            or type(ttl_seconds) is not int or not 1<=ttl_seconds<=300):
            raise QuotaDenied("Invalid reservation request")
        with self._tx() as db:
            self._expire(db,now)
            old=db.execute("""SELECT * FROM local_compute_leases WHERE tenant=?
                AND job_key=?""",(tenant,job_key)).fetchone()
            if old:
                raise QuotaDenied("Job key already exists; replay cannot acquire a new lease")
            row=db.execute("SELECT * FROM local_compute_quotas WHERE tenant=?",
                           (tenant,)).fetchone()
            if row is None or row["held"]+row["spent"]+units>row["capacity"]:
                raise QuotaDenied("Compute capacity exhausted or unconfigured")
            secret=secrets.token_hex(32)
            expires=now+ttl_seconds
            db.execute("""UPDATE local_compute_quotas SET held=held+? WHERE tenant=?""",
                       (units,tenant))
            db.execute("""INSERT INTO local_compute_leases
                (tenant,job_key,units,token,generation,expires,state,result_sha256)
                VALUES(?,?,?,?,1,?,'reserved',NULL)""",
                (tenant,job_key,units,secret,expires))
            return QuotaReservation(tenant,job_key,units,secret,1,expires)

    def _held(self,db,lease):
        if type(lease) is not QuotaReservation:
            raise QuotaDenied("Exact reservation required")
        row=db.execute("""SELECT * FROM local_compute_leases WHERE tenant=?
            AND job_key=?""",(lease.tenant,lease.job_key)).fetchone()
        if row is None or row["token"]!=lease.token or row["generation"]!=lease.generation or row["units"]!=lease.units:
            raise QuotaDenied("Lease token or generation mismatch")
        return row

    def commit(self,lease:QuotaReservation,*,now:int,result_sha256:str)->str:
        self._time(now)
        if type(result_sha256) is not str or not HEX_SHA.fullmatch(result_sha256):
            raise QuotaDenied("Immutable result SHA-256 required")
        with self._tx() as db:
            row=self._held(db,lease)
            if row["state"]=="completed":
                if row["result_sha256"]!=result_sha256:
                    raise QuotaDenied("Result changed for already-completed lease")
                return "COMPLETED_ALREADY_NO_EFFECT"
            if row["state"]!="reserved" or row["expires"]<=now:
                raise QuotaDenied("Stale, cancelled or expired compute lease")
            count=db.execute("""UPDATE local_compute_leases SET
                state='completed',result_sha256=? WHERE tenant=? AND job_key=?
                AND state='reserved' AND token=?""",
                (result_sha256,lease.tenant,lease.job_key,lease.token)).rowcount
            if count!=1:raise QuotaDenied("Concurrent lease completion")
            changed=db.execute("""UPDATE local_compute_quotas
                SET held=held-?,spent=spent+? WHERE tenant=? AND held>=?""",
                (lease.units,lease.units,lease.tenant,lease.units)).rowcount
            if changed!=1:raise QuotaDenied("Broken quota ledger state")
            return "COMMITTED"

    def cancel(self,lease:QuotaReservation)->str:
        with self._tx() as db:
            row=self._held(db,lease)
            if row["state"]=="cancelled":
                return "CANCELLED_ALREADY"
            if row["state"]!="reserved":
                raise QuotaDenied("Lease already completed or expired")
            updated=db.execute("""UPDATE local_compute_leases
                SET state='cancelled' WHERE tenant=? AND job_key=? AND
                state='reserved' AND token=?""",
                (lease.tenant,lease.job_key,lease.token)).rowcount
            if updated!=1:raise QuotaDenied("Concurrent quota cancellation")
            db.execute("""UPDATE local_compute_quotas SET held=held-?
                WHERE tenant=? AND held>=?""",
                (lease.units,lease.tenant,lease.units))
            return "CANCELLED"

    def balance(self,*,tenant:str)->dict:
        self._tenant(tenant)
        with self._db() as db:
            row=db.execute("SELECT * FROM local_compute_quotas WHERE tenant=?",
                           (tenant,)).fetchone()
            if row is None:raise QuotaDenied("Tenant has no local policy")
            return {"capacity":row["capacity"],"spent":row["spent"],
                    "held":row["held"],
                    "remaining":row["capacity"]-row["spent"]-row["held"]}
