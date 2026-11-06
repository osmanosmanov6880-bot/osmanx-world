"""TITAN-X14/X15 and X28: capacity admission, process-safe leases and restore."""
from concurrent.futures import ThreadPoolExecutor, ProcessPoolExecutor
from pathlib import Path
import json
import sqlite3
import tempfile
import unittest
import uuid

from campaign180.access import AccessDirectory
from campaign180.contracts import SCHEMA_TASK,SCHEMA_RESULT,validate_result,digest
from campaign180.gateway import TransactionalLocalGateway,AdmissionDenied
from campaign180.scheduler import CapacityScheduler,ResourceCost
from campaign180.backup import (snapshot_sqlite,verify_snapshot,restore_snapshot,
                                restore_drill,BackupDenied)

NOW=1799971200
ROLES={"operator":{"task.preview"}}
COSTS={"task.preview":ResourceCost(2,256,3)}


def build_task(tenant: str,actor: str):
    return {"schema":SCHEMA_TASK,"task_id":str(uuid.uuid4()),"tenant_id":tenant,
            "actor_id":actor,"capability":"task.preview","issued_at":NOW-2,
            "expires_at":NOW+800,"idempotency_key":"scheduler-"+uuid.uuid4().hex,
            "resource_scopes":["project:alpha"],"body":{"cpu_units":0,"priority":"high"}}


def source_result(lease,now=NOW+1):
    task=lease.task
    raw={"schema":SCHEMA_RESULT,"result_id":str(uuid.uuid4()),
         "task_id":task["task_id"],"task_digest":digest(task),
         "tenant_id":task["tenant_id"],"status":"ok","completed_at":now,
         "body":{"physical_work_done":False},"error_code":None}
    return validate_result(raw,task={"task":task,"digest":digest(task)},now=now)


def concurrent_reserve(arg):
    path,worker=arg
    gateway=TransactionalLocalGateway(path,ROLES)
    sched=CapacityScheduler(gateway,COSTS)
    lease=sched.reserve(worker_id=worker,now=NOW)
    return None if lease is None else (lease.tenant_id,lease.task_id,lease.fence)


class SchedulerTests(unittest.TestCase):
    def setUp(self):
        tmp=tempfile.TemporaryDirectory();self.addCleanup(tmp.cleanup)
        self.root=Path(tmp.name)
        self.database=self.root/"app.sqlite3"
        self.gateway=TransactionalLocalGateway(self.database,ROLES,max_attempts=2)
        self.scheduler=CapacityScheduler(self.gateway,COSTS)
        for tenant in ("tenant_alpha","tenant_beta"):
            self.gateway.access.provision(tenant,"operator-abc","operator",now=NOW)
            self.gateway.access.grant_scope(tenant,"operator-abc","task.preview",
                "project:alpha",now=NOW,expires_at=NOW+750)

    def enqueue(self,tenant="tenant_alpha"):
        task=build_task(tenant,"operator-abc")
        self.gateway.admit(task,authenticated_tenant=tenant,
                           authenticated_actor="operator-abc",now=NOW)
        return task

    def test_capacity_denies_without_explicit_budget(self):
        self.enqueue()
        self.assertIsNone(self.scheduler.reserve(worker_id="worker-one",now=NOW))
        self.assertEqual(self.scheduler.usage("tenant_alpha",now=NOW)["leased"],0)

    def test_per_tenant_capacity_and_client_cost_spoofing(self):
        self.scheduler.set_budget("tenant_alpha",max_inflight=1,max_cpu=2,
                                  max_memory=256,max_disk=3)
        self.enqueue()
        self.enqueue()
        lease=self.scheduler.reserve(worker_id="worker-one",now=NOW)
        self.assertEqual(lease.tenant_id,"tenant_alpha")
        self.assertIsNone(self.scheduler.reserve(worker_id="worker-two",now=NOW))
        usage=self.scheduler.usage("tenant_alpha",now=NOW)
        self.assertEqual(usage["cpu_reserved"],2)
        self.assertFalse(usage["physical_resource_enforcement"])
        self.assertEqual(self.scheduler.finish(lease,source_result(lease),now=NOW+1),
                         "FINISHED_CAPACITY_LOCAL_ONLY")
        self.assertEqual(self.scheduler.usage("tenant_alpha",now=NOW+1)["leased"],0)
        self.assertIsNotNone(self.scheduler.reserve(worker_id="worker-two",now=NOW+1))

    def test_fair_round_robin_across_tenants(self):
        for tenant in ("tenant_alpha","tenant_beta"):
            self.scheduler.set_budget(tenant,max_inflight=3,max_cpu=10,
                                      max_memory=2000,max_disk=100)
            for _ in range(3):self.enqueue(tenant)
        result=[self.scheduler.reserve(worker_id="worker-one",now=NOW).tenant_id
                for _ in range(6)]
        self.assertEqual(result,["tenant_alpha","tenant_beta"]*3)

    def test_capacity_skip_one_tenant_without_starving_other(self):
        self.scheduler.set_budget("tenant_alpha",max_inflight=1,max_cpu=1,
                                  max_memory=256,max_disk=3)
        self.scheduler.set_budget("tenant_beta",max_inflight=1,max_cpu=2,
                                  max_memory=256,max_disk=3)
        self.enqueue("tenant_alpha")
        self.enqueue("tenant_beta")
        lease=self.scheduler.reserve(worker_id="worker-one",now=NOW)
        self.assertEqual(lease.tenant_id,"tenant_beta")

    def test_expired_lease_recovery_fences_stale_worker_and_releases_budget(self):
        self.scheduler.set_budget("tenant_alpha",max_inflight=1,max_cpu=2,
                                  max_memory=256,max_disk=3)
        self.enqueue()
        first=self.scheduler.reserve(worker_id="worker-one",now=NOW,lease_seconds=5)
        self.scheduler.recover(now=NOW+5)
        self.assertEqual(self.scheduler.usage("tenant_alpha",now=NOW+5)["leased"],0)
        second=self.scheduler.reserve(worker_id="worker-two",now=NOW+6)
        self.assertEqual(second.fence,first.fence+1)
        with self.assertRaises(AdmissionDenied):
            self.scheduler.finish(first,source_result(first),now=NOW+7)

    def test_retry_releases_capacity_and_limits_attempts(self):
        self.scheduler.set_budget("tenant_alpha",max_inflight=1,max_cpu=2,
                                  max_memory=256,max_disk=3)
        self.enqueue()
        a=self.scheduler.reserve(worker_id="worker-one",now=NOW)
        self.assertEqual(self.scheduler.retry(a,now=NOW+1), "RETRY_CAPACITY_LOCAL_ONLY")
        b=self.scheduler.reserve(worker_id="worker-two",now=NOW+2)
        self.assertEqual(self.scheduler.retry(b,now=NOW+3),"DEAD_CAPACITY_LOCAL_ONLY")
        self.assertEqual(self.scheduler.usage("tenant_alpha",now=NOW+3)["leased"],0)

    def test_lease_held_during_revocation_cannot_finalize(self):
        self.scheduler.set_budget("tenant_alpha",max_inflight=1,max_cpu=2,
                                  max_memory=256,max_disk=3)
        self.enqueue()
        a=self.scheduler.reserve(worker_id="worker-one",now=NOW)
        self.gateway.access.revoke_member("tenant_alpha","operator-abc",now=NOW+1)
        with self.assertRaises(AdmissionDenied):
            self.scheduler.finish(a,source_result(a),now=NOW+2)

    def test_multiprocess_one_lease_per_job(self):
        self.scheduler.set_budget("tenant_alpha",max_inflight=1,max_cpu=2,
                                  max_memory=256,max_disk=3)
        self.enqueue()
        args=[(str(self.database),"worker-%03d"%i) for i in range(8)]
        with ProcessPoolExecutor(max_workers=4) as pool:
            leases=list(pool.map(concurrent_reserve,args))
        self.assertEqual(sum(v is not None for v in leases),1)
        self.assertEqual(self.scheduler.usage("tenant_alpha",now=NOW)["leased"],1)

    def test_allocation_invalid_budget_rejected(self):
        with self.assertRaises(AdmissionDenied):
            ResourceCost(-1,1,1)
        with self.assertRaises(AdmissionDenied):
            self.scheduler.set_budget("tenant_alpha",max_inflight=0,
                                      max_cpu=2,max_memory=2,max_disk=2)
        with self.assertRaises(AdmissionDenied):
            self.scheduler.usage("tenant_other bad",now=NOW)


class BackupTests(unittest.TestCase):
    def setUp(self):
        tmp=tempfile.TemporaryDirectory();self.addCleanup(tmp.cleanup)
        self.root=Path(tmp.name)
        self.source=self.root/"source.sqlite3"
        with sqlite3.connect(self.source) as db:
            db.execute("PRAGMA foreign_keys=ON")
            db.execute("CREATE TABLE events (id INTEGER PRIMARY KEY, title TEXT NOT NULL)")
            db.execute("INSERT INTO events(title) VALUES('committed')")
        self.snaproot=self.root/"snapshots";self.snaproot.mkdir()

    def take(self):
        return snapshot_sqlite(self.source,self.snaproot,created_epoch=NOW)

    def test_consistent_snapshot_and_restore_drill(self):
        shot=self.take()
        verified=verify_snapshot(Path(shot["backup_dir"]))
        self.assertTrue(verified["integrity_verified"])
        self.assertFalse(verified["signature_verified"])
        with sqlite3.connect(self.source) as db:
            db.execute("INSERT INTO events(title) VALUES('later')")
        outcome=restore_drill(Path(shot["backup_dir"]),self.root)
        self.assertTrue(outcome["restored"])
        restored=self.root/"restored.sqlite3"
        restore_snapshot(Path(shot["backup_dir"]),restored,
                         expected_sha256=shot["sha256"])
        with sqlite3.connect(restored) as db:
            self.assertEqual(db.execute("SELECT COUNT(*) FROM events").fetchone()[0],1)
        with sqlite3.connect(self.source) as db:
            self.assertEqual(db.execute("SELECT COUNT(*) FROM events").fetchone()[0],2)

    def test_refuses_overwrite_existing_source(self):
        shot=self.take()
        with self.assertRaises(BackupDenied):
            restore_snapshot(Path(shot["backup_dir"]),self.source)
        self.assertEqual(self.source.read_bytes()[:6],b"SQLite")

    def test_corrupt_snapshot_detected_before_restore(self):
        shot=self.take()
        path=Path(shot["backup_dir"])/"snapshot.sqlite3"
        path.write_bytes(path.read_bytes()+b"malicious")
        with self.assertRaises(BackupDenied):
            verify_snapshot(Path(shot["backup_dir"]))
        with self.assertRaises(BackupDenied):
            restore_snapshot(Path(shot["backup_dir"]),self.root/"restored.sqlite3")
        self.assertFalse((self.root/"restored.sqlite3").exists())

    def test_modified_manifest_denied(self):
        shot=self.take()
        path=Path(shot["backup_dir"])/"manifest.json"
        data=json.loads(path.read_text())
        data["bytes"]=0
        path.write_text(json.dumps(data))
        with self.assertRaises(BackupDenied):
            verify_snapshot(Path(shot["backup_dir"]))

    def test_checksum_must_match_external_expected_digest(self):
        shot=self.take()
        with self.assertRaises(BackupDenied):
            restore_snapshot(Path(shot["backup_dir"]),self.root/"restored.sqlite3",
                             expected_sha256="0"*64)

    def test_symlinked_source_and_snapshot_denied(self):
        symlink=self.root/"linked.sqlite3"
        symlink.symlink_to(self.source)
        with self.assertRaises(BackupDenied):
            snapshot_sqlite(symlink,self.snaproot,created_epoch=NOW)
        shot=self.take()
        p=Path(shot["backup_dir"])/"snapshot.sqlite3"
        actual=self.root/"actual.sqlite3"
        p.rename(actual)
        p.symlink_to(actual)
        with self.assertRaises(BackupDenied):
            verify_snapshot(Path(shot["backup_dir"]))

    def test_duplicate_backup_identifier_denied(self):
        identifier="a"*32
        snapshot_sqlite(self.source,self.snaproot,created_epoch=NOW,backup_id=identifier)
        with self.assertRaises(BackupDenied):
            snapshot_sqlite(self.source,self.snaproot,created_epoch=NOW,backup_id=identifier)


if __name__=="__main__":
    unittest.main()
