"""Wave14: signed short-lived local permits, durable quota/receipt state,
offline HMAC checkpoints, and strict rootless OCI admission.

Real subprocess execution is exercised; OCI invocation remains mocked
unless an explicitly provisioned rootless Linux test host is available.
"""
from concurrent.futures import ThreadPoolExecutor
from dataclasses import replace
import copy
from hashlib import sha256
import json
from pathlib import Path
import secrets
import sqlite3
import tempfile
import unittest
from unittest.mock import patch
import uuid

from campaign180.contracts import SCHEMA_TASK,validate_task
from campaign180.local_permits import LocalPermitAuthority,PermitDenied
from campaign180.fenced_compute import LocalFencedExecutor,ExecutionDenied
from campaign180.quota_ledger import TenantQuotaLedger,QuotaDenied
from campaign180.compute_evidence import LocalComputeEvidence,EvidenceDenied
from campaign180.resource_limits import ResourceLimits
from campaign180.oci_gate import LocalOciGate,OciGateDenied
from campaign180.sandbox import RootlessSandbox,SandboxPolicy,SandboxDenied
from campaign180.gateway import TransactionalLocalGateway
from campaign180.scheduler import CapacityScheduler,ResourceCost

NOW=1799971200
TENANT="tenant_demo"
ACTOR="owner-abc"
SCOPE="project:localdemo"
IMAGE="registry.example.org/worker@sha256:"+("a"*64)

def envelope(*,value=None,operation="sum_i64",tenant=TENANT,actor=ACTOR,
             key=None,expires=NOW+60,capability="sandbox.evaluate"):
    task={"schema":SCHEMA_TASK,"task_id":str(uuid.uuid4()),
          "tenant_id":tenant,"actor_id":actor,"capability":capability,
          "issued_at":NOW,"expires_at":expires,
          "idempotency_key":key or "wave14-job-"+uuid.uuid4().hex,
          "resource_scopes":[SCOPE],
          "body":{"operation":operation,
                  "value":[4,5,6] if value is None else value}}
    return validate_task(task,tenant_id=tenant,actor_id=actor,
        allow_capabilities={capability},allowed_scopes={SCOPE},now=NOW)

class PermitAndExecutionTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.path=Path(self.temp.name)/"compute.sqlite3"
        self.ledger=TenantQuotaLedger(self.path)
        self.ledger.configure(tenant=TENANT,capacity=20)
        self.signer=LocalPermitAuthority(secrets.token_bytes(32))
        self.audit=LocalComputeEvidence(self.ledger,secret=secrets.token_bytes(32))
        self.runner=LocalFencedExecutor(self.ledger,self.signer)

    def permit(self,auth,*,units=2,ttl_seconds=30):
        return self.signer.issue(auth,tenant=TENANT,actor=ACTOR,
            scopes={SCOPE},now=NOW,units=units,ttl_seconds=ttl_seconds)

    def execute(self,auth,permit,**kwargs):
        return self.runner.run(auth,permit,expected_tenant=TENANT,
            expected_actor=ACTOR,scopes={SCOPE},now=NOW,**kwargs)

    def test_real_signed_worker_charges_once_and_returns_receipt_metadata(self):
        auth=envelope(value=[1,3,7])
        permit=self.permit(auth,units=3)
        self.assertEqual(self.signer.verify(permit,auth,tenant=TENANT,
                actor=ACTOR,scopes={SCOPE},now=NOW)["units"],3)
        out=self.execute(auth,permit)
        self.assertEqual(out["result"],11)
        self.assertEqual(out["receipt_state"],"completed")
        self.assertEqual(out["quota_units_charged"],3)
        self.assertFalse(out["permit_replay_allowed"])
        self.assertFalse(out["external_side_effects_authorized"])
        self.assertEqual(self.ledger.balance(tenant=TENANT)["spent"],3)
        self.assertEqual(self.ledger.balance(tenant=TENANT)["held"],0)
        meta=self.runner.inspect(tenant=TENANT,job_key=auth["task"]["idempotency_key"])
        self.assertEqual(meta["state"],"completed")
        self.assertIsNone(meta["result_payload"])
        self.assertEqual(len(meta["result_sha256"]),64)
        with self.assertRaises(ExecutionDenied):
            self.execute(auth,permit)
        self.assertEqual(self.ledger.balance(tenant=TENANT)["spent"],3)

    def test_signed_permit_rejects_tampered_cost_identity_nonce_and_signature(self):
        auth=envelope()
        permit=self.permit(auth)
        changes=[
            ("units",9),("tenant_id","tenant_other"),
            ("actor_id","attacker-abc"),("nonce","0"*32),
            ("task_sha256","0"*64),("capability","arbitrary.execute"),
            ("scopes",["project:wrong"]),("expires_at",NOW+80),
            ("external_execution_authorized",True)
        ]
        for field,new in changes:
            p=copy.deepcopy(permit)
            p["payload"][field]=new
            with self.subTest(field=field),self.assertRaises(PermitDenied):
                self.signer.verify(p,auth,tenant=TENANT,actor=ACTOR,
                    scopes={SCOPE},now=NOW)
        self.assertEqual(self.ledger.balance(tenant=TENANT)["spent"],0)

    def test_expired_and_wrong_key_permit_never_reserves_budget(self):
        auth=envelope()
        permit=self.permit(auth,ttl_seconds=2)
        with self.assertRaises(PermitDenied):
            self.signer.verify(permit,auth,tenant=TENANT,actor=ACTOR,
                scopes={SCOPE},now=NOW+2)
        other=LocalPermitAuthority(secrets.token_bytes(32))
        with self.assertRaises(PermitDenied):
            other.verify(permit,auth,tenant=TENANT,actor=ACTOR,scopes={SCOPE},now=NOW)
        with self.assertRaises(PermitDenied):
            self.runner.run(auth,permit,expected_tenant="tenant_other",
                expected_actor=ACTOR,scopes={SCOPE},now=NOW)
        self.assertEqual(self.ledger.balance(tenant=TENANT)["remaining"],20)

    def test_same_task_with_new_signed_nonce_is_not_replayed(self):
        auth=envelope()
        self.execute(auth,self.permit(auth))
        next_permit=self.permit(auth,units=3)
        with self.assertRaises(ExecutionDenied):
            self.execute(auth,next_permit)
        self.assertEqual(self.ledger.balance(tenant=TENANT)["spent"],2)

    def test_same_key_in_new_task_still_refuses_quota_spend(self):
        first=envelope(key="wave14-idempotent-immutable")
        self.execute(first,self.permit(first))
        second=envelope(key="wave14-idempotent-immutable")
        with self.assertRaises(ExecutionDenied):
            self.execute(second,self.permit(second))
        self.assertEqual(self.ledger.balance(tenant=TENANT)["spent"],2)

    def test_concurrent_same_permit_has_one_accepted_effect(self):
        auth=envelope(value=[1,2,8])
        permit=self.permit(auth)
        def attempt(_):
            try:return self.execute(auth,permit)
            except ExecutionDenied:return None
        with ThreadPoolExecutor(max_workers=3) as pool:
            result=list(pool.map(attempt,range(3)))
        self.assertEqual(sum(x is not None for x in result),1)
        self.assertEqual(self.ledger.balance(tenant=TENANT)["spent"],2)
        self.assertEqual(self.ledger.balance(tenant=TENANT)["held"],0)

    def test_wall_time_denied_refunds_but_does_not_restore_permit(self):
        auth=envelope(value=1300,operation="sleep_ms")
        permit=self.permit(auth)
        with self.assertRaises(ExecutionDenied):
            self.execute(auth,permit,limits=ResourceLimits(wall_ms=250))
        self.assertEqual(self.ledger.balance(tenant=TENANT)["remaining"],20)
        state=self.runner.inspect(tenant=TENANT,job_key=auth["task"]["idempotency_key"])
        self.assertEqual(state["state"],"failed")
        with self.assertRaises(ExecutionDenied):
            self.execute(auth,permit)

    def test_crash_after_prepare_expires_without_double_charge(self):
        auth=envelope()
        permit=self.permit(auth,ttl_seconds=2)
        limits=ResourceLimits().checked()
        task,signed=self.runner._prepare(authorization=auth,permit=permit,
            tenant=TENANT,actor=ACTOR,scopes={SCOPE},now=NOW,limits=limits)
        self.assertEqual(self.ledger.balance(tenant=TENANT)["held"],2)
        out=self.runner.reclaim(now=NOW+2)
        self.assertEqual(out["leases_reclaimed"],1)
        self.assertEqual(self.runner.inspect(
            tenant=TENANT,job_key=task["idempotency_key"])["state"],"expired")
        self.assertEqual(self.ledger.balance(tenant=TENANT)["remaining"],20)
        with self.assertRaises(ExecutionDenied):
            self.execute(auth,permit)
        with self.assertRaises(ExecutionDenied):
            self.runner._settle(task=task,signed=signed,tenant=TENANT,
                now=NOW+2,result_sha256="a"*64,error_code=None)

    def test_budget_exhaustion_prevents_execution_and_receipt(self):
        self.ledger.configure(tenant="other_tenant",capacity=2)
        auth=envelope()
        with self.assertRaises(ExecutionDenied):
            self.execute(auth,self.permit(auth,units=25))
        self.assertEqual(self.ledger.balance(tenant=TENANT)["remaining"],20)
        self.assertEqual(self.ledger.balance(tenant="other_tenant")["remaining"],2)

    def test_attestation_and_external_write_once_checkpoint(self):
        auth=envelope(value="размер",operation="utf8_length")
        self.execute(auth,self.permit(auth))
        report=self.audit.snapshot(tenant=TENANT)
        self.assertEqual(report["receipt_count"],1)
        self.assertEqual(report["lease_count"],1)
        self.assertEqual(report["spent"],2)
        checkpoint=self.audit.attest(tenant=TENANT,at_epoch=NOW)
        self.assertTrue(self.audit.verify(checkpoint,tenant=TENANT)["hmac_valid"])
        location=Path(self.temp.name)/"sealed.json"
        self.audit.write_once(checkpoint,path=location,tenant=TENANT)
        self.assertTrue(self.audit.verify_file(location,tenant=TENANT)["hmac_valid"])
        with self.assertRaises(EvidenceDenied):
            self.audit.write_once(checkpoint,path=location,tenant=TENANT)
        self.assertNotIn(b"wave14-job-",location.read_bytes())
        self.assertNotIn(b"secret",location.read_bytes())

    def test_checkpoint_signature_edit_and_state_change_denied(self):
        auth=envelope()
        self.execute(auth,self.permit(auth))
        checkpoint=self.audit.attest(tenant=TENANT,at_epoch=NOW)
        forged=copy.deepcopy(checkpoint)
        forged["payload"]["spent"]=999
        with self.assertRaises(EvidenceDenied):
            self.audit.verify(forged,tenant=TENANT)
        with sqlite3.connect(self.path) as db:
            db.execute("""UPDATE local_compute_quotas SET spent=spent+1
                WHERE tenant=?""",(TENANT,))
        with self.assertRaises(EvidenceDenied):
            self.audit.verify(checkpoint,tenant=TENANT)

    def test_receipt_lease_inconsistency_denied_by_attestation(self):
        auth=envelope()
        self.execute(auth,self.permit(auth))
        with sqlite3.connect(self.path) as db:
            db.execute("""UPDATE local_fixed_execution_receipts
                SET state='failed' WHERE tenant=?""",(TENANT,))
        with self.assertRaises(EvidenceDenied):
            self.audit.snapshot(tenant=TENANT)

    def test_checkpoint_private_file_canonical_and_symlink_rejection(self):
        auth=envelope()
        self.execute(auth,self.permit(auth))
        checkpoint=self.audit.attest(tenant=TENANT,at_epoch=NOW)
        location=Path(self.temp.name)/"checkpoint.json"
        self.audit.write_once(checkpoint,path=location,tenant=TENANT)
        alias=Path(self.temp.name)/"checkpoint-alias.json"
        alias.symlink_to(location)
        with self.assertRaises(EvidenceDenied):
            self.audit.verify_file(alias,tenant=TENANT)
        location.write_bytes(location.read_bytes()+b" ")
        with self.assertRaises(EvidenceDenied):
            self.audit.verify_file(location,tenant=TENANT)

class OciGateTests(unittest.TestCase):
    def setUp(self):
        temp=tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        gw=TransactionalLocalGateway(Path(temp.name)/"gateway.sqlite3",
                {"operator":{"task.preview"}})
        gw.access.provision("tenant_alpha",ACTOR,"operator",now=NOW)
        gw.access.grant_scope("tenant_alpha",ACTOR,"task.preview",
            "project:alpha",now=NOW,expires_at=NOW+500)
        scheduler=CapacityScheduler(gw,{"task.preview":ResourceCost(1,256,32)})
        scheduler.set_budget("tenant_alpha",max_inflight=1,max_cpu=2,
                             max_memory=512,max_disk=64)
        task={"schema":SCHEMA_TASK,"task_id":str(uuid.uuid4()),
           "tenant_id":"tenant_alpha","actor_id":ACTOR,
           "capability":"task.preview","issued_at":NOW-2,
           "expires_at":NOW+90,
           "idempotency_key":"wave14-oci-"+uuid.uuid4().hex,
           "resource_scopes":["project:alpha"],"body":{"action":"smoke"}}
        gw.admit(task,authenticated_tenant="tenant_alpha",
             authenticated_actor=ACTOR,now=NOW)
        lease=scheduler.reserve(worker_id="worker-abc",now=NOW,lease_seconds=50)
        self.lease=lease
        policy=SandboxPolicy(image=IMAGE,entrypoint="/usr/local/bin/worker",
               arguments=("--mode=smoke",),memory_mb=128,
               writable_tmp_mb=16,pids=8,max_wall_seconds=15)
        self.sandbox=RootlessSandbox(scheduler,{"task.preview":policy})
        self.gate=LocalOciGate(self.sandbox)

    def test_real_plan_adds_private_namespace_and_no_hosts(self):
        report=self.gate.planned(self.lease,now=NOW)
        self.assertTrue(report["image_pinned"])
        self.assertTrue(report["user_namespace_private"])
        self.assertFalse(report["runtime_exec_permitted"])
        argv=self.sandbox.plan(self.lease,now=NOW).argv
        for flag in ("--userns=private","--cgroupns=private","--no-hosts",
                     "--log-driver=none","--network=none","--read-only"):
            self.assertIn(flag,argv)

    def test_image_inspection_exact_digest_required(self):
        class Ok:
            returncode=0
            stdout=json.dumps([{"RepoDigests":[IMAGE]}]).encode()
        with patch("campaign180.oci_gate.subprocess.run",return_value=Ok()) as call:
            result=self.gate._image_inspect("/usr/bin/podman",IMAGE)
            self.assertTrue(result["digest_verified"])
            self.assertEqual(call.call_args.args[0][1:4],
                             ["image","inspect","--format"])
        class Wrong:
            returncode=0
            stdout=json.dumps([{"RepoDigests":["example/other@sha256:"+"b"*64]}]).encode()
        with patch("campaign180.oci_gate.subprocess.run",return_value=Wrong()):
            with self.assertRaises(OciGateDenied):
                self.gate._image_inspect("/usr/bin/podman",IMAGE)

    def test_oci_execution_disabled_without_explicit_optin(self):
        with patch("campaign180.oci_gate.shutil.which") as which:
            with self.assertRaises(OciGateDenied):
                self.gate.execute_local_verified(self.lease)
            which.assert_not_called()

    def test_oci_plan_never_leaks_original_body_to_argv(self):
        plan=self.sandbox.plan(self.lease,now=NOW)
        self.assertNotIn('"action":"smoke"'," ".join(plan.argv))
        self.assertEqual(plan.argv[-2:],(IMAGE,"--mode=smoke"))
        self.assertEqual(sum(x.startswith("--name=") for x in plan.argv),1)

    def test_oci_rejects_missing_hardening_flag(self):
        from types import SimpleNamespace
        plan=self.sandbox.plan(self.lease,now=NOW)
        changed=tuple(x for x in plan.argv if x!="--network=none")
        with self.assertRaises(OciGateDenied):
            self.gate._verify_plan(SimpleNamespace(argv=changed))

if __name__=="__main__":
    unittest.main()
