"""Actual PostgreSQL 16 integration of original TITAN-X11..X15, especially X14.

Requires DEVSWARM_TEST_PG_DSN on a dedicated disposable test database.
Never contacts any production database and never claims canonical upstream.
"""
from concurrent.futures import ThreadPoolExecutor
import os
import unittest
import uuid

from campaign180.contracts import SCHEMA_TASK,SCHEMA_RESULT,validate_result,digest
from campaign180.pg_devswarm import PostgresDevSwarmScheduler,SharedSchedulerDenied
from campaign180.scheduler import ResourceCost

NOW=1799971200
DSN=os.environ.get("DEVSWARM_TEST_PG_DSN")
COSTS={"task.preview":ResourceCost(1,128,2)}

def body(tenant,*,actor="worker-owner-abc",idem=None):
    return {"schema":SCHEMA_TASK,"task_id":str(uuid.uuid4()),
            "tenant_id":tenant,"actor_id":actor,"capability":"task.preview",
            "issued_at":NOW,"expires_at":NOW+700,
            "idempotency_key":idem or "postgres-titan-"+uuid.uuid4().hex,
            "resource_scopes":["project:alpha"],
            "body":{"synthetic_postgresql_test":True}}

def result(lease,now=NOW+1):
    t=lease.task
    payload={"schema":SCHEMA_RESULT,"result_id":str(uuid.uuid4()),
        "task_id":t["task_id"],"task_digest":digest(t),
        "tenant_id":t["tenant_id"],"status":"ok",
        "completed_at":now,"body":{"local_receipt_only":True},
        "error_code":None}
    return validate_result(payload,task={"task":t,"digest":digest(t)},now=now)

@unittest.skipUnless(DSN,"Dedicated disposable PostgreSQL 16 DSN required")
class SharedPostgresIntegration(unittest.TestCase):
    def setUp(self):
        self.tenant="tenant_"+uuid.uuid4().hex[:14]
        self.actor="worker-owner-abc"
        self.db=PostgresDevSwarmScheduler(DSN,COSTS,worker_max_inflight=2,
                                          max_attempts=2)
        # Dedicated disposable CI database; test cases must not leak ready
        # jobs or budgets into the next case's global round-robin cursor.
        with self.db._tx() as sql:
            sql.execute("""TRUNCATE TABLE titan_pg_effects,titan_pg_allocations,
                titan_pg_jobs,titan_pg_budgets,titan_pg_cursor""")
            sql.execute("""INSERT INTO titan_pg_cursor(id,last_tenant)
                VALUES(1,'')""")
        self.db.set_budget(self.tenant,max_inflight=2,max_cpu=2,
                           max_memory=256,max_disk=4,max_pending=10)

    def admit(self,tenant=None,idem=None):
        t=body(tenant or self.tenant,idem=idem)
        response=self.db.admit(t,authenticated_tenant=t["tenant_id"],
            authenticated_actor=t["actor_id"],scopes={"project:alpha"},now=NOW)
        self.assertEqual(response,"ADMITTED_POSTGRES_LOCAL_ONLY")
        return t

    def test_actual_2_hosts_same_database_lease_once(self):
        task=self.admit()
        # Separate instances and independent SQL sessions, simulating two
        # scheduler processes/hosts on one central database.
        def compete(i):
            conn=PostgresDevSwarmScheduler(DSN,COSTS,initialize_schema=False)
            return conn.reserve(worker_id="node-%02d"%i,now=NOW)
        with ThreadPoolExecutor(max_workers=8) as pool:
            leases=list(pool.map(compete,range(12)))
        accepted=[lease for lease in leases if lease]
        self.assertEqual(len(accepted),1)
        self.assertEqual(accepted[0].task_id,task["task_id"])
        self.assertEqual(accepted[0].fence,1)

    def test_effect_once_and_fence_replay_rejected(self):
        task=self.admit()
        lease=self.db.reserve(worker_id="node-001",now=NOW)
        proof=result(lease)
        self.assertEqual(self.db.finish(lease,proof,now=NOW+1),
                        "FINISHED_ONCE_POSTGRES_LOCAL_ONLY")
        self.assertEqual(self.db.finish(lease,proof,now=NOW+1),
                         "ALREADY_FINISHED_NO_NEW_EFFECT")
        report=self.db.inspect(tenant=self.tenant,now=NOW+1)
        self.assertEqual(report["local_recorded_effects"],1)
        self.assertEqual(report["inflight"],0)
        with self.db._tx() as sql:
            with self.assertRaises(Exception):
                with sql.transaction():
                    sql.execute("""DELETE FROM titan_pg_effects
                        WHERE tenant=%s""",(self.tenant,))

    def test_multiple_hosts_share_resource_budget(self):
        self.admit()
        self.admit()
        self.admit()
        def take(i):
            conn=PostgresDevSwarmScheduler(DSN,COSTS,initialize_schema=False)
            return conn.reserve(worker_id="node-%02d"%i,now=NOW)
        with ThreadPoolExecutor(max_workers=6) as pool:
            leases=[x for x in pool.map(take,range(6)) if x]
        self.assertEqual(len(leases),2)
        snap=self.db.inspect(tenant=self.tenant,now=NOW)
        self.assertEqual(snap["inflight"],2)
        self.assertEqual(snap["cpu_reserved"],2)
        self.assertEqual(snap["memory_mb_reserved"],256)

    def test_crashed_worker_is_recovered_and_old_fence_invalid(self):
        t=self.admit()
        a=self.db.reserve(worker_id="node-old",now=NOW,lease_seconds=2)
        self.assertEqual(self.db.recover(now=NOW+2)["requeued"],1)
        b=self.db.reserve(worker_id="node-new",now=NOW+3)
        self.assertEqual(b.fence,a.fence+1)
        with self.assertRaises(SharedSchedulerDenied):
            self.db.finish(a,result(a),now=NOW+4)
        self.assertEqual(self.db.finish(b,result(b,now=NOW+4),now=NOW+4),
                         "FINISHED_ONCE_POSTGRES_LOCAL_ONLY")

    def test_heartbeat_rotates_deadline_without_reclaiming_capacity(self):
        self.admit()
        old=self.db.reserve(worker_id="node-001",now=NOW,lease_seconds=4)
        latest=self.db.renew(old,now=NOW+2,lease_seconds=9)
        self.assertEqual(latest.deadline,NOW+11)
        self.assertEqual(self.db.inspect(tenant=self.tenant,now=NOW+2)["inflight"],1)
        with self.assertRaises(SharedSchedulerDenied):
            self.db.finish(old,result(old),now=NOW+3)
        self.assertEqual(self.db.finish(latest,result(latest,now=NOW+5),now=NOW+5),
                        "FINISHED_ONCE_POSTGRES_LOCAL_ONLY")

    def test_backpressure_admission_and_safe_budget_shrink(self):
        self.db.set_budget(self.tenant,max_inflight=2,max_cpu=2,
            max_memory=256,max_disk=4,max_pending=1)
        self.admit()
        with self.assertRaises(SharedSchedulerDenied):
            self.admit()
        lease=self.db.reserve(worker_id="node-one",now=NOW)
        with self.assertRaises(SharedSchedulerDenied):
            self.db.set_budget(self.tenant,max_inflight=1,max_cpu=1,
                max_memory=64,max_disk=2,max_pending=1)
        self.assertEqual(self.db.inspect(tenant=self.tenant,now=NOW)["cpu_reserved"],1)

    def test_cross_tenant_authorization_is_denied(self):
        wrong=body(self.tenant)
        with self.assertRaises(ValueError):
            self.db.admit(wrong,authenticated_tenant="tenant_foreign",
                  authenticated_actor=wrong["actor_id"],
                  scopes={"project:alpha"},now=NOW)
        self.assertEqual(self.db.inspect(tenant=self.tenant,now=NOW)["inflight"],0)

    def test_duplicate_idempotency_conflict_fails_closed(self):
        first=self.admit()
        self.assertEqual(self.db.admit(first,authenticated_tenant=self.tenant,
            authenticated_actor=self.actor,scopes={"project:alpha"},now=NOW),
            "DUPLICATE_NO_NEW_EFFECT")
        second=body(self.tenant,idem=first["idempotency_key"])
        with self.assertRaises(SharedSchedulerDenied):
            self.db.admit(second,authenticated_tenant=self.tenant,
                authenticated_actor=self.actor,scopes={"project:alpha"},now=NOW)

    def test_cancel_denies_other_actor_and_releases_capacity(self):
        job=self.admit()
        a=self.db.reserve(worker_id="node-one",now=NOW)
        with self.assertRaises(SharedSchedulerDenied):
            self.db.cancel(tenant=self.tenant,actor="attacker-abc",task_id=job["task_id"])
        self.assertEqual(self.db.cancel(tenant=self.tenant,actor=self.actor,
                         task_id=job["task_id"]),"CANCELLED_POSTGRES")
        self.assertEqual(self.db.inspect(tenant=self.tenant,now=NOW)["inflight"],0)
        with self.assertRaises(SharedSchedulerDenied):
            self.db.finish(a,result(a),now=NOW+1)

    def test_tenant_round_robin_across_two_postgres_clients(self):
        other="tenant_"+uuid.uuid4().hex[:12]
        self.db.set_budget(other,max_inflight=2,max_cpu=2,
                           max_memory=256,max_disk=4)
        self.admit(self.tenant)
        self.admit(other)
        c1=PostgresDevSwarmScheduler(DSN,COSTS,initialize_schema=False)
        c2=PostgresDevSwarmScheduler(DSN,COSTS,initialize_schema=False)
        out=[c1.reserve(worker_id="node-one",now=NOW),
             c2.reserve(worker_id="node-two",now=NOW)]
        self.assertEqual({x.tenant_id for x in out},{self.tenant,other})

if __name__=="__main__":
    unittest.main()
