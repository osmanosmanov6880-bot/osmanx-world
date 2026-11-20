"""Wave15 metadata-only append-only tenant hash chain for compute transitions.

The chain is appended IN THE SAME SQLite transaction as the quota and
receipt mutation. It detects gaps, replay, altered entries and mismatched
current receipt states. It is not an externally trusted auditor: a DB admin
can rewrite an unpinned chain. Pin the head independently with HMAC evidence.
"""
from __future__ import annotations
import json
import sqlite3
from .contracts import canonical,digest,TENANT_RE

ZERO="0"*64
EVENTS={"reserved","completed","failed","expired"}

class ComputeEventDenied(ValueError):
    pass

class LocalComputeEventLog:
    def __init__(self,ledger):
        from .quota_ledger import TenantQuotaLedger
        if type(ledger) is not TenantQuotaLedger:
            raise ComputeEventDenied("Trusted shared local quota ledger required")
        self.ledger=ledger
        with ledger._db() as db:
            db.executescript("""CREATE TABLE IF NOT EXISTS local_fixed_compute_events(
                tenant TEXT NOT NULL,seq INTEGER NOT NULL,at_epoch INTEGER NOT NULL,
                job_sha256 TEXT NOT NULL,task_sha256 TEXT NOT NULL,
                state TEXT NOT NULL CHECK(state IN ('reserved','completed','failed','expired')),
                units INTEGER NOT NULL CHECK(units>0),result_sha256 TEXT,
                previous_hash TEXT NOT NULL,event_hash TEXT NOT NULL,
                PRIMARY KEY(tenant,seq));
            CREATE TRIGGER IF NOT EXISTS local_fixed_compute_events_no_update
                BEFORE UPDATE ON local_fixed_compute_events BEGIN
                SELECT RAISE(ABORT,'compute events are immutable'); END;
            CREATE TRIGGER IF NOT EXISTS local_fixed_compute_events_no_delete
                BEFORE DELETE ON local_fixed_compute_events BEGIN
                SELECT RAISE(ABORT,'compute events are immutable'); END;""")

    @staticmethod
    def _job(tenant,job_key):
        return digest({"tenant":tenant,"job":job_key})

    def append_tx(self,db,*,tenant,job_key,task_sha256,state,units,at_epoch,
                  result_sha256=None):
        if (type(tenant) is not str or not TENANT_RE.fullmatch(tenant) or
            type(job_key) is not str or type(task_sha256) is not str or
            len(task_sha256)!=64 or
            type(state) is not str or state not in EVENTS or
            type(units) is not int or not 1<=units<=100 or
            type(at_epoch) is not int or at_epoch<0 or
            (result_sha256 is not None and (type(result_sha256) is not str or
            len(result_sha256)!=64)) or
            (state=="completed")!=(result_sha256 is not None)):
            raise ComputeEventDenied("Invalid bounded compute event metadata")
        # The caller holds BEGIN IMMEDIATE in the SHARED quota/receipt DB.
        # Verification before insertion also catches a tampered chain.
        previous=self._verify_tx(db,tenant,check_receipts=False)
        seq=previous["events"]+1
        record={"tenant":tenant,"seq":seq,"at_epoch":at_epoch,
                "job_sha256":self._job(tenant,job_key),
                "task_sha256":task_sha256,"state":state,"units":units,
                "result_sha256":result_sha256,
                "previous_hash":previous["head_hash"]}
        h=digest(record)
        db.execute("""INSERT INTO local_fixed_compute_events
            (tenant,seq,at_epoch,job_sha256,task_sha256,state,units,
             result_sha256,previous_hash,event_hash)
            VALUES(?,?,?,?,?,?,?,?,?,?)""",
            (tenant,seq,at_epoch,record["job_sha256"],task_sha256,state,
             units,result_sha256,record["previous_hash"],h))
        return {"sequence":seq,"head_hash":h}

    def _verify_tx(self,db,tenant,*,check_receipts=True):
        rows=db.execute("""SELECT * FROM local_fixed_compute_events
            WHERE tenant=? ORDER BY seq""",(tenant,)).fetchall()
        if len(rows)>20000:
            raise ComputeEventDenied("Compute event verification budget exceeded")
        prev=ZERO
        by_job={}
        for expected,row in enumerate(rows,1):
            record={key:row[key] for key in (
                "tenant","seq","at_epoch","job_sha256","task_sha256","state",
                "units","result_sha256","previous_hash")}
            if (record["tenant"]!=tenant or row["seq"]!=expected or
                record["previous_hash"]!=prev or row["event_hash"]!=digest(record)):
                raise ComputeEventDenied("Compute event chain altered or missing entry")
            job=row["job_sha256"]
            if row["state"]=="reserved":
                if job in by_job:
                    raise ComputeEventDenied("Double reservation event")
                by_job[job]=[row["state"],row["task_sha256"],row["units"],
                             row["result_sha256"],0]
            else:
                old=by_job.get(job)
                if (old is None or old[0]!="reserved" or old[4]!=0 or
                    old[1]!=row["task_sha256"] or old[2]!=row["units"] or
                    (row["state"]=="completed")!=(row["result_sha256"] is not None)):
                    raise ComputeEventDenied("Orphan/duplicated compute completion")
                old[0]=row["state"]
                old[3]=row["result_sha256"]
                old[4]=1
            prev=row["event_hash"]
        if not check_receipts:
            return {"tenant":tenant,"events":len(rows),"head_hash":prev,
                    "chain_verified":True,"receipt_reconciled":False,
                    "external_witnessed":False}
        receipts=db.execute("""SELECT job_key,task_sha256,units,state,
            result_sha256 FROM local_fixed_execution_receipts WHERE tenant=?""",
            (tenant,)).fetchall()
        if len(receipts)!=len(by_job):
            raise ComputeEventDenied("Compute receipt count differs from chain")
        for receipt in receipts:
            job=self._job(tenant,receipt["job_key"])
            events=by_job.get(job)
            if (events is None or events[0]!=receipt["state"] or
                events[1]!=receipt["task_sha256"] or
                events[2]!=receipt["units"] or
                events[3]!=receipt["result_sha256"] or
                events[4]!=int(receipt["state"]!="reserved")):
                raise ComputeEventDenied("Receipt does not match signed event history")
        return {"tenant":tenant,"events":len(rows),"head_hash":prev,
                "chain_verified":True,"receipt_reconciled":True,
                "external_witnessed":False}

    def verify(self,*,tenant):
        self.ledger._tenant(tenant)
        with self.ledger._db() as db:
            db.execute("BEGIN")
            try:return self._verify_tx(db,tenant)
            finally:db.rollback()
