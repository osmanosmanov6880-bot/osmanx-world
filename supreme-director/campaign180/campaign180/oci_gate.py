"""Wave 14: OCI provenance and plan verification for optional rootless smoke.

Does not run untrusted source or activate production workers. Verifies an
already-cached digest-pinned container image before locally opted-in Podman
execution. Real kernel isolation must be independently tested on the target
rootless Linux host; mocked CI is not physical isolation evidence.
"""
from __future__ import annotations
import json
import os
import shutil
import subprocess

from .sandbox import RootlessSandbox,SandboxDenied,_OPT_IN

_MUST={
    "--rm","--pull=never","--network=none","--read-only",
    "--cap-drop=all","--security-opt=no-new-privileges",
    "--pid=private","--ipc=private","--uts=private",
    "--userns=private","--cgroupns=private","--no-hosts",
    "--log-driver=none","--user=65534:65534"
}

class OciGateDenied(SandboxDenied):
    pass

class LocalOciGate:
    def __init__(self,sandbox:RootlessSandbox):
        if type(sandbox) is not RootlessSandbox:
            raise OciGateDenied("Trusted rootless scheduler sandbox required")
        self.sandbox=sandbox

    @staticmethod
    def _verify_plan(plan):
        args=plan.argv
        if (type(args) is not tuple or len(args)<25 or
            not _MUST.issubset(set(args)) or
            any(s=="--privileged" or s.startswith("--network=") and
                s!="--network=none" for s in args)):
            raise OciGateDenied("Container plan lacks mandatory isolation")
        if sum(1 for s in args if s.startswith("--name="))!=1:
            raise OciGateDenied("One deterministic container name required")
        if not any(x.startswith("--memory=") for x in args):
            raise OciGateDenied("Memory policy missing from OCI invocation")
        if not any(x.startswith("--cpus=") for x in args):
            raise OciGateDenied("CPU policy missing from OCI invocation")

    def planned(self,lease,*,now:int)->dict:
        """Pure function: no local executable discovery or network side effects."""
        plan=self.sandbox.plan(lease,now=now)
        self._verify_plan(plan)
        policy=self.sandbox.allowed[plan.capability]
        return {"schema":"osgard.rootless-oci-preflight-plan/1",
                "task_digest":plan.task_digest,"tenant_id":plan.tenant_id,
                "fence":plan.fence,"image":policy.image,
                "image_pinned":True,"network_disabled":True,
                "read_only":True,"capabilities_dropped":True,
                "user_namespace_private":True,"cgroup_namespace_private":True,
                "runtime_exec_permitted":False,
                "physical_enforcement_verified":False,
                "production_authorized":False}

    @staticmethod
    def _image_inspect(binary:str,image:str)->dict:
        try:
            proc=subprocess.run(
                [binary,"image","inspect","--format","json",image],
                capture_output=True,check=False,timeout=12,shell=False,
                env=RootlessSandbox._environment())
        except (OSError,subprocess.TimeoutExpired) as exc:
            raise OciGateDenied("Offline OCI image inspection failed") from exc
        if proc.returncode!=0 or len(proc.stdout)>262144:
            raise OciGateDenied("Pinned image is not available offline")
        try:
            data=json.loads(proc.stdout)
        except (ValueError,UnicodeDecodeError,TypeError) as exc:
            raise OciGateDenied("Unparseable image inspect response") from exc
        if type(data) is list and len(data)==1:
            data=data[0]
        if type(data) is not dict:
            raise OciGateDenied("Untrusted image inspect envelope")
        digests=data.get("RepoDigests")
        if type(digests) is not list or image not in digests:
            raise OciGateDenied("Cached OCI image digest mismatch")
        if len(image.split("@sha256:"))!=2:
            raise OciGateDenied("OCI image must be manifest digest pinned")
        return {"manifest_reference":image,"digest_verified":True,
                "offline_image":True,"image_origin_independently_verified":False}

    def execute_local_verified(self,lease)->dict:
        # Fail closed even before a binary lookup; no secrets or customer
        # data are inspected or printed.
        if not self.sandbox.allow_local_execution or os.environ.get(_OPT_IN)!="1":
            raise OciGateDenied("OCI execution requires explicit local opt-in")
        binary=shutil.which("podman",path="/usr/bin:/bin")
        if not binary:
            raise OciGateDenied("Rootless Podman not installed")
        binary=os.path.realpath(binary)
        RootlessSandbox._preflight(binary)
        from time import time
        plan=self.sandbox._plan(lease,now=int(time()),binary=binary)
        self._verify_plan(plan)
        cached=self._image_inspect(binary,self.sandbox.allowed[plan.capability].image)
        result=self.sandbox.execute_local(lease)
        return {**result,"offline_digest_verified":cached["digest_verified"],
                "independent_kernel_acceptance":False,"production_authorized":False}
