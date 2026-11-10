"""Accounting adapter for the closed, local-only evaluator.

Consumes an explicit tenant quota lease before an operation. A failed job
returns reserved capacity; a crash leaves a bounded lease to expire. Tokens,
customer inputs and raw stdout are never logged by this adapter.
"""
from __future__ import annotations

from .contracts import digest
from .quota_ledger import TenantQuotaLedger,QuotaDenied
from .resource_limits import ResourceLimits
from .sandbox_runtime import run_allowlisted_task

def run_budgeted_task(authorization:dict,*,expected_tenant:str,
                      expected_actor:str,scopes:set[str],now:int,
                      ledger:TenantQuotaLedger,units:int=1,
                      limits:ResourceLimits|None=None)->dict:
    if type(ledger) is not TenantQuotaLedger:
        raise QuotaDenied("Trusted, configured local quota ledger required")
    limits=(limits or ResourceLimits()).checked()
    task=authorization.get("task") if type(authorization) is dict else None
    if type(task) is not dict:
        raise QuotaDenied("Validated task envelope required")
    # Validate authorization BEFORE reserving capacity: rejections must not
    # affect another tenant's ledger or leak remaining capacity.
    from .contracts import validate_task
    validate_task(task,tenant_id=expected_tenant,actor_id=expected_actor,
        allow_capabilities={"sandbox.evaluate"},allowed_scopes=scopes,now=now)
    ttl=max(1,min(300,task["expires_at"]-now+1))
    lease=ledger.reserve(tenant=expected_tenant,job_key=task["idempotency_key"],
                         units=units,now=now,ttl_seconds=ttl)
    try:
        proof=run_allowlisted_task(authorization,
            expected_tenant=expected_tenant,expected_actor=expected_actor,
            scopes=scopes,now=now,limits=limits)
        # All parent elapsed-wall budget is bounded, and a completion after
        # task expiry is rejected: no stale budget lease can be committed.
        completed=now+min(limits.wall_ms//1000,300)
        state=ledger.commit(lease,now=completed,result_sha256=digest(proof))
        return {**proof,"quota_state":state,"quota_units_charged":units}
    except Exception:
        try: ledger.cancel(lease)
        except QuotaDenied: pass  # Expired lease is reclaimed independently.
        raise
