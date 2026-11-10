"""Wave 13: real closed-operation worker, POSIX enforcement and quota tests.

This tests only a local allowlisted evaluator, not a general container
sandbox, network namespace, production DevSwarm or independent acceptance.
"""
from concurrent.futures import ThreadPoolExecutor
from dataclasses import replace
import hashlib
from pathlib import Path
import tempfile
import threading
import unittest
import uuid

from campaign180.contracts import SCHEMA_TASK,validate_task,ContractError
from campaign180.sandbox_runtime import SandboxDenied,run_allowlisted_task
from campaign180.resource_limits import ResourceLimits,ResourceDenied
from campaign180.quota_ledger import TenantQuotaLedger,QuotaDenied,QuotaReservation
from campaign180.budgeted_runtime import run_budgeted_task

NOW=1799971200
TENANT="tenant_demo"
ACTOR="owner-abc"
SCOPE="project:localdemo"

def auth(value=None,operation="sum_i64",tenant=TENANT,actor=ACTOR,
         expires=NOW+60,capability="sandbox.evaluate",key=None):
    obj={"schema":SCHEMA_TASK,"task_id":str(uuid.uuid4()),
         "tenant_id":tenant,"actor_id":actor,"capability":capability,
         "issued_at":NOW,"expires_at":expires,
         "idempotency_key":key or "local-compute-"+uuid.uuid4().hex,
         "resource_scopes":[SCOPE],
         "body":{"operation":operation,
                 "value":([1,2,3] if value is None else value)}}
    return validate_task(obj,tenant_id=tenant,actor_id=actor,
                         allow_capabilities={capability},
                         allowed_scopes={SCOPE},now=NOW)

class SandboxTests(unittest.TestCase):
    def test_real_worker_integer_sum(self):
        report=run_allowlisted_task(auth(value=[-4,12,20]),expected_tenant=TENANT,
                      expected_actor=ACTOR,scopes={SCOPE},now=NOW)
        self.assertEqual(report["result"],28)
        self.assertTrue(report["resource_limits_enforced"])
        self.assertFalse(report["arbitrary_code_execution"])
        self.assertFalse(report["network_namespace_isolated"])

    def test_sha_utf8_worker(self):
        text="osgard-Проверка"
        sha=run_allowlisted_task(auth(value=text,operation="sha256_text"),
               expected_tenant=TENANT,expected_actor=ACTOR,scopes={SCOPE},now=NOW)
        size=run_allowlisted_task(auth(value=text,operation="utf8_length"),
               expected_tenant=TENANT,expected_actor=ACTOR,scopes={SCOPE},now=NOW)
        self.assertEqual(sha["result"],hashlib.sha256(text.encode()).hexdigest())
        self.assertEqual(size["result"],len(text.encode()))

    def test_rejects_all_code_paths_and_oversized_operands(self):
        for op in ("eval","exec","shell","python","open","urllib","curl","import","read_file"):
            with self.subTest(operation=op),self.assertRaises(SandboxDenied):
                run_allowlisted_task(auth(value="1+1",operation=op),
                    expected_tenant=TENANT,expected_actor=ACTOR,scopes={SCOPE},now=NOW)
        with self.assertRaises(SandboxDenied):
            run_allowlisted_task(auth(value=[1]*65),expected_tenant=TENANT,
                expected_actor=ACTOR,scopes={SCOPE},now=NOW,
                limits=ResourceLimits(max_operations=64))
        with self.assertRaises(SandboxDenied):
            run_allowlisted_task(auth(value="x"*8193,operation="sha256_text"),
                expected_tenant=TENANT,expected_actor=ACTOR,scopes={SCOPE},now=NOW)

    def test_unsafe_integer_rejected_by_contract_before_worker(self):
        # TaskEnvelope has a stricter 53-bit JSON precision bound than
        # the fixed evaluator. Rejection by the first trusted layer is safe.
        with self.assertRaises(ContractError):
            auth(value=[2**63-1,1])
        with self.assertRaises(SandboxDenied):
            run_allowlisted_task(auth(value=[2**53-1,1]),
                expected_tenant=TENANT,expected_actor=ACTOR,scopes={SCOPE},now=NOW)

    def test_rejects_identity_scope_capability_and_modified_envelope(self):
        good=auth()
        for change in (
            {"expected_tenant":"tenant_other"},
            {"expected_actor":"attacker-abc"},
            {"scopes":{"project:wrong"}},
        ):
            options={"expected_tenant":TENANT,"expected_actor":ACTOR,
                     "scopes":{SCOPE},"now":NOW}
            options.update(change)
            with self.subTest(change=change),self.assertRaises(ValueError):
                run_allowlisted_task(good,**options)
        altered={**good,"digest":"0"*64}
        with self.assertRaises(SandboxDenied):
            run_allowlisted_task(altered,expected_tenant=TENANT,
                expected_actor=ACTOR,scopes={SCOPE},now=NOW)
        with self.assertRaises(ValueError):
            run_allowlisted_task(good,expected_tenant=TENANT,
                expected_actor=ACTOR,scopes={SCOPE},now=NOW+100)

    def test_wall_deadline_kills_worker(self):
        with self.assertRaises(SandboxDenied):
            run_allowlisted_task(auth(value=1200,operation="sleep_ms"),
                expected_tenant=TENANT,expected_actor=ACTOR,scopes={SCOPE},
                now=NOW,limits=ResourceLimits(wall_ms=300))

    def test_limit_validation_fail_closed(self):
        for lim in (ResourceLimits(memory_mb=0),ResourceLimits(cpu_seconds=9),
                    ResourceLimits(wall_ms=100),ResourceLimits(input_bytes=99999),
                    ResourceLimits(disk_bytes=1),ResourceLimits(network_bytes=1),
                    ResourceLimits(max_operations=0)):
            with self.subTest(limits=lim),self.assertRaises(ResourceDenied):
                lim.checked()

class QuotaTests(unittest.TestCase):
    def setUp(self):
        tmp=tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.db=str(Path(tmp.name)/"quota.sqlite3")
        self.ledger=TenantQuotaLedger(self.db)
        self.ledger.configure(tenant=TENANT,capacity=10)

    def test_exact_capacity_spend_without_replay(self):
        reservation=self.ledger.reserve(tenant=TENANT,job_key="example-idempotency-1",
                           units=7,now=NOW)
        self.assertEqual(self.ledger.balance(tenant=TENANT)["remaining"],3)
        result=hashlib.sha256(b"accepted").hexdigest()
        self.assertEqual(self.ledger.commit(reservation,now=NOW+1,result_sha256=result),"COMMITTED")
        self.assertEqual(self.ledger.commit(reservation,now=NOW+1,result_sha256=result),
                         "COMPLETED_ALREADY_NO_EFFECT")
        self.assertEqual(self.ledger.balance(tenant=TENANT),
              {"capacity":10,"spent":7,"held":0,"remaining":3})
        with self.assertRaises(QuotaDenied):
            self.ledger.reserve(tenant=TENANT,job_key=reservation.job_key,
                               units=7,now=NOW+2)

    def test_concurrent_same_tenant_cannot_exceed_budget(self):
        self.ledger.configure(tenant="second_tenant",capacity=2)
        def reserve(i):
            try:
                return self.ledger.reserve(tenant=TENANT,
                    job_key=f"concurrent-local-{i:03d}",units=2,now=NOW)
            except QuotaDenied:
                return None
        with ThreadPoolExecutor(max_workers=12) as pool:
            res=[x for x in pool.map(reserve,range(30)) if x]
        self.assertEqual(len(res),5)
        self.assertEqual(len({x.token for x in res}),5)
        self.assertEqual(self.ledger.balance(tenant=TENANT)["held"],10)
        self.assertEqual(self.ledger.balance(tenant="second_tenant")["remaining"],2)

    def test_dead_worker_lease_expiry_reclaims_held_capacity_once(self):
        lease=self.ledger.reserve(tenant=TENANT,job_key="expired-local-worker-12",
                                  units=9,now=NOW,ttl_seconds=2)
        self.assertEqual(self.ledger.reclaim_expired(now=NOW+2),1)
        self.assertEqual(self.ledger.reclaim_expired(now=NOW+3),0)
        self.assertEqual(self.ledger.balance(tenant=TENANT)["remaining"],10)
        with self.assertRaises(QuotaDenied):
            self.ledger.commit(lease,now=NOW+4,result_sha256="a"*64)
        with self.assertRaises(QuotaDenied):
            self.ledger.reserve(tenant=TENANT,job_key=lease.job_key,units=1,now=NOW+5)

    def test_forged_token_stale_result_and_double_cancel_denied(self):
        lease=self.ledger.reserve(tenant=TENANT,job_key="secure-lease-local-1",
                                  units=3,now=NOW)
        wrong=replace(lease,token="0"*64)
        with self.assertRaises(QuotaDenied):
            self.ledger.commit(wrong,now=NOW+1,result_sha256="a"*64)
        self.assertEqual(self.ledger.cancel(lease),"CANCELLED")
        self.assertEqual(self.ledger.cancel(lease),"CANCELLED_ALREADY")
        with self.assertRaises(QuotaDenied):
            self.ledger.commit(lease,now=NOW+1,result_sha256="a"*64)
        self.assertEqual(self.ledger.balance(tenant=TENANT)["remaining"],10)

    def test_spend_is_scoped_per_tenant_and_reconfigure_denied(self):
        self.ledger.configure(tenant="second_tenant",capacity=4)
        lease=self.ledger.reserve(tenant="second_tenant",job_key="tenant-b-job-valid",
                                  units=3,now=NOW)
        self.ledger.commit(lease,now=NOW+1,result_sha256="b"*64)
        self.assertEqual(self.ledger.balance(tenant=TENANT)["spent"],0)
        self.assertEqual(self.ledger.balance(tenant="second_tenant")["spent"],3)
        with self.assertRaises(QuotaDenied):
            self.ledger.configure(tenant="second_tenant",capacity=400)

    def test_real_worker_budget_charged_once(self):
        result=run_budgeted_task(auth(value=[7,8,9]),expected_tenant=TENANT,
            expected_actor=ACTOR,scopes={SCOPE},now=NOW,
            ledger=self.ledger,units=4)
        self.assertEqual(result["result"],24)
        self.assertEqual(result["quota_state"],"COMMITTED")
        self.assertEqual(self.ledger.balance(tenant=TENANT)["spent"],4)
        self.assertEqual(self.ledger.balance(tenant=TENANT)["held"],0)

    def test_worker_timeout_refunds_reservation(self):
        with self.assertRaises(SandboxDenied):
            run_budgeted_task(auth(value=1000,operation="sleep_ms"),
                expected_tenant=TENANT,expected_actor=ACTOR,scopes={SCOPE},
                now=NOW,ledger=self.ledger,units=5,
                limits=ResourceLimits(wall_ms=250))
        self.assertEqual(self.ledger.balance(tenant=TENANT)["spent"],0)
        self.assertEqual(self.ledger.balance(tenant=TENANT)["held"],0)

    def test_invalid_auth_does_not_consume_budget(self):
        with self.assertRaises(ValueError):
            run_budgeted_task(auth(),expected_tenant="tenant_wrong",
                expected_actor=ACTOR,scopes={SCOPE},now=NOW,
                ledger=self.ledger,units=3)
        self.assertEqual(self.ledger.balance(tenant=TENANT)["remaining"],10)

if __name__=="__main__":
    unittest.main()
