"""TITAN X09/X10 OCI policy, access isolation and runtime opt-in."""
import json
import tempfile
import unittest
import uuid
from pathlib import Path
from unittest.mock import patch
from campaign180.contracts import SCHEMA_TASK
from campaign180.gateway import TransactionalLocalGateway
from campaign180.scheduler import CapacityScheduler,ResourceCost
from campaign180.sandbox import SandboxPolicy,RootlessSandbox,SandboxDenied

NOW=1799971200
TENANT="tenant_alpha"
ACTOR="owner-abc"
IMAGE="registry.example.org/worker@sha256:"+("a"*64)
POLICY=SandboxPolicy(image=IMAGE,entrypoint="/usr/local/bin/worker",
    arguments=("--mode=smoke",),cpu_millicores=500,memory_mb=128,
    writable_tmp_mb=16,pids=16,max_wall_seconds=20)
ROLES={"operator":{"task.preview"}}
COSTS={"task.preview":ResourceCost(1,256,32)}

class SandboxTests(unittest.TestCase):
    def setUp(self):
        t=tempfile.TemporaryDirectory();self.addCleanup(t.cleanup)
        self.gateway=TransactionalLocalGateway(Path(t.name)/"db.sqlite3",ROLES)
        self.scheduler=CapacityScheduler(self.gateway,COSTS)
        self.gateway.access.provision(TENANT,ACTOR,"operator",now=NOW)
        self.gateway.access.grant_scope(TENANT,ACTOR,"task.preview",
            "project:alpha",now=NOW,expires_at=NOW+500)
        self.scheduler.set_budget(TENANT,max_inflight=2,max_cpu=2,max_memory=512,max_disk=64)
        task=dict(schema=SCHEMA_TASK,task_id=str(uuid.uuid4()),tenant_id=TENANT,
            actor_id=ACTOR,capability="task.preview",issued_at=NOW-2,
            expires_at=NOW+90,idempotency_key="sandbox-"+uuid.uuid4().hex,
            resource_scopes=["project:alpha"],body={"action":"smoke"})
        self.gateway.admit(task,authenticated_tenant=TENANT,
            authenticated_actor=ACTOR,now=NOW)
        self.lease=self.scheduler.reserve(worker_id="worker-abc",now=NOW,lease_seconds=50)

    def sandbox(self,policy=POLICY,enabled=False):
        return RootlessSandbox(self.scheduler,{"task.preview":policy},
                               allow_local_execution=enabled)

    def test_flags_pinned_and_no_task_content_leaks_to_command(self):
        a=self.sandbox().plan(self.lease,now=NOW)
        for option in ("--rm","--pull=never","--network=none","--read-only",
                       "--cap-drop=all","--security-opt=no-new-privileges",
                       "--memory=128m","--memory-swap=128m",
                       "--pids-limit=16","--cpus=0.500","--user=65534:65534"):
            self.assertIn(option,a.argv)
        self.assertEqual(a.argv[-2:],(IMAGE,"--mode=smoke"))
        self.assertNotIn("smoke"," ".join(a.argv[:-1]))
        self.assertEqual(a.seconds,20)

    def test_reject_image_tag_shell_payload_and_huge_limits(self):
        for overrides in (
            {"image":"worker:latest"},{"entrypoint":"sh"},
            {"arguments":("$(uname -a)",)},{"memory_mb":8192},
            {"cpu_millicores":0},{"max_wall_seconds":900}
        ):
            with self.subTest(overrides=overrides),self.assertRaises(SandboxDenied):
                SandboxPolicy(**{**POLICY.__dict__,**overrides})

    def test_false_optin_never_probes_executable(self):
        with patch("campaign180.sandbox.shutil.which") as probe:
            with self.assertRaises(SandboxDenied):
                self.sandbox().execute_local(self.lease)
            probe.assert_not_called()

    def test_missing_environment_optin_denied(self):
        with patch.dict("os.environ",{"OSGARD_EXPLICIT_LOCAL_SANDBOX":"0"}):
            with self.assertRaises(SandboxDenied):
                self.sandbox(enabled=True).execute_local(self.lease)

    def test_lease_revocation_prevents_plan(self):
        self.gateway.access.revoke_member(TENANT,ACTOR,now=NOW+1)
        with self.assertRaises(ValueError):
            self.sandbox().plan(self.lease,now=NOW+2)

    def test_lease_expiry_and_fence_prevent_plan(self):
        with self.assertRaises(ValueError):
            self.sandbox().plan(self.lease,now=NOW+51)
        self.scheduler.recover(now=NOW+51)
        new=self.scheduler.reserve(worker_id="worker-def",now=NOW+52)
        self.assertGreater(new.fence,self.lease.fence)
        with self.assertRaises(ValueError):
            self.sandbox().plan(self.lease,now=NOW+52)

    def test_policy_exceeding_reserved_cost_denied(self):
        for extra in ({"memory_mb":300},{"cpu_millicores":2000},
                      {"writable_tmp_mb":64}):
            with self.subTest(extra=extra),self.assertRaises(SandboxDenied):
                policy=SandboxPolicy(**{**POLICY.__dict__,**extra})
                self.sandbox(policy=policy).plan(self.lease,now=NOW)

    def test_wrong_capability_is_not_authorized(self):
        engine=RootlessSandbox(self.scheduler,{"audit.read":POLICY})
        with self.assertRaises(SandboxDenied):
            engine.plan(self.lease,now=NOW)

    def test_rootful_and_seccomp_off_preflight_denied(self):
        with patch("campaign180.sandbox.sys.platform","linux"),patch(
            "campaign180.sandbox.os.geteuid",return_value=0):
            with self.assertRaises(SandboxDenied):
                RootlessSandbox._preflight("/usr/bin/podman")
        class MockInfo:
            returncode=0
            stdout=json.dumps({"host":{"security":{"rootless":True,
                "seccompEnabled":False},"cgroupVersion":"v2"}}).encode()
        with patch("campaign180.sandbox.sys.platform","linux"),patch(
            "campaign180.sandbox.os.geteuid",return_value=1000),patch(
            "campaign180.sandbox.subprocess.run",return_value=MockInfo()):
            with self.assertRaises(SandboxDenied):
                RootlessSandbox._preflight("/usr/bin/podman")

    def test_mocked_explicit_run_not_product_execution(self):
        class Info:
            returncode=0
            stdout=json.dumps({"host":{"security":{"rootless":True,
                "seccompEnabled":True},"cgroupVersion":"v2"}}).encode()
        class Run:returncode=0
        with patch.dict("os.environ",{"OSGARD_EXPLICIT_LOCAL_SANDBOX":"1"}),patch(
            "campaign180.sandbox.sys.platform","linux"),patch(
            "campaign180.sandbox.os.geteuid",return_value=1000),patch(
            "campaign180.sandbox.shutil.which",return_value="/usr/bin/podman"),patch(
            "campaign180.sandbox.time.time",return_value=NOW),patch(
            "campaign180.sandbox.subprocess.run",side_effect=[Info(),Run()]) as calls:
            receipt=self.sandbox(enabled=True).execute_local(self.lease)
            self.assertEqual(receipt["status"],"ok")
            self.assertFalse(receipt["result_recorded"])
            self.assertFalse(receipt["production_authorized"])
            self.assertEqual(calls.call_count,2)
            argv=calls.call_args.args[0]
            self.assertEqual(argv[0],"/usr/bin/podman")
            self.assertEqual(argv[-2],IMAGE)
            self.assertNotIn("--privileged",argv)
            self.assertIn("--network=none",argv)

    def test_non_linux_preflight_denied(self):
        with patch("campaign180.sandbox.sys.platform","win32"):
            with self.assertRaises(SandboxDenied):
                RootlessSandbox._preflight("/usr/bin/podman")

if __name__=="__main__":
    unittest.main()
