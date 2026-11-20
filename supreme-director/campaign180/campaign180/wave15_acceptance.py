"""Wave15 self-contained local security acceptance (synthetic inputs only).

Exercises real hash-pinned Linux memfd worker and signed tenant accounting,
checks append-only transitions, reclaim after crash, and HMAC checkpoint
drift. OCI kernel attestation is NOT faked or executed on an unknown host.
"""
from __future__ import annotations
from hashlib import sha256
import json
from pathlib import Path
import secrets
import tempfile
import uuid

from .contracts import SCHEMA_TASK,validate_task
from .quota_ledger import TenantQuotaLedger
from .local_permits import LocalPermitAuthority
from .fenced_compute import LocalFencedExecutor,ExecutionDenied
from .compute_evidence import LocalComputeEvidence,EvidenceDenied
from .resource_limits import ResourceLimits
from .sealed_worker import PINNED_WORKER_SHA256,source_bytes
from .sandbox_runtime import _SCRIPT

NOW=1799971200
TENANT="tenant_demo"
ACTOR="owner-abc"
SCOPE={"project:localdemo"}

def authorize(value,*,operation="sum_i64"):
    task={"schema":SCHEMA_TASK,"task_id":str(uuid.uuid4()),
          "tenant_id":TENANT,"actor_id":ACTOR,"capability":"sandbox.evaluate",
          "issued_at":NOW,"expires_at":NOW+60,
          "idempotency_key":"wave15-check-"+uuid.uuid4().hex,
          "resource_scopes":sorted(SCOPE),
          "body":{"operation":operation,"value":value}}
    return validate_task(task,tenant_id=TENANT,actor_id=ACTOR,
        allow_capabilities={"sandbox.evaluate"},allowed_scopes=SCOPE,now=NOW)

def exercise():
    checks={}
    with tempfile.TemporaryDirectory(prefix="osgard-wave15-") as temporary:
        db=Path(temporary)/"shared.sqlite3"
        q=TenantQuotaLedger(db)
        q.configure(tenant=TENANT,capacity=10)
        secret=secrets.token_bytes(32)
        signer=LocalPermitAuthority(secret)
        runner=LocalFencedExecutor(q,signer)
        evidence=LocalComputeEvidence(q,secret=secrets.token_bytes(32))
        checks["approved_worker_image_pinned"]=sha256(source_bytes(_SCRIPT)).hexdigest()==PINNED_WORKER_SHA256
        auth=authorize([2,3,4])
        permit=signer.issue(auth,tenant=TENANT,actor=ACTOR,scopes=SCOPE,
                            now=NOW,units=3)
        result=runner.run(auth,permit,expected_tenant=TENANT,
                          expected_actor=ACTOR,scopes=SCOPE,now=NOW)
        checks["sealed_memfd_worker_real_execution"]=result["result"]==9
        checks["atomic_quota_with_receipt"]=(
            q.balance(tenant=TENANT)=={
             "capacity":10,"held":0,"spent":3,"remaining":7})
        events=runner.events.verify(tenant=TENANT)
        checks["verified_immutable_two_event_chain"]=(
            events["events"]==2 and events["receipt_reconciled"])
        checkpoint=evidence.attest(tenant=TENANT,at_epoch=NOW)
        checks["v2_checkpoint_pins_event_chain"]=(
            checkpoint["payload"]["schema"]=="osgard.local-compute-checkpoint/2"
            and checkpoint["payload"]["compute_event_head"]==events["head_hash"])
        try:
            runner.run(auth,permit,expected_tenant=TENANT,
                       expected_actor=ACTOR,scopes=SCOPE,now=NOW)
            checks["single_use_permit_replay_denied"]=False
        except ExecutionDenied:
            checks["single_use_permit_replay_denied"]=True

        crash=authorize([9,10])
        signed=signer.issue(crash,tenant=TENANT,actor=ACTOR,
                             scopes=SCOPE,now=NOW,units=4,ttl_seconds=2)
        task,claims=runner._prepare(authorization=crash,permit=signed,
                   tenant=TENANT,actor=ACTOR,scopes=SCOPE,now=NOW,
                   limits=ResourceLimits().checked())
        checks["crash_reserves_without_completing"]=q.balance(tenant=TENANT)["held"]==4
        checks["quota_api_cannot_bypass_fencing"]=q.reclaim_expired(now=NOW+2)==0
        recovered=runner.reclaim(now=NOW+2)
        checks["atomic_expiry_refund"]=(
            recovered["leases_reclaimed"]==1
            and q.balance(tenant=TENANT)["held"]==0
            and q.balance(tenant=TENANT)["remaining"]==7)
        checks["expired_receipt_chained"]=runner.events.verify(tenant=TENANT)["events"]==4
        try:
            runner._settle(task=task,signed=claims,tenant=TENANT,
                 now=NOW+2,result_sha256="a"*64,error_code=None)
            checks["stale_fenced_completion_denied"]=False
        except ExecutionDenied:
            checks["stale_fenced_completion_denied"]=True
        try:
            evidence.verify(checkpoint,tenant=TENANT)
            checks["old_checkpoint_detects_changes"]=False
        except EvidenceDenied:
            checks["old_checkpoint_detects_changes"]=True
        updated=evidence.attest(tenant=TENANT,at_epoch=NOW+3)
        local_file=Path(temporary)/"external_checkpoint.json"
        evidence.write_once(updated,path=local_file,tenant=TENANT)
        checks["signed_external_checkpoint_valid"]=evidence.verify_file(
                local_file,tenant=TENANT)["hmac_valid"]
        raw=local_file.read_bytes()
        checks["no_secret_or_customer_payload"]=(
            b"wave15-check-" not in raw and b'"value"' not in raw
            and b"secret" not in raw)

    if not all(checks.values()):
        raise RuntimeError("Wave15 local security acceptance failed: "+
                           ",".join(k for k,v in checks.items() if not v))
    return {"schema":"osgard.original180.wave15-local-acceptance/1",
            "checks":checks,"checks_passed":sum(checks.values()),
            "local_only":True,"outbound_network_calls":0,
            "real_worker_memfd_sealed":True,
            "physical_rootless_oci_probe_executed":False,
            "production_authorized":False,
            "independently_accepted":False}

def main():
    print(json.dumps(exercise(),sort_keys=True,ensure_ascii=True))

if __name__=="__main__":
    main()
