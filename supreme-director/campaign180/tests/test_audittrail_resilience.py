"""TITAN-X27/X29: tenant audit chain, concurrency, synthetic crash recovery."""
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
import sqlite3
import tempfile
import unittest
import uuid
from campaign180.audittrail import LocalAuditTrail,AuditDenied
from campaign180.resilience import exercise_chaos,ResilienceDenied

NOW=1799971200
TENANT="tenant_alpha"
ACTOR="owner-abc"
TRACE=str(uuid.uuid4())

def audit_event(trail,tenant=TENANT,code="LEASED"):
    return trail.append(tenant=tenant,actor=ACTOR,trace_id=TRACE,
        task_id=TRACE,at_epoch=NOW,event="LOCAL_LEASE_CREATED",code=code,
        fields={"fence":1,"attempt":1})

class AuditTrailTests(unittest.TestCase):
    def setUp(self):
        t=tempfile.TemporaryDirectory()
        self.addCleanup(t.cleanup)
        self.path=Path(t.name)/"audit.sqlite3"
        self.trail=LocalAuditTrail(self.path)

    def test_valid_chain_and_independent_expected_checkpoint(self):
        first=audit_event(self.trail)
        second=audit_event(self.trail)
        self.assertEqual((first["sequence"],second["sequence"]),(1,2))
        checked=self.trail.verify(TENANT,expected_head=second["checkpoint_hash"])
        self.assertTrue(checked["checkpoint_matches"])
        self.assertEqual(checked["events"],2)
        self.assertFalse(checked["externally_witnessed"])

    def test_two_tenants_are_separate(self):
        audit_event(self.trail)
        audit_event(self.trail,tenant="tenant_beta")
        self.assertEqual(self.trail.verify(TENANT)["events"],1)
        self.assertEqual(self.trail.verify("tenant_beta")["events"],1)
        with self.assertRaises(AuditDenied):
            self.trail.verify("tenant_unsafe!")

    def test_no_freeform_secrets_or_messages(self):
        for fields in ({"private_key":"value"},{"duration_ms":"secret"},
                       {"attempt":-1},{"attempt":2**53}):
            with self.subTest(fields=fields),self.assertRaises(AuditDenied):
                self.trail.append(tenant=TENANT,actor=ACTOR,trace_id=TRACE,
                    task_id=TRACE,at_epoch=NOW,event="CRASH_INJECTED",
                    code="SIMULATED",fields=fields)

    def test_immutable_sqlite_triggers_block_raw_update_and_delete(self):
        audit_event(self.trail)
        for query in ("UPDATE local_audit_events SET event_hash='forged'",
                      "DELETE FROM local_audit_events"):
            with self.subTest(query=query),self.assertRaises(sqlite3.IntegrityError):
                with sqlite3.connect(self.path) as db:db.execute(query)

    def test_database_admin_tamper_detected(self):
        audit_event(self.trail)
        with sqlite3.connect(self.path) as db:
            db.execute("DROP TRIGGER local_audit_no_update")
            db.execute("UPDATE local_audit_events SET event_hash=? WHERE tenant=?",
                       ("0"*64,TENANT))
        with self.assertRaises(AuditDenied):
            self.trail.verify(TENANT)

    def test_outside_expected_head_detects_truncation(self):
        before=audit_event(self.trail)["checkpoint_hash"]
        audit_event(self.trail)
        with self.assertRaises(AuditDenied):
            self.trail.verify(TENANT,expected_head=before)

    def test_concurrent_sequence_no_duplicate(self):
        with ThreadPoolExecutor(max_workers=8) as pool:
            events=list(pool.map(lambda _:audit_event(self.trail),range(36)))
        self.assertEqual(len({e["sequence"] for e in events}),36)
        self.assertEqual(self.trail.verify(TENANT)["events"],36)

    def test_actor_uuid_and_event_allowlist_enforced(self):
        with self.assertRaises(AuditDenied):
            self.trail.append(tenant=TENANT,actor="bad actor",trace_id=TRACE,
                task_id=TRACE,at_epoch=NOW,event="LOCAL_LEASE_CREATED",
                code="OK_CODE",fields={})
        with self.assertRaises(AuditDenied):
            self.trail.append(tenant=TENANT,actor=ACTOR,trace_id=TRACE,
                task_id=TRACE,at_epoch=NOW,event="DELETE_ALL",
                code="BAD_EVENT",fields={})

class ResilienceTests(unittest.TestCase):
    def test_faults_recover_and_integrity_checks_pass(self):
        result=exercise_chaos(tasks_per_tenant=8)
        self.assertEqual(result["synthetic_tasks_finished"],17)
        self.assertEqual(result["crashes_injected"],4)
        self.assertEqual(result["leases_recovered"],4)
        self.assertEqual(result["concurrent_winners"],1)
        self.assertTrue(result["corrupt_payload_rejected"])
        self.assertTrue(result["restore_drill_passed"])
        self.assertTrue(result["audit_chain_verified"])
        self.assertFalse(result["real_chaos_tested"])
        self.assertEqual(result["external_side_effects"],0)

    def test_smallest_fixture_remains_reproducible(self):
        a=exercise_chaos(tasks_per_tenant=4)
        b=exercise_chaos(tasks_per_tenant=4)
        for field in ("crashes_injected","leases_recovered","synthetic_tasks_finished",
                      "concurrent_winners","corrupt_payload_rejected"):
            self.assertEqual(a[field],b[field])

    def test_invalid_or_excessive_task_count_denied(self):
        for tasks in (0,2,65,1.5,True):
            with self.subTest(tasks=tasks),self.assertRaises(ResilienceDenied):
                exercise_chaos(tasks_per_tenant=tasks)

if __name__=="__main__":
    unittest.main()
