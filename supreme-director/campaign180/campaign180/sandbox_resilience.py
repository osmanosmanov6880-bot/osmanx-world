"""Bounded local failure-injection/chaos acceptance for closed worker.

No network, no external service, no user-supplied Python. All probes are
synthetic, deterministic by outcomes, and run on disposable SQLite files.
"""
from __future__ import annotations
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
import tempfile
import uuid

from .contracts import SCHEMA_TASK,validate_task
from .resource_limits import ResourceLimits
from .sandbox_runtime import SandboxDenied,run_allowlisted_task
from .quota_ledger import TenantQuotaLedger,QuotaDenied
from .budgeted_runtime import run_budgeted_task

NOW=1799971200
TENANT="tenant_demo"
ACTOR="owner-abc"
SCOPE="project:localdemo"

def auth(*,operation="sum_i64",value=None,key=None):
    task={"schema":SCHEMA_TASK,"task_id":str(uuid.uuid4()),
        "tenant_id":TENANT,"actor_id":ACTOR,"capability":"sandbox.evaluate",
        "issued_at":NOW,"expires_at":NOW+60,
        "idempotency_key":key or "chaos-local-"+uuid.uuid4().hex,
        "resource_scopes":[SCOPE],
        "body":{"operation":operation,"value":[4,5] if value is None else value}}
    return validate_task(task,tenant_id=TENANT,actor_id=ACTOR,
        allow_capabilities={"sandbox.evaluate"},allowed_scopes={SCOPE},now=NOW)

def exercise()->dict:
    checks={}
    with tempfile.TemporaryDirectory(prefix="osgard-chaos-local-") as temporary:
        q=TenantQuotaLedger(str(Path(temporary)/"quotas.sqlite3"))
        q.configure(tenant=TENANT,capacity=5)

        result=run_budgeted_task(auth(),expected_tenant=TENANT,
            expected_actor=ACTOR,scopes={SCOPE},now=NOW,
            ledger=q,units=2)
        checks["fixed_executor_actual_subprocess"]=result["result"]==9
        checks["real_quota_charged_once"]=q.balance(tenant=TENANT)["spent"]==2

        def expect_denied(callback):
            try:callback()
            except (QuotaDenied,SandboxDenied,ValueError):return True
            return False
        checks["injection_denied"]=expect_denied(lambda:run_allowlisted_task(
            auth(operation="shell",value="rm -rf /"),expected_tenant=TENANT,
            expected_actor=ACTOR,scopes={SCOPE},now=NOW))
        checks["integer_overflow_denied"]=expect_denied(lambda:run_allowlisted_task(
            auth(value=[2**63-1,1]),expected_tenant=TENANT,
            expected_actor=ACTOR,scopes={SCOPE},now=NOW))
        checks["wall_deadline_enforced"]=expect_denied(lambda:run_allowlisted_task(
            auth(operation="sleep_ms",value=1300),expected_tenant=TENANT,
            expected_actor=ACTOR,scopes={SCOPE},now=NOW,
            limits=ResourceLimits(wall_ms=250)))
        checks["invalid_tenant_scope_denied"]=expect_denied(
            lambda:run_budgeted_task(auth(),expected_tenant="another_tenant",
                 expected_actor=ACTOR,scopes={SCOPE},now=NOW,ledger=q))
        checks["invalid_tenant_did_not_spend"]=q.balance(tenant=TENANT)["spent"]==2

        lease=q.reserve(tenant=TENANT,job_key="chaos-expiring-lease",units=3,
                        now=NOW,ttl_seconds=1)
        checks["quota_temporarily_exhausted"]=expect_denied(lambda:q.reserve(
            tenant=TENANT,job_key="chaos-other-budget",units=1,now=NOW))
        q.reclaim_expired(now=NOW+1)
        checks["expired_lease_returns_capacity"]=q.balance(tenant=TENANT)["remaining"]==3
        checks["expired_lease_cannot_commit"]=expect_denied(lambda:q.commit(
            lease,now=NOW+2,result_sha256="a"*64))

        # Every synthetic key must satisfy the SAME >=16 character
        # TaskEnvelope idempotency policy as actual jobs. Short keys test
        # admission rejection, not concurrency: do not confuse the two.
        def compete(i):
            try:
                return q.reserve(tenant=TENANT,job_key=f"race-tenant-worker-{i:03d}",
                    units=1,now=NOW+2)
            except QuotaDenied:return None
        with ThreadPoolExecutor(max_workers=8) as executor:
            accepted=[x for x in executor.map(compete,range(12)) if x]
        checks["parallel_capacity_never_exceeded"]=len(accepted)==3
        checks["quota_nonnegative"]=q.balance(tenant=TENANT)["remaining"]==0

    if not all(checks.values()):
        raise RuntimeError("Wave13 chaos acceptance failed: "+
            ",".join(name for name,status in checks.items() if not status))
    return {"schema":"osgard.original180.chaos-acceptance/1",
            "checks":checks,"checks_passed":sum(checks.values()),
            "local_only":True,"network_actions":0,
            "independent_acceptance":False}

def main():
    import json
    print(json.dumps(exercise(),sort_keys=True,ensure_ascii=True))

if __name__=="__main__":
    main()
