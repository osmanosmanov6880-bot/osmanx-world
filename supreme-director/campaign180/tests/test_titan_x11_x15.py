"""Exact original TITAN-X11..X15 local integration acceptance.

No external worker effects, real multi-server consensus, or canonical
KRAKEN/DevSwarm/Command source is claimed. SQLite multi-process only.
"""
from dataclasses import replace
from concurrent.futures import ThreadPoolExecutor,ProcessPoolExecutor
from pathlib import Path
import sqlite3
import tempfile
import unittest
import uuid

from campaign180.contracts import SCHEMA_TASK,SCHEMA_RESULT,digest,validate_result
from campaign180.gateway import TransactionalLocalGateway,AdmissionDenied
from campaign180.queue import DurableLocalQueue,QueueDenied
from campaign180.effect_outbox import LocalEffectOutbox,EffectLease
from campaign180.scheduler import CapacityScheduler,ResourceCost

NOW=1799971200
ACTOR="owner-abc"
TENANT="tenant_alpha"
ROLES={"operator":{"task.preview"}}
COSTS={"task.preview":ResourceCost(2,128,3)}

def task(tenant=TENANT,capability="task.preview",expiry=NOW+1000):
    return {"schema":SCHEMA_TASK,"task_id":str(uuid.uuid4()),"tenant_id":tenant,
            "actor_id":ACTOR,"capability":capability,"issued_at":NOW-1,
            "expires_at":expiry,"idempotency_key":"titan-x11-x15-"+uuid.uuid4().hex,
            "resource_scopes":["project:alpha"],"body":{"intent":"local"}}

def result_for(lease,when=NOW+1):
    body={"schema":SCHEMA_RESULT,"result_id":str(uuid.uuid4()),
          "task_id":lease.task_id,"task_digest":lease.task_digest,
          "tenant_id":lease.tenant_id,"status":"ok","completed_at":when,
          "body":{"external_effect":False},"error_code":None}
    return validate_result(body,task={"task":lease.task,
                                      "digest":lease.task_digest},now=when)

def reserve_process(args):
    file,worker=args
    gw=TransactionalLocalGateway(file,ROLES)
    sch=CapacityScheduler(gw,COSTS)
    out=sch.reserve(worker_id=worker,now=NOW)
    return None if out is None else (out.task_id,out.fence)

class FirstFiveNextTests(unittest.TestCase):
    def setUp(self):
        d=tempfile.TemporaryDirectory()
        self.addCleanup(d.cleanup)
        self.db=Path(d.name)/"x11-x15.sqlite"
        self.gateway=TransactionalLocalGateway(self.db,ROLES,max_attempts=3)
        for tenant in (TENANT,"tenant_beta"):
            self.gateway.access.provision(tenant,ACTOR,"operator",now=NOW)
            self.gateway.access.grant_scope(
                tenant,ACTOR,"task.preview","project:alpha",
                now=NOW,expires_at=NOW+900)
        self.queue=self.gateway.jobs
        self.scheduler=CapacityScheduler(self.gateway,COSTS)
        self.outbox=LocalEffectOutbox(self.queue)

    def admit(self,tenant=TENANT):
        data=task(tenant=tenant)
        self.gateway.admit(data,authenticated_tenant=tenant,
                           authenticated_actor=ACTOR,now=NOW)
        return data

    def cap(self,tenant=TENANT,*,inflight=2,cpu=4,mem=256,disk=6,pending=10):
        self.scheduler.set_budget(tenant,max_inflight=inflight,max_cpu=cpu,
            max_memory=mem,max_disk=disk,max_pending=pending)

    def test_x11_real_sqlite_persisted_queue_integrity_after_reopen(self):
        data=self.admit()
        before=self.queue.verify_durability(tenant_id=TENANT)
        self.assertEqual(before["jobs_verified"],1)
        self.assertEqual(before["receipts_verified"],0)
        self.assertEqual(before["sqlite_quick_check"],"ok")
        reopened=DurableLocalQueue(self.db)
        self.assertEqual(reopened.verify_durability(tenant_id=TENANT)["jobs_verified"],1)
        lease=reopened.reserve(worker_id="worker-one",now=NOW)
        self.assertEqual(reopened.verify_durability(tenant_id=TENANT)["jobs_verified"],1)
        reopened.record_result(lease,result_for(lease),now=NOW+1)
        self.assertEqual(reopened.verify_durability(tenant_id=TENANT)["receipts_verified"],1)

    def test_x11_transition_corruption_detected(self):
        self.admit()
        with sqlite3.connect(self.db) as db:
            # First prove the immutable transition trigger works.
            with self.assertRaises(sqlite3.IntegrityError):
                db.execute("""UPDATE local_job_transitions SET state='done'
                    WHERE tenant=?""",(TENANT,))
            # Simulate a privileged DB administrator disabling the trigger;
            # the independent consistency verification must still reject it.
            db.execute("DROP TRIGGER local_job_transition_immutable_update")
            db.execute("""UPDATE local_job_transitions SET state='done'
                WHERE tenant=?""",(TENANT,))
        with self.assertRaises(QueueDenied):
            self.queue.verify_durability(tenant_id=TENANT)

    def test_x11_tampered_task_digest_detected(self):
        self.admit()
        with sqlite3.connect(self.db) as db:
            db.execute("UPDATE local_jobs SET task_digest='x' WHERE tenant=?",(TENANT,))
        with self.assertRaises(QueueDenied):
            self.queue.verify_durability(tenant_id=TENANT)

    def _finished(self):
        data=self.admit()
        lease=self.gateway.reserve(worker_id="worker-x12",now=NOW)
        res=result_for(lease)
        self.assertEqual(self.gateway.finish(lease,res,now=NOW+1),
                         "FINISHED_GUARDED_LOCAL_ONLY")
        return data,lease,res

    def test_x12_effect_outbox_created_atomically_only_once(self):
        data,lease,res=self._finished()
        row=self.outbox.inspect(tenant_id=TENANT,task_id=lease.task_id)
        self.assertEqual(row["state"],"ready")
        self.assertFalse(row["external_effect_proven"])
        self.gateway.finish(lease,res,now=NOW+1)
        with sqlite3.connect(self.db) as db:
            self.assertEqual(db.execute("""SELECT COUNT(*) FROM local_effect_outbox
                WHERE tenant=? AND task_id=?""",(TENANT,lease.task_id)).fetchone()[0],1)
        self.assertEqual(self.queue.verify_durability(tenant_id=TENANT)["receipts_verified"],1)

    def test_x12_ack_fence_replay_wrong_token_and_final_effect(self):
        _,lease,_=self._finished()
        effect=self.outbox.reserve(tenant_id=TENANT,worker_id="delivery-one",now=NOW+2)
        self.assertEqual(effect.task_id,lease.task_id)
        with self.assertRaises(QueueDenied):
            self.outbox.confirm(replace(effect,token="f"*64),
                now=NOW+3,result_sha256="a"*64)
        self.assertEqual(self.outbox.confirm(effect,now=NOW+3,
                            result_sha256="a"*64),"ACK_RECORDED_LOCAL_ONLY")
        with self.assertRaises(QueueDenied):
            self.outbox.confirm(effect,now=NOW+3,result_sha256="a"*64)
        self.assertIsNone(self.outbox.reserve(
            tenant_id=TENANT,worker_id="delivery-two",now=NOW+4))
        self.assertEqual(self.outbox.inspect(tenant_id=TENANT,
            task_id=lease.task_id)["state"],"delivered")

    def test_x12_crashed_delivery_reclaimed_but_stale_fence_denied(self):
        self._finished()
        old=self.outbox.reserve(tenant_id=TENANT,worker_id="delivery-one",
                                now=NOW+2,lease_seconds=5)
        self.assertIsNone(self.outbox.reserve(tenant_id=TENANT,
            worker_id="delivery-two",now=NOW+5))
        newer=self.outbox.reserve(tenant_id=TENANT,
            worker_id="delivery-two",now=NOW+7)
        self.assertEqual(newer.fence,old.fence+1)
        with self.assertRaises(QueueDenied):
            self.outbox.confirm(old,now=NOW+8,result_sha256="b"*64)
        self.outbox.confirm(newer,now=NOW+8,result_sha256="b"*64)

    def test_x12_foreign_tenant_cannot_read_effect_outbox(self):
        _,lease,_=self._finished()
        self.assertIsNone(self.outbox.inspect(tenant_id="tenant_beta",task_id=lease.task_id))
        self.assertIsNone(self.outbox.reserve(tenant_id="tenant_beta",
            worker_id="delivery-two",now=NOW+2))

    def test_x13_only_expired_specific_worker_and_backoff(self):
        a=self.admit();b=self.admit()
        old=self.gateway.reserve(worker_id="failed-worker",now=NOW,lease_seconds=5)
        healthy=self.gateway.reserve(worker_id="healthy-worker",now=NOW,lease_seconds=60)
        self.assertIsNotNone(old);self.assertIsNotNone(healthy)
        self.assertEqual(self.queue.recover_worker(
            worker_id="failed-worker",now=NOW+4)["requeued"],0)
        result=self.queue.recover_worker(worker_id="failed-worker",now=NOW+5,
            base_backoff_seconds=3,max_backoff_seconds=20)
        self.assertEqual(result["requeued"],1)
        self.assertEqual(result["healthy_leases_changed"],0)
        self.assertIsNone(self.gateway.reserve(worker_id="new-worker",now=NOW+7))
        newer=self.gateway.reserve(worker_id="new-worker",now=NOW+8)
        self.assertEqual(newer.task_id,old.task_id)
        self.assertEqual(newer.fence,old.fence+1)
        with self.assertRaises(QueueDenied):
            self.queue.record_result(old,result_for(old),now=NOW+8)
        self.assertEqual(self.queue.verify_durability(tenant_id=TENANT)["jobs_verified"],2)

    def test_x13_max_attempts_dead_letter_not_infinite_retry(self):
        self.admit()
        for i in range(3):
            when=NOW+i*10
            lease=self.gateway.reserve(worker_id="worker-crash",now=when,
                                      lease_seconds=1)
            self.assertIsNotNone(lease)
            self.queue.recover_worker(worker_id="worker-crash",
                now=when+1,base_backoff_seconds=2,max_backoff_seconds=2)
        self.assertEqual(self.queue.counts(TENANT)["dead"],1)
        self.assertIsNone(self.gateway.reserve(worker_id="worker-retry",now=NOW+40))

    def test_x13_invalid_worker_and_backoff_rejected(self):
        with self.assertRaises(QueueDenied):
            self.queue.recover_worker(worker_id="../bad",now=NOW)
        with self.assertRaises(QueueDenied):
            self.queue.recover_worker(worker_id="worker-one",now=NOW,
                                     base_backoff_seconds=0)

    def test_x14_node_register_exclusive_heartbeat_and_token_fence(self):
        node=self.scheduler.register_node(node_id="node-alpha",now=NOW,ttl_seconds=30)
        with self.assertRaises(AdmissionDenied):
            self.scheduler.register_node(node_id="node-alpha",now=NOW+1)
        with self.assertRaises(AdmissionDenied):
            self.scheduler.heartbeat_node(node_id="node-alpha",
                token="0"*64,generation=node["generation"],now=NOW+1,ttl_seconds=60)
        deadline=self.scheduler.heartbeat_node(node_id="node-alpha",
            token=node["token"],generation=node["generation"],now=NOW+1,ttl_seconds=60)
        self.assertEqual(deadline,NOW+61)
        new=self.scheduler.register_node(node_id="node-alpha",now=NOW+61)
        self.assertEqual(new["generation"],node["generation"]+1)
        with self.assertRaises(AdmissionDenied):
            self.scheduler.heartbeat_node(node_id="node-alpha",
                token=node["token"],generation=node["generation"],
                now=NOW+62,ttl_seconds=120)

    def test_x14_node_bound_reservation_prevents_token_spoof(self):
        self.cap()
        self.admit()
        node=self.scheduler.register_node(node_id="node-alpha",now=NOW,ttl_seconds=30)
        with self.assertRaises(AdmissionDenied):
            self.scheduler.reserve(worker_id="node-alpha:work-one",now=NOW,
                node_id="node-alpha",node_token="0"*64,
                node_generation=node["generation"])
        lease=self.scheduler.reserve(worker_id="node-alpha:work-one",now=NOW,
            lease_seconds=60,node_id="node-alpha",node_token=node["token"],
            node_generation=node["generation"])
        self.assertIsNotNone(lease)
        self.assertEqual(lease.deadline,NOW+30)
        self.assertTrue(self.scheduler.verify_capacity_integrity(tenant=TENANT,now=NOW)["integrity_verified"])

    def test_x14_multiprocess_one_allocation_from_sqlite(self):
        self.cap(inflight=1,cpu=2,mem=128,disk=3)
        self.admit()
        with ProcessPoolExecutor(max_workers=3) as pool:
            results=list(pool.map(reserve_process,[(str(self.db),"worker-%02d"%i)
                                                   for i in range(6)]))
        self.assertEqual(sum(x is not None for x in results),1)
        self.assertEqual(self.scheduler.verify_capacity_integrity(
            tenant=TENANT,now=NOW)["inflight"],1)

    def test_x15_bounded_authorized_admission(self):
        self.cap(pending=1)
        a=task()
        self.assertEqual(self.scheduler.admit_with_capacity(a,
            authenticated_tenant=TENANT,authenticated_actor=ACTOR,now=NOW),
            "ADMITTED_GUARDED_LOCAL_ONLY")
        with self.assertRaises(AdmissionDenied):
            self.scheduler.admit_with_capacity(task(),
                authenticated_tenant=TENANT,authenticated_actor=ACTOR,now=NOW)
        self.assertEqual(self.scheduler.admit_with_capacity(a,
            authenticated_tenant=TENANT,authenticated_actor=ACTOR,now=NOW),
            "DUPLICATE_GUARDED_LOCAL_ONLY")

    def test_x15_no_budget_never_admitted(self):
        with self.assertRaises(AdmissionDenied):
            self.scheduler.admit_with_capacity(task(),
                 authenticated_tenant=TENANT,authenticated_actor=ACTOR,now=NOW)
        self.assertEqual(self.queue.counts(TENANT)["ready"],0)

    def test_x15_tenant_cost_and_identity_spoofing_denied(self):
        self.cap(cpu=1)
        with self.assertRaises(AdmissionDenied):
            self.scheduler.admit_with_capacity(task(),
                authenticated_tenant=TENANT,authenticated_actor=ACTOR,now=NOW)
        self.scheduler.set_budget(TENANT,max_inflight=2,
            max_cpu=2,max_memory=256,max_disk=6)
        with self.assertRaises(ValueError):
            self.scheduler.admit_with_capacity(task(tenant="tenant_beta"),
                authenticated_tenant=TENANT,authenticated_actor=ACTOR,now=NOW)
        self.assertEqual(self.queue.counts(TENANT)["ready"],0)

    def test_x15_orphan_allocation_fails_integrity(self):
        self.cap()
        self.admit()
        lease=self.scheduler.reserve(worker_id="worker-one",now=NOW)
        self.assertTrue(self.scheduler.verify_capacity_integrity(
            tenant=TENANT,now=NOW)["integrity_verified"])
        with sqlite3.connect(self.db) as db:
            db.execute("""UPDATE scheduler_allocations SET fence=fence+100
                WHERE tenant=?""",(TENANT,))
        with self.assertRaises(AdmissionDenied):
            self.scheduler.verify_capacity_integrity(tenant=TENANT,now=NOW)

if __name__=="__main__":
    unittest.main()
