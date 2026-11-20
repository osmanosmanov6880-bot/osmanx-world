"""TITAN-X29 partial: synthetic crash, lease-fencing, backup and race drills.

No untrusted code execution, real network failures, production destructive tests,
or hardware security benchmarks. Synthetic results are explicitly nonproduct.
"""
from __future__ import annotations
from concurrent.futures import ThreadPoolExecutor
from hashlib import sha256
import json
from pathlib import Path
import sqlite3
import tempfile
import time
import uuid

from .audittrail import LocalAuditTrail
from .backup import snapshot_sqlite,restore_drill,verify_snapshot
from .contracts import SCHEMA_TASK,SCHEMA_RESULT,digest,validate_result
from .gateway import TransactionalLocalGateway
from .scheduler import CapacityScheduler,ResourceCost

TENANTS=("tenant_alpha","tenant_beta")
ACTOR="simulation-worker"
NOW=1799971200
ROLES={"operator":{"task.preview"}}
COSTS={"task.preview":ResourceCost(1,64,8)}


class ResilienceDenied(ValueError):
    pass


def _task(tenant:str,ordinal:int,now:int)->dict:
    return {"schema":SCHEMA_TASK,"task_id":str(uuid.uuid5(uuid.NAMESPACE_URL,
                 f"osgard-local-chaos/{tenant}/{ordinal}/{now}")),
            "tenant_id":tenant,"actor_id":ACTOR,"capability":"task.preview",
            "issued_at":now-1,"expires_at":now+1500,
            "idempotency_key":f"synthetic-chaos-{tenant}-{ordinal:04d}-{now}",
            "resource_scopes":["project:alpha"],
            "body":{"synthetic":True,"ordinal":ordinal}}

def _result(lease,now:int):
    t=lease.task
    raw={"schema":SCHEMA_RESULT,"result_id":str(uuid.uuid5(uuid.NAMESPACE_URL,
         f"osgard-local-result/{t['task_id']}/{lease.fence}")),
         "task_id":t["task_id"],"task_digest":lease.task_digest,
         "tenant_id":lease.tenant_id,"status":"ok","completed_at":now,
         "body":{"simulated":True,"external_effects":0},"error_code":None}
    return validate_result(raw,task={"task":t,"digest":lease.task_digest},now=now)

def exercise_chaos(*,tasks_per_tenant:int=12)->dict:
    if type(tasks_per_tenant) is not int or not 4<=tasks_per_tenant<=64:
        raise ResilienceDenied("Synthetic campaign must contain 4..64 tasks per tenant")
    start=time.perf_counter()
    with tempfile.TemporaryDirectory(prefix="osgard-chaos-") as scratch:
        root=Path(scratch)
        db=root/"system.sqlite3"
        gateway=TransactionalLocalGateway(db,ROLES,max_attempts=3)
        sched=CapacityScheduler(gateway,COSTS)
        audit=LocalAuditTrail(root/"audit.sqlite3")
        current=NOW
        for tenant in TENANTS:
            gateway.access.provision(tenant,ACTOR,"operator",now=NOW)
            gateway.access.grant_scope(tenant,ACTOR,"task.preview","project:alpha",
                                       now=NOW,expires_at=NOW+3000)
            sched.set_budget(tenant,max_inflight=2,max_cpu=2,max_memory=256,max_disk=32)
            for ordinal in range(tasks_per_tenant):
                task=_task(tenant,ordinal,NOW)
                gateway.admit(task,authenticated_tenant=tenant,
                    authenticated_actor=ACTOR,now=NOW)
                audit.append(tenant=tenant,actor=ACTOR,trace_id=task["task_id"],
                    task_id=task["task_id"],at_epoch=NOW,event="TASK_ADMITTED",
                    code="LOCAL_SYNTHETIC",fields={"operation_count":1})
        succeeded=set()
        crashes=0
        recovered=0
        rounds=0
        # Inject a simulated abrupt worker crash for every fourth original job.
        while len(succeeded)<tasks_per_tenant*len(TENANTS):
            rounds+=1
            if rounds>tasks_per_tenant*len(TENANTS)*4:
                raise ResilienceDenied("Synthetic scheduler did not converge")
            lease=sched.reserve(worker_id="worker-chaos",now=current,lease_seconds=3)
            if lease is None:
                raise ResilienceDenied("Queue starved during synthetic recovery")
            tenant=lease.tenant_id
            audit.append(tenant=tenant,actor=ACTOR,trace_id=lease.task_id,
                task_id=lease.task_id,at_epoch=current,event="LOCAL_LEASE_CREATED",
                code="LEASED",fields={"fence":lease.fence,"attempt":lease.attempt})
            if lease.task["body"]["ordinal"]%4==0 and lease.attempt==1:
                crashes+=1
                audit.append(tenant=tenant,actor=ACTOR,trace_id=lease.task_id,
                    task_id=lease.task_id,at_epoch=current,event="CRASH_INJECTED",
                    code="SIMULATED_WORKER_EXIT",fields={"fence":lease.fence})
                current+=4
                recovery=sched.recover(now=current)
                recovered+=recovery["requeued"]
                audit.append(tenant=tenant,actor=ACTOR,trace_id=lease.task_id,
                    task_id=lease.task_id,at_epoch=current,event="LEASE_RECOVERED",
                    code="LOCAL_REQUEUE",fields={"recovered":recovery["requeued"]})
                continue
            outcome=sched.finish(lease,_result(lease,current),now=current)
            if outcome!="FINISHED_CAPACITY_LOCAL_ONLY" or lease.task_id in succeeded:
                raise ResilienceDenied("Duplicate or failed synthetic completion")
            succeeded.add(lease.task_id)
            audit.append(tenant=tenant,actor=ACTOR,trace_id=lease.task_id,
                task_id=lease.task_id,at_epoch=current,event="LOCAL_RESULT_STORED",
                code="SYNTHETIC_ONLY",fields={"attempt":lease.attempt})
            current+=1
        state={tenant:sched.jobs.counts(tenant) for tenant in TENANTS}
        if any(v["done"]!=tasks_per_tenant or v["ready"] or v["leased"] or v["dead"]
               for v in state.values()):
            raise ResilienceDenied("Synthetic queue invariants violated")
        if recovered!=crashes or crashes==0:
            raise ResilienceDenied("Injected crashes not recovered as expected")
        # Simulate a byte-level tamper against one newly admitted job.
        altered=_task(TENANTS[0],tasks_per_tenant+1,NOW)
        gateway.admit(altered,authenticated_tenant=TENANTS[0],
            authenticated_actor=ACTOR,now=current)
        with sqlite3.connect(db) as conn:
            conn.execute("UPDATE local_jobs SET task_json='{}' WHERE task_id=?",
                         (altered["task_id"],))
        if sched.reserve(worker_id="worker-chaos",now=current) is not None:
            raise ResilienceDenied("Corrupt queued body unexpectedly leased")
        if sched.jobs.counts(TENANTS[0])["dead"]!=1:
            raise ResilienceDenied("Corrupt queued body was not dead-lettered")
        audit.append(tenant=TENANTS[0],actor=ACTOR,trace_id=altered["task_id"],
                     task_id=altered["task_id"],at_epoch=current,
                     event="QUEUE_TAMPER_DENIED",code="DIGEST_REJECTED",fields={})
        # Multi-thread race: no more than one claimant may get a final task.
        race=_task(TENANTS[1],tasks_per_tenant+2,NOW)
        gateway.admit(race,authenticated_tenant=TENANTS[1],
                      authenticated_actor=ACTOR,now=current)
        with ThreadPoolExecutor(max_workers=8) as pool:
            results=list(pool.map(lambda n:sched.reserve(worker_id=f"worker-{n:03d}",
                               now=current),range(16)))
        winners=[item for item in results if item is not None]
        if len(winners)!=1:
            raise ResilienceDenied("Concurrent claim resulted in duplicate lease")
        winner=winners[0]
        sched.finish(winner,_result(winner,current),now=current)
        snapshot_parent=root/"snapshots"
        snapshot_parent.mkdir()
        snap=snapshot_sqlite(db,snapshot_parent,created_epoch=current)
        verified=verify_snapshot(Path(snap["backup_dir"]))
        restore=restore_drill(Path(snap["backup_dir"]),root)
        if not verified["integrity_verified"] or not restore["restored"]:
            raise ResilienceDenied("SQLite restore test failed")
        audit.append(tenant=TENANTS[1],actor=ACTOR,trace_id=race["task_id"],
                     task_id=race["task_id"],at_epoch=current,
                     event="RESTORE_DRILL_VERIFIED",code="LOCAL_RESTORE_ONLY",
                     fields={"operation_count":1})
        heads={tenant:audit.verify(tenant) for tenant in TENANTS}
        return {"schema":"osgard.original180.synthetic-resilience/1",
                "tasks_per_tenant":tasks_per_tenant,
                "synthetic_tasks_finished":len(succeeded)+1,
                "crashes_injected":crashes,"leases_recovered":recovered,
                "corrupt_payload_rejected":True,"concurrent_winners":len(winners),
                "restore_drill_passed":True,"audit_chain_verified":all(
                    x["local_chain_verified"] for x in heads.values()),
                "total_audit_events":sum(x["events"] for x in heads.values()),
                "elapsed_ms":round((time.perf_counter()-start)*1000,2),
                "external_side_effects":0,"real_chaos_tested":False,
                "production_release_authorized":False}

def main(argv=None)->int:
    import argparse
    parser=argparse.ArgumentParser(description="Local synthetic, never production chaos drills")
    parser.add_argument("--tasks-per-tenant",type=int,default=12)
    args=parser.parse_args(argv)
    print(json.dumps(exercise_chaos(tasks_per_tenant=args.tasks_per_tenant),
                     sort_keys=True))
    return 0

if __name__=="__main__":
    raise SystemExit(main())
