"""Wave 14: tamper-evident LOCAL compute checkpoint, verified offline.

The signer owns a separate HMAC secret; keys never enter SQLite, HTTP, or
the checkpoint. A write-once local file can be stored outside the database
as an independent checkpoint. HMAC is symmetric, not third-party proof or
hardware-backed audit, and cannot resist an attacker with the signing key.
"""
from __future__ import annotations
from hashlib import sha256
import hmac
import json
import os
from pathlib import Path
import re
from typing import Any

from .contracts import canonical,digest,TENANT_RE
from .quota_ledger import TenantQuotaLedger

SCHEMA="osgard.local-compute-checkpoint/1"
HEX64=re.compile(r"^[a-f0-9]{64}$")

class EvidenceDenied(ValueError):
    pass

class LocalComputeEvidence:
    def __init__(self,ledger:TenantQuotaLedger,*,secret:bytes,
                 key_id:str="local-checkpoint-key-v1"):
        if type(ledger) is not TenantQuotaLedger:
            raise EvidenceDenied("Trusted quota ledger is required")
        if (type(secret) is not bytes or not 32<=len(secret)<=128 or
            type(key_id) is not str or not re.fullmatch(
                r"[A-Za-z0-9_-]{8,64}",key_id)):
            raise EvidenceDenied("Separate trusted checkpoint key required")
        self.ledger=ledger
        self._secret=secret
        self.key_id=key_id

    def snapshot(self,*,tenant:str)->dict:
        """Read-only single-transaction tenant-local consistency scan."""
        self.ledger._tenant(tenant)
        with self.ledger._db() as db:
            db.execute("BEGIN")
            try:
                quota=db.execute("""SELECT * FROM local_compute_quotas
                    WHERE tenant=?""",(tenant,)).fetchone()
                if not quota:
                    raise EvidenceDenied("Tenant compute budget missing")
                leases=db.execute("""SELECT * FROM local_compute_leases
                    WHERE tenant=? ORDER BY job_key""",(tenant,)).fetchall()
                receipts=db.execute("""SELECT * FROM local_fixed_execution_receipts
                    WHERE tenant=? ORDER BY job_key""",(tenant,)).fetchall()
                spent=sum(r["units"] for r in leases if r["state"]=="completed")
                held=sum(r["units"] for r in leases if r["state"]=="reserved")
                if (spent!=quota["spent"] or held!=quota["held"] or
                    quota["capacity"]<spent+held):
                    raise EvidenceDenied("Tenant quota/lease totals are inconsistent")
                index={r["job_key"]:r for r in leases}
                for row in receipts:
                    lease=index.get(row["job_key"])
                    match={"reserved":"reserved","completed":"completed",
                           "failed":"cancelled","expired":"expired"}.get(row["state"])
                    if (not lease or lease["state"]!=match or
                        row["units"]!=lease["units"] or
                        (row["result_sha256"]!=lease["result_sha256"]) or
                        (row["state"]=="completed" and (
                            type(row["result_sha256"]) is not str or
                            not HEX64.fullmatch(row["result_sha256"])))):
                        raise EvidenceDenied("Fenced receipt and quota lease conflict")
                # Never include per-job keys, customer data or secret tokens in
                # the outward-facing checkpoint. These values are compacted
                # into a SHA-256 commitment only.
                state={
                    "tenant":tenant,
                    "quota":{"capacity":quota["capacity"],
                             "spent":quota["spent"],"held":quota["held"]},
                    "leases":[{
                        "job_sha256":digest({"tenant":tenant,"job":r["job_key"]}),
                        "state":r["state"],"units":r["units"],
                        "generation":r["generation"],"expires":r["expires"],
                        "result_sha256":r["result_sha256"]}
                        for r in leases],
                    "receipts":[{
                        "task_sha256":r["task_sha256"],"units":r["units"],
                        "permit_sha256":r["permit_sha256"],"state":r["state"],
                        "result_sha256":r["result_sha256"],"error_code":r["error_code"]}
                        for r in receipts]}
                return {"tenant":tenant,
                    "state_sha256":digest(state),
                    "lease_count":len(leases),
                    "receipt_count":len(receipts),
                    "capacity":quota["capacity"],"spent":spent,"held":held,
                    "local_consistency_verified":True,
                    "external_witnessed":False,"independent_acceptance":False}
            finally:
                db.rollback()

    def attest(self,*,tenant:str,at_epoch:int)->dict:
        if type(at_epoch) is not int or at_epoch<0:
            raise EvidenceDenied("Trusted epoch required")
        report=self.snapshot(tenant=tenant)
        payload={"schema":SCHEMA,"key_id":self.key_id,
                 "at_epoch":at_epoch,**report}
        mac=hmac.new(self._secret,canonical(payload),sha256).hexdigest()
        return {"payload":payload,"hmac_sha256":mac}

    def verify(self,checkpoint:Any,*,tenant:str,
               check_current_database:bool=True)->dict:
        if (type(checkpoint) is not dict or
            set(checkpoint)!={"payload","hmac_sha256"} or
            type(checkpoint["payload"]) is not dict):
            raise EvidenceDenied("Untrusted checkpoint shape")
        signed=checkpoint["payload"]
        if (set(signed)!={"schema","key_id","at_epoch","tenant",
            "state_sha256","lease_count","receipt_count","capacity","spent",
            "held","local_consistency_verified","external_witnessed",
            "independent_acceptance"} or
            signed["schema"]!=SCHEMA or signed["key_id"]!=self.key_id or
            signed["tenant"]!=tenant or
            signed["local_consistency_verified"] is not True or
            signed["external_witnessed"] is not False or
            signed["independent_acceptance"] is not False or
            type(signed["state_sha256"]) is not str or
            not HEX64.fullmatch(signed["state_sha256"]) or
            type(signed["at_epoch"]) is not int or signed["at_epoch"]<0):
            raise EvidenceDenied("Unexpected or mutated checkpoint metadata")
        signature=checkpoint["hmac_sha256"]
        if type(signature) is not str or not HEX64.fullmatch(signature):
            raise EvidenceDenied("Missing checkpoint HMAC")
        compare=hmac.new(self._secret,canonical(signed),sha256).hexdigest()
        if not hmac.compare_digest(signature,compare):
            raise EvidenceDenied("Checkpoint signature differs")
        if check_current_database:
            now=self.snapshot(tenant=tenant)
            for key,value in now.items():
                if signed.get(key)!=value:
                    raise EvidenceDenied("Current compute state changed since checkpoint")
        return {"checkpoint_sha256":digest(checkpoint),
                "hmac_valid":True,
                "current_state_matches":bool(check_current_database),
                "external_witnessed":False,"independent_acceptance":False}

    def write_once(self,checkpoint:dict,*,path:str|Path,tenant:str)->dict:
        """Persist signed checkpoint outside the database, without overwrite.

        Caller must choose a trusted private directory. Refuses symlinks and
        existing destinations; no raw input, permit or signing secret written.
        """
        self.verify(checkpoint,tenant=tenant,check_current_database=True)
        location=Path(path)
        if not location.parent.is_dir():
            raise EvidenceDenied("Explicit existing checkpoint directory required")
        data=canonical(checkpoint)+b"\n"
        flags=os.O_WRONLY|os.O_CREAT|os.O_EXCL
        if hasattr(os,"O_NOFOLLOW"):flags|=os.O_NOFOLLOW
        try:
            fd=os.open(location,flags,0o600)
        except OSError as exc:
            raise EvidenceDenied("Checkpoint already exists or destination refused") from exc
        try:
            with os.fdopen(fd,"wb") as f:
                f.write(data)
                f.flush()
                os.fsync(f.fileno())
        except Exception:
            try:location.unlink()
            except OSError:pass
            raise
        return {"path":str(location),"bytes":len(data),
                "checkpoint_sha256":digest(checkpoint),
                "overwrite_permitted":False,
                "contains_customer_records":False}

    def verify_file(self,path:str|Path,*,tenant:str)->dict:
        location=Path(path)
        if location.is_symlink() or not location.is_file():
            raise EvidenceDenied("Regular checkpoint file required")
        if location.stat().st_size>2048:
            raise EvidenceDenied("Checkpoint size exceeds bound")
        try:
            data=location.read_bytes()
            parsed=json.loads(data)
        except (UnicodeDecodeError,ValueError,OSError) as exc:
            raise EvidenceDenied("Malformed checkpoint file") from exc
        if canonical(parsed)+b"\n"!=data:
            raise EvidenceDenied("Checkpoint file encoding differs")
        return self.verify(parsed,tenant=tenant)
