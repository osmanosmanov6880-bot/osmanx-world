"""No-network Wave14 acceptance of real fixed worker + HMAC + SQLite.

All records are synthetic. A subprocess performs the allowed operation,
then atomic quota/receipt storage and offline checkpoint verification are
tested. This is local evidence, not a production deployment certificate.
"""
from __future__ import annotations
from hashlib import sha256
import json
from pathlib import Path
import secrets
import tempfile
import uuid

from .contracts import SCHEMA_TASK,validate_task
from .local_permits import LocalPermitAuthority,PermitDenied
from .fenced_compute import LocalFencedExecutor,ExecutionDenied
from .quota_ledger import TenantQuotaLedger
from .compute_evidence import LocalComputeEvidence,EvidenceDenied

NOW=1799971200
TENANT="tenant_demo"
ACTOR="owner-abc"
SCOPE="project:localdemo"

def _authorized(*,operation:str,value,job_key:str):
    data={"schema":SCHEMA_TASK,"task_id":str(uuid.uuid4()),
          "tenant_id":TENANT,"actor_id":ACTOR,"capability":"sandbox.evaluate",
          "issued_at":NOW,"expires_at":NOW+70,
          "idempotency_key":job_key,"resource_scopes":[SCOPE],
          "body":{"operation":operation,"value":value}}
    return validate_task(data,tenant_id=TENANT,actor_id=ACTOR,
        allow_capabilities={"sandbox.evaluate"},allowed_scopes={SCOPE},now=NOW)

def exercise()->dict:
    checks={}
    with tempfile.TemporaryDirectory(prefix="osgard-wave14-") as temp:
        db=Path(temp)/"quota.sqlite3"
        q=TenantQuotaLedger(db)
        q.configure(tenant=TENANT,capacity=9)
        q.configure(tenant="other_tenant",capacity=4)
        signer=LocalPermitAuthority(secrets.token_bytes(32))
        evidence=LocalComputeEvidence(q,secret=secrets.token_bytes(32))
        engine=LocalFencedExecutor(q,signer)
        auth=_authorized(operation="sum_i64",value=[10,-1,4],
                         job_key="wave14-real-sum-local")
        permit=signer.issue(auth,tenant=TENANT,actor=ACTOR,scopes={SCOPE},
                            now=NOW,units=3)
        result=engine.run(auth,permit,expected_tenant=TENANT,
            expected_actor=ACTOR,scopes={SCOPE},now=NOW)
        checks["real_process_output_verified"]=result["result"]==13
        checks["atomic_compute_spend"]=q.balance(tenant=TENANT)=={
            "capacity":9,"spent":3,"held":0,"remaining":6}
        try:
            engine.run(auth,permit,expected_tenant=TENANT,
                 expected_actor=ACTOR,scopes={SCOPE},now=NOW)
            checks["signed_permit_replay_denied"]=False
        except ExecutionDenied:
            checks["signed_permit_replay_denied"]=True
        checks["other_tenant_unaffected"]=q.balance(tenant="other_tenant")["spent"]==0

        checksum=_authorized(operation="sha256_text",value="synthetic-only",
                             job_key="wave14-real-hash-local")
        signed=signer.issue(checksum,tenant=TENANT,actor=ACTOR,
                           scopes={SCOPE},now=NOW,units=2)
        output=engine.run(checksum,signed,expected_tenant=TENANT,
             expected_actor=ACTOR,scopes={SCOPE},now=NOW)
        checks["sha256_worker_result_matches"]=output["result"]==sha256(
            b"synthetic-only").hexdigest()
        state=evidence.snapshot(tenant=TENANT)
        checks["receipt_to_lease_integrity"]=state["receipt_count"]==2 and state["spent"]==5
        checkpoint=evidence.attest(tenant=TENANT,at_epoch=NOW)
        stored=Path(temp)/"external_checkpoint.json"
        evidence.write_once(checkpoint,path=stored,tenant=TENANT)
        checks["off_database_checkpoint_valid"]=evidence.verify_file(
                stored,tenant=TENANT)["hmac_valid"]
        try:
            evidence.write_once(checkpoint,path=stored,tenant=TENANT)
            checks["checkpoint_overwrite_denied"]=False
        except EvidenceDenied:
            checks["checkpoint_overwrite_denied"]=True
        tampered=json.loads(json.dumps(checkpoint))
        tampered["payload"]["spent"]+=1
        try:
            evidence.verify(tampered,tenant=TENANT)
            checks["tamper_detected"]=False
        except EvidenceDenied:
            checks["tamper_detected"]=True
        # The public key identifier intentionally contains "local-";
        # check the actual synthetic input and idempotency strings instead.
        checks["no_secrets_in_checkpoint"]=(b"synthetic-only" not in
                 stored.read_bytes() and b"wave14-real-" not in stored.read_bytes())
        checks["external_side_effects_disabled"]=(
                 result["external_side_effects_authorized"] is False and
                 result["arbitrary_code_execution"] is False)

    if not all(checks.values()):
        raise RuntimeError("Wave14 acceptance failed: "+
            ",".join(k for k,v in checks.items() if not v))
    return {"schema":"osgard.original180.wave14-acceptance/1",
            "checks_passed":sum(checks.values()),"checks":checks,
            "local_only":True,"outbound_network_calls":0,
            "physical_oci_isolation_tested":False,
            "independent_acceptance":False,"production_authorized":False}

def main():
    print(json.dumps(exercise(),sort_keys=True,ensure_ascii=True))

if __name__=="__main__":
    main()
