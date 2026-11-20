"""Wave15: kernel-sealed reviewed worker, immutable compute transitions,
cross-process replay races, journal/receipt corruption and optional host OCI
readiness. Real processes execute ONLY safe static arithmetic on fake data.
"""
from concurrent.futures import ProcessPoolExecutor
from hashlib import sha256
from pathlib import Path
from unittest.mock import patch
import copy
import fcntl
import json
import multiprocessing
import os
import secrets
import sqlite3
import tempfile
import unittest
import uuid

from campaign180.contracts import SCHEMA_TASK,validate_task
from campaign180.local_permits import LocalPermitAuthority
from campaign180.quota_ledger import TenantQuotaLedger
from campaign180.fenced_compute import LocalFencedExecutor,ExecutionDenied
from campaign180.compute_events import ComputeEventDenied
from campaign180.compute_evidence import LocalComputeEvidence,EvidenceDenied
from campaign180.sealed_worker import (
    PINNED_WORKER_SHA256,source_bytes,sealed_worker_fd,WorkerImageDenied,
)
from campaign180.sandbox_runtime import (
    run_allowlisted_task,SandboxDenied,_SCRIPT,
)
from campaign180.oci_host_attestation import (
    LocalRootlessHostAudit,HostProbePolicy,HostProbeDenied,
    check_kernel_report,SCHEMA as HOST_SCHEMA,
)
from campaign180.resource_limits import ResourceLimits

NOW=1799971200
TENANT="tenant_demo"
ACTOR="owner-abc"
SCOPES={"project:localdemo"}
IMAGE="registry.example.org/probe@sha256:"+("b"*64)

def authorization(*,operation="sum_i64",value=None,job=None):
    task={"schema":SCHEMA_TASK,"task_id":str(uuid.uuid4()),
          "tenant_id":TENANT,"actor_id":ACTOR,"capability":"sandbox.evaluate",
          "issued_at":NOW,"expires_at":NOW+70,
          "idempotency_key":job or "wave15-key-"+uuid.uuid4().hex,
          "resource_scopes":sorted(SCOPES),
          "body":{"operation":operation,"value":[1,8,9] if value is None else value}}
    return validate_task(task,tenant_id=TENANT,actor_id=ACTOR,
        allow_capabilities={"sandbox.evaluate"},allowed_scopes=SCOPES,now=NOW)

def _process_race(db,secret,auth,permit):
    """Spawn-compatible worker: each process opens its own SQLite handles."""
    q=TenantQuotaLedger(db)
    runner=LocalFencedExecutor(q,LocalPermitAuthority(secret))
    try:
        result=runner.run(auth,permit,expected_tenant=TENANT,
            expected_actor=ACTOR,scopes=SCOPES,now=NOW)
        return ("success",result["result"])
    except ExecutionDenied:
        return ("denied",None)

class ComputeTransitionTests(unittest.TestCase):
    def setUp(self):
        temp=tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.folder=Path(temp.name)
        self.path=str(self.folder/"compute.sqlite3")
        self.ledger=TenantQuotaLedger(self.path)
        self.ledger.configure(tenant=TENANT,capacity=20)
        self.secret=secrets.token_bytes(32)
        self.signer=LocalPermitAuthority(self.secret)
        self.runner=LocalFencedExecutor(self.ledger,self.signer)
        self.evidence=LocalComputeEvidence(self.ledger,secret=secrets.token_bytes(32))

    def permit(self,auth,units=2,ttl=20):
        return self.signer.issue(auth,tenant=TENANT,actor=ACTOR,
            scopes=SCOPES,now=NOW,units=units,ttl_seconds=ttl)

    def execute(self,auth,permit):
        return self.runner.run(auth,permit,expected_tenant=TENANT,
            expected_actor=ACTOR,scopes=SCOPES,now=NOW)

    def test_success_appends_reservation_and_terminal_event_in_one_ledger(self):
        auth=authorization()
        out=self.execute(auth,self.permit(auth,units=3))
        self.assertEqual(out["result"],18)
        history=self.runner.events.verify(tenant=TENANT)
        self.assertEqual(history["events"],2)
        self.assertTrue(history["receipt_reconciled"])
        evidence=self.evidence.attest(tenant=TENANT,at_epoch=NOW)
        self.assertEqual(evidence["payload"]["compute_event_head"],history["head_hash"])
        self.assertEqual(evidence["payload"]["compute_event_count"],2)
        self.assertTrue(self.evidence.verify(evidence,tenant=TENANT)["hmac_valid"])
        self.assertEqual(self.ledger.balance(tenant=TENANT)["spent"],3)

    def test_error_refunds_but_has_failed_terminal_event_and_no_replay(self):
        auth=authorization(operation="sleep_ms",value=1000)
        permit=self.permit(auth)
        with self.assertRaises(ExecutionDenied):
            self.runner.run(auth,permit,expected_tenant=TENANT,
                expected_actor=ACTOR,scopes=SCOPES,now=NOW,
                limits=ResourceLimits(wall_ms=250))
        self.assertEqual(self.ledger.balance(tenant=TENANT)["remaining"],20)
        self.assertEqual(self.runner.events.verify(tenant=TENANT)["events"],2)
        self.assertEqual(self.runner.inspect(tenant=TENANT,
            job_key=auth["task"]["idempotency_key"])["state"],"failed")
        with self.assertRaises(ExecutionDenied):self.execute(auth,permit)

    def test_fixed_lease_cannot_be_reclaimed_through_generic_quota_api(self):
        auth=authorization()
        permit=self.permit(auth,ttl=2)
        task,signed=self.runner._prepare(authorization=auth,permit=permit,
            tenant=TENANT,actor=ACTOR,scopes=SCOPES,now=NOW,
            limits=ResourceLimits().checked())
        self.assertEqual(self.runner.events.verify(tenant=TENANT)["events"],1)
        self.assertEqual(self.ledger.reclaim_expired(now=NOW+2),0)
        self.assertEqual(self.ledger.balance(tenant=TENANT)["held"],2)
        self.assertEqual(self.runner.reclaim(now=NOW+2)["leases_reclaimed"],1)
        self.assertEqual(self.runner.events.verify(tenant=TENANT)["events"],2)
        self.assertEqual(self.ledger.balance(tenant=TENANT)["held"],0)
        self.assertEqual(self.runner.inspect(tenant=TENANT,
            job_key=task["idempotency_key"])["state"],"expired")
        with self.assertRaises(ExecutionDenied):
            self.runner._settle(task=task,signed=signed,tenant=TENANT,
                 now=NOW+2,result_sha256="a"*64,error_code=None)

    def test_event_chain_immutable_trigger_and_database_admin_tampering_detected(self):
        auth=authorization()
        self.execute(auth,self.permit(auth))
        with sqlite3.connect(self.path) as db:
            with self.assertRaises(sqlite3.DatabaseError):
                db.execute("""DELETE FROM local_fixed_compute_events
                    WHERE tenant=?""",(TENANT,))
            db.execute("DROP TRIGGER local_fixed_compute_events_no_update")
            db.execute("""UPDATE local_fixed_compute_events SET units=units+1
                WHERE tenant=? AND seq=1""",(TENANT,))
        with self.assertRaises(ComputeEventDenied):
            self.runner.events.verify(tenant=TENANT)
        with self.assertRaises(ComputeEventDenied):
            self.evidence.snapshot(tenant=TENANT)

    def test_deleted_event_detected_even_if_next_event_remains(self):
        auth=authorization()
        self.execute(auth,self.permit(auth))
        with sqlite3.connect(self.path) as db:
            db.execute("DROP TRIGGER local_fixed_compute_events_no_delete")
            db.execute("""DELETE FROM local_fixed_compute_events
                WHERE tenant=? AND seq=1""",(TENANT,))
        with self.assertRaises(ComputeEventDenied):
            self.runner.events.verify(tenant=TENANT)

    def test_receipt_modified_with_valid_chain_is_still_denied(self):
        auth=authorization()
        self.execute(auth,self.permit(auth))
        with sqlite3.connect(self.path) as db:
            db.execute("""UPDATE local_fixed_execution_receipts SET state='failed'
                WHERE tenant=?""",(TENANT,))
        with self.assertRaises(ComputeEventDenied):
            self.runner.events.verify(tenant=TENANT)

    def test_old_checkpoint_cannot_attest_new_compute_state(self):
        auth=authorization()
        self.execute(auth,self.permit(auth))
        old=self.evidence.attest(tenant=TENANT,at_epoch=NOW)
        newauth=authorization()
        self.execute(newauth,self.permit(newauth))
        with self.assertRaises(EvidenceDenied):
            self.evidence.verify(old,tenant=TENANT)
        refreshed=self.evidence.attest(tenant=TENANT,at_epoch=NOW+1)
        self.assertEqual(refreshed["payload"]["compute_event_count"],4)
        self.assertTrue(self.evidence.verify(refreshed,tenant=TENANT)["hmac_valid"])

    def test_cross_process_same_permit_is_consumed_once(self):
        auth=authorization(job="wave15-cross-process-one-job")
        permit=self.permit(auth,units=4)
        context=multiprocessing.get_context("spawn")
        with ProcessPoolExecutor(max_workers=3,mp_context=context) as pool:
            futures=[pool.submit(_process_race,self.path,self.secret,auth,permit)
                     for _ in range(3)]
            result=[f.result(timeout=25) for f in futures]
        self.assertEqual(sum(x[0]=="success" for x in result),1)
        self.assertEqual(sum(x[0]=="denied" for x in result),2)
        self.assertEqual(self.ledger.balance(tenant=TENANT)["spent"],4)
        self.assertEqual(self.runner.events.verify(tenant=TENANT)["events"],2)

    def test_invalid_cross_tenant_permit_never_touches_balance(self):
        auth=authorization()
        permit=self.permit(auth)
        with self.assertRaises(ValueError):
            self.runner.run(auth,permit,expected_tenant="foreign_tenant",
                 expected_actor=ACTOR,scopes=SCOPES,now=NOW)
        self.assertEqual(self.ledger.balance(tenant=TENANT)["held"],0)
        self.assertEqual(self.runner.events.verify(tenant=TENANT)["events"],0)

class SealedWorkerTests(unittest.TestCase):
    def test_actual_checked_out_worker_byte_hash_matches_reviewed_pin(self):
        data=source_bytes(_SCRIPT)
        self.assertEqual(sha256(data).hexdigest(),PINNED_WORKER_SHA256)

    def test_sealed_memfd_rejects_write_and_shrink(self):
        with sealed_worker_fd(_SCRIPT) as fd:
            marks=fcntl.fcntl(fd,fcntl.F_GET_SEALS)
            self.assertTrue(marks&fcntl.F_SEAL_WRITE)
            self.assertTrue(marks&fcntl.F_SEAL_SHRINK)
            self.assertTrue(marks&fcntl.F_SEAL_GROW)
            with self.assertRaises(OSError):os.write(fd,b"import os")
            with self.assertRaises(OSError):os.ftruncate(fd,1)

    def test_changed_worker_and_symlink_cannot_execute(self):
        with tempfile.TemporaryDirectory() as temp:
            tampered=Path(temp)/"worker.py"
            tampered.write_bytes(_SCRIPT.read_bytes()+b"\nprint('unreviewed')\n")
            tampered.chmod(0o600)
            with self.assertRaises(WorkerImageDenied):source_bytes(tampered)
            alias=Path(temp)/"alias.py"
            alias.symlink_to(_SCRIPT)
            with self.assertRaises(WorkerImageDenied):source_bytes(alias)
            auth=authorization()
            with patch("campaign180.sandbox_runtime._SCRIPT",tampered),patch(
                  "campaign180.sandbox_runtime.subprocess.Popen") as popen:
                with self.assertRaises(SandboxDenied):
                    run_allowlisted_task(auth,expected_tenant=TENANT,
                        expected_actor=ACTOR,scopes=SCOPES,now=NOW)
                popen.assert_not_called()

    def test_still_executes_real_reviewed_worker_without_writable_script(self):
        auth=authorization(operation="utf8_length",value="Исследование")
        report=run_allowlisted_task(auth,expected_tenant=TENANT,
           expected_actor=ACTOR,scopes=SCOPES,now=NOW)
        self.assertEqual(report["result"],len("Исследование".encode("utf-8")))
        self.assertFalse(report["arbitrary_code_execution"])

class HostProbeTests(unittest.TestCase):
    def setUp(self):
        self.policy=HostProbePolicy(image=IMAGE)
        self.host={"net":"net:[12001]","pid":"pid:[12002]",
                   "user":"user:[12003]"}
        self.report={
            "schema":HOST_SCHEMA,"uid":65534,
            "namespaces":{"net":"net:[22001]","pid":"pid:[22002]",
                          "user":"user:[22003]"},
            "root_mount_options":"ro,relatime",
            "cap_eff":"0000000000000000","no_new_privs":"1","seccomp":"2",
            "memory_max":str(128*1024*1024),"pids_max":"12",
            "cpu_max":"50000 100000"}

    def test_pure_kernel_verifier_accepts_only_a_complete_plausible_report(self):
        result=check_kernel_report(self.report,policy=self.policy,host_ns=self.host)
        self.assertTrue(result["cgroups_v2_limits_observed"])
        self.assertFalse(result["production_authorized"])
        self.assertFalse(result["independently_accepted"])

    def test_kernel_constraints_are_all_fail_closed(self):
        changes=[
            ("uid",0),("root_mount_options","rw,relatime"),
            ("cap_eff","0000000000000001"),("no_new_privs","0"),
            ("seccomp","0"),("memory_max","max"),
            ("pids_max","128"),("cpu_max","max 100000"),
        ]
        for field,value in changes:
            modified=copy.deepcopy(self.report)
            modified[field]=value
            with self.subTest(field=field),self.assertRaises(HostProbeDenied):
                check_kernel_report(modified,policy=self.policy,host_ns=self.host)
        changed=copy.deepcopy(self.report)
        changed["namespaces"]["net"]=self.host["net"]
        with self.assertRaises(HostProbeDenied):
            check_kernel_report(changed,policy=self.policy,host_ns=self.host)

    def test_host_execution_is_disabled_without_both_explicit_flags(self):
        runner=LocalRootlessHostAudit(self.policy,allow_local_execution=False)
        with patch("campaign180.oci_host_attestation.shutil.which") as tool:
            with self.assertRaises(HostProbeDenied):runner.audit()
            tool.assert_not_called()
        active=LocalRootlessHostAudit(self.policy,allow_local_execution=True)
        with patch.dict(os.environ,{"OSGARD_EXPLICIT_LOCAL_SANDBOX":"1",
                 "OSGARD_EXPLICIT_OCI_HOST_PROBE":"0"}),patch(
                 "campaign180.oci_host_attestation.shutil.which") as tool:
            with self.assertRaises(HostProbeDenied):active.audit()
            tool.assert_not_called()

    def test_unpinned_host_probe_image_denied_even_in_plan(self):
        with self.assertRaises(ValueError):
            HostProbePolicy(image="docker.io/probe:latest").checked()

if __name__=="__main__":
    unittest.main()
