"""Exact original TITAN-X11..X15: live SQLite queue/scheduler regression.

Only local integration evidence. Multi-host tests are in test_titan_x14_pg.
"""
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
import sqlite3
import tempfile
import unittest
import uuid

from campaign180.contracts import SCHEMA_TASK,SCHEMA_RESULT,validate_result,digest
from campaign180.gateway import TransactionalLocalGateway,AdmissionDenied
from campaign180.queue import QueueDenied,DurableLocalQueue
from campaign180.scheduler import CapacityScheduler,ResourceCost

NOW=1799971200
ROLES={"operator":{"task.preview"}}
COSTS={"task.preview":ResourceCost(2,128,3)}

def task(tenant="tenant_alpha",actor="operator-abc",*,key=None):
    return {"schema":SCHEMA_TASK,"task_id":str(uuid.uuid4()),
        "tenant_id":tenant,"actor_id":actor,"capability":"task.preview",
        "issued_at":NOW-2,"expires_at":NOW+500,
        "idempotency_key":key or "titan-x11-"+uuid.uuid4().hex,
        "resource_scopes":["project:alpha"],
        "body":{"customer_budget_claim":0,"synthetic":True}}

def result(lease,now=NOW+1):
    source=lease.task
    raw={"schema":SCHEMA_RESULT,"result_id":str(uuid.uuid4()),
         "task_id":source["task_id"],"task_digest":digest(source),
         "tenant_id":source["tenant_id"],"status":"ok",
         "completed_at":now,"body":{"test_effect_only":True},
         "error_code":None}
    return validate_result(raw,task={"task":source,"digest":digest(source)},now=now)

class OriginalX11ToX15SQLite(unittest.TestCase):
    def setUp(self):
        tmp=tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.db=Path(tmp.name)/"devswarm.sqlite3"
        self.gw=TransactionalLocalGateway(self.db,ROLES,max_attempts=2)
        self.scheduler=CapacityScheduler(self.gw,COSTS,worker_max_inflight=2)
        for tenant in ("tenant_alpha","tenant_beta"):
            self.gw.access.provision(tenant,"operator-abc","operator",now=NOW)
            self.gw.access.grant_scope(tenant,"operator-abc","task.preview",
                "project:alpha",now=NOW,expires_at=NOW+550)

    def budget(self,tenant="tenant_alpha",max_pending=10,max_inflight=2):
        self.scheduler.set_budget(tenant,max_inflight=max_inflight,max_cpu=4,
            max_memory=256,max_disk=6,max_pending=max_pending)

    def enqueue(self,tenant="tenant_alpha"):
        body=task(tenant)
        self.gw.admit(body,authenticated_tenant=tenant,
                      authenticated_actor="operator-abc",now=NOW)
        return body

    def test_x11_trigger_audits_every_route_without_raw_task_payload(self):
        self.budget()
        body=self.enqueue()
        lease=self.scheduler.reserve(worker_id="worker-abc",now=NOW)
        self.scheduler.finish(lease,result(lease),now=NOW+1)
        changes=self.gw.jobs.transitions(tenant_id="tenant_alpha",
                                          task_id=body["task_id"])
        self.assertEqual([c["state"] for c in changes],["ready","leased","done"])
        self.assertTrue(all("task_json" not in c for c in changes))
        with sqlite3.connect(self.db) as db:
            with self.assertRaises(sqlite3.IntegrityError):
                db.execute("DELETE FROM local_job_transitions WHERE tenant=?",
                           ("tenant_alpha",))

    def test_x11_cancel_cannot_cross_actor_or_resurrect_job(self):
        self.budget()
        body=self.enqueue()
        with self.assertRaises(QueueDenied):
            self.gw.jobs.cancel(tenant_id="tenant_alpha",task_id=body["task_id"],
                                actor_id="intruder-abc",now=NOW+1)
        self.assertEqual(self.gw.jobs.cancel(
            tenant_id="tenant_alpha",task_id=body["task_id"],
            actor_id="operator-abc",now=NOW+1),"CANCELLED_LOCAL_ONLY")
        self.assertIsNone(self.scheduler.reserve(worker_id="worker-abc",now=NOW+2))
        self.assertEqual(self.gw.jobs.counts("tenant_alpha")["dead"],1)
        self.assertEqual(len(self.gw.jobs.dead_letters(tenant_id="tenant_alpha")),1)
        self.assertEqual(self.gw.jobs.dead_letters(tenant_id="tenant_beta"),[])

    def test_x12_single_effect_receipt_from_scheduler_finish(self):
        self.budget()
        body=self.enqueue()
        lease=self.scheduler.reserve(worker_id="worker-abc",now=NOW)
        first=result(lease)
        self.assertEqual(self.scheduler.finish(lease,first,now=NOW+1),
                         "FINISHED_CAPACITY_LOCAL_ONLY")
        self.assertEqual(self.scheduler.finish(lease,first,now=NOW+1),
                         "ALREADY_FINISHED_CAPACITY_LOCAL_ONLY")
        receipt=self.gw.jobs.effect_receipt(tenant_id="tenant_alpha",
                                            task_id=body["task_id"])
        self.assertEqual(receipt["result_digest"],first["digest"])
        self.assertTrue(receipt["recorded_once_in_sqlite"])
        self.assertFalse(receipt["external_effect_executed"])
        self.assertEqual(self.gw.jobs.verify_effect_ledger(
            tenant_id="tenant_alpha")["recorded_local_effects"],1)
        with sqlite3.connect(self.db) as db:
            self.assertEqual(db.execute("SELECT COUNT(*) FROM local_job_effects").fetchone()[0],1)
            with self.assertRaises(sqlite3.IntegrityError):
                db.execute("DELETE FROM local_job_effects")

    def test_x12_gateway_finish_also_creates_effect(self):
        body=self.enqueue()
        lease=self.gw.reserve(worker_id="worker-abc",now=NOW)
        self.assertEqual(self.gw.finish(lease,result(lease),now=NOW+1),
                         "FINISHED_GUARDED_LOCAL_ONLY")
        self.assertIsNotNone(self.gw.jobs.effect_receipt(
            tenant_id="tenant_alpha",task_id=body["task_id"]))

    def test_x12_stale_worker_never_commits_receipt(self):
        self.budget()
        body=self.enqueue()
        old=self.scheduler.reserve(worker_id="worker-old",now=NOW,lease_seconds=3)
        self.scheduler.recover(now=NOW+3)
        new=self.scheduler.reserve(worker_id="worker-new",now=NOW+4)
        self.assertEqual(new.fence,old.fence+1)
        with self.assertRaises((AdmissionDenied,QueueDenied)):
            self.scheduler.finish(old,result(old),now=NOW+4)
        self.assertIsNone(self.gw.jobs.effect_receipt(
            tenant_id="tenant_alpha",task_id=body["task_id"]))
        self.scheduler.finish(new,result(new,now=NOW+5),now=NOW+5)
        self.assertEqual(self.gw.jobs.verify_effect_ledger(
            tenant_id="tenant_alpha")["recorded_local_effects"],1)

    def test_x13_lease_heartbeat_rotates_deadline_and_capacity_together(self):
        self.budget()
        self.enqueue()
        old=self.scheduler.reserve(worker_id="worker-abc",now=NOW,lease_seconds=5)
        fresh=self.scheduler.renew(old,now=NOW+2,lease_seconds=15)
        self.assertEqual(fresh.deadline,NOW+17)
        self.assertEqual(fresh.fence,old.fence)
        with self.assertRaises((AdmissionDenied,QueueDenied)):
            self.scheduler.finish(old,result(old),now=NOW+3)
        self.assertEqual(self.scheduler.admission_snapshot(
            "tenant_alpha",now=NOW+6)["inflight"],1)
        self.assertEqual(self.scheduler.finish(fresh,result(fresh,now=NOW+7),
                         now=NOW+7),"FINISHED_CAPACITY_LOCAL_ONLY")

    def test_x13_revoke_membership_blocks_heartbeat(self):
        self.budget()
        self.enqueue()
        old=self.scheduler.reserve(worker_id="worker-abc",now=NOW,lease_seconds=5)
        self.gw.access.revoke_member("tenant_alpha","operator-abc",now=NOW+1)
        with self.assertRaises(AdmissionDenied):
            self.scheduler.renew(old,now=NOW+2,lease_seconds=12)
        self.assertEqual(self.scheduler.usage("tenant_alpha",now=NOW+2)["leased"],1)

    def test_x13_expire_recover_releases_budget_and_keeps_audit(self):
        self.budget()
        body=self.enqueue()
        old=self.scheduler.reserve(worker_id="worker-abc",now=NOW,lease_seconds=2)
        self.scheduler.recover(now=NOW+2)
        self.assertEqual(self.scheduler.admission_snapshot(
            "tenant_alpha",now=NOW+2)["inflight"],0)
        new=self.scheduler.reserve(worker_id="worker-new",now=NOW+3)
        self.assertEqual(new.fence,old.fence+1)
        self.assertEqual([v["state"] for v in self.gw.jobs.transitions(
            tenant_id="tenant_alpha",task_id=body["task_id"])],
            ["ready","leased","ready","leased"])

    def test_x15_backpressure_is_atomic_at_queue_insert(self):
        self.budget(max_pending=1)
        self.enqueue()
        with self.assertRaises((AdmissionDenied,QueueDenied)):
            self.enqueue()
        self.assertEqual(self.gw.jobs.counts("tenant_alpha")["ready"],1)
        self.assertFalse(self.scheduler.admission_snapshot(
            "tenant_alpha",now=NOW)["admission_only_not_os_resource_enforcement"] is False)

    def test_x15_cannot_shrink_limits_below_live_allocations(self):
        self.budget()
        self.enqueue()
        self.scheduler.reserve(worker_id="worker-abc",now=NOW)
        with self.assertRaises(AdmissionDenied):
            self.scheduler.set_budget("tenant_alpha",max_inflight=1,max_cpu=1,
                max_memory=256,max_disk=6,max_pending=10)
        self.assertEqual(self.scheduler.admission_snapshot(
            "tenant_alpha",now=NOW)["max_cpu"],4)

    def test_x15_worker_limit_across_tenants(self):
        self.budget("tenant_alpha")
        self.budget("tenant_beta")
        self.enqueue("tenant_alpha")
        self.enqueue("tenant_beta")
        # Worker budget 2, cannot obtain a third allocation.
        self.assertIsNotNone(self.scheduler.reserve(worker_id="worker-abc",now=NOW))
        self.assertIsNotNone(self.scheduler.reserve(worker_id="worker-abc",now=NOW))
        self.enqueue("tenant_alpha")
        self.assertIsNone(self.scheduler.reserve(worker_id="worker-abc",now=NOW))
        self.assertIsNotNone(self.scheduler.reserve(worker_id="worker-other",now=NOW))

    def test_x15_tenant_snapshot_scoped_and_denies_invalid_tenant(self):
        self.budget()
        snap=self.scheduler.admission_snapshot("tenant_alpha",now=NOW)
        self.assertEqual(snap["ready"],0)
        self.assertEqual(snap["max_pending"],10)
        with self.assertRaises(AdmissionDenied):
            self.scheduler.admission_snapshot("broken/tenant",now=NOW)

if __name__=="__main__":
    unittest.main()
