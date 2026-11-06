"""TITAN-X09/X10 partial: optional rootless OCI smoke execution.

No production worker, verification of real containment, network, secret
injection, user command string or external effects are enabled.
"""
from __future__ import annotations
from dataclasses import dataclass
import json
import os
import re
import shutil
import subprocess
import sys
import time
from typing import Mapping
from .contracts import canonical
from .gateway import AdmissionDenied
from .queue import LocalLease
from .scheduler import CapacityScheduler

_IMAGE=re.compile(r"^[a-z0-9][a-z0-9._:/-]{0,180}@sha256:[a-f0-9]{64}$")
_EXEC=re.compile(r"^/[A-Za-z0-9_./-]{1,150}$")
_ARG=re.compile(r"^[A-Za-z0-9_./:=,@+-]{1,128}$")
_CAP=re.compile(r"^[a-z][a-z0-9_.:-]{2,63}$")
_OPT_IN="OSGARD_EXPLICIT_LOCAL_SANDBOX"

class SandboxDenied(AdmissionDenied):
    pass

@dataclass(frozen=True)
class SandboxPolicy:
    image: str
    entrypoint: str
    arguments: tuple[str,...]=()
    cpu_millicores: int=500
    memory_mb: int=128
    writable_tmp_mb: int=16
    pids: int=16
    max_wall_seconds: int=30

    def __post_init__(self):
        if (type(self.image) is not str or not _IMAGE.fullmatch(self.image)
            or "/../" in self.image or type(self.entrypoint) is not str
            or not _EXEC.fullmatch(self.entrypoint) or "/../" in self.entrypoint
            or self.entrypoint.endswith("/") or type(self.arguments) is not tuple
            or len(self.arguments)>12
            or any(type(x) is not str or not _ARG.fullmatch(x) for x in self.arguments)):
            raise SandboxDenied("Unpinned image or unsafe trusted executable")
        for n,low,high in ((self.cpu_millicores,100,4000),(self.memory_mb,32,4096),
                           (self.writable_tmp_mb,1,256),(self.pids,4,64),
                           (self.max_wall_seconds,1,120)):
            if type(n) is not int or not low<=n<=high:
                raise SandboxDenied("Invalid container resource policy")

@dataclass(frozen=True)
class SandboxPlan:
    capability: str
    task_digest: str
    tenant_id: str
    task_id: str
    fence: int
    argv: tuple[str,...]
    seconds: int

class RootlessSandbox:
    def __init__(self,scheduler:CapacityScheduler,allowed:Mapping[str,SandboxPolicy],
                 *,allow_local_execution:bool=False):
        if type(scheduler) is not CapacityScheduler or not isinstance(allowed,Mapping):
            raise SandboxDenied("Verified local scheduler required")
        if not allowed or any(type(k) is not str or not _CAP.fullmatch(k)
                              or type(v) is not SandboxPolicy for k,v in allowed.items()):
            raise SandboxDenied("Invalid trusted capability image mapping")
        if type(allow_local_execution) is not bool:
            raise SandboxDenied("Invalid explicit opt-in flag")
        self.scheduler=scheduler
        self.allowed=dict(allowed)
        self.allow_local_execution=allow_local_execution

    def _plan(self,lease:LocalLease,*,now:int,binary:str)->SandboxPlan:
        if type(lease) is not LocalLease:
            raise SandboxDenied("Local lease receipt required")
        self.scheduler._now(now)
        with self.scheduler.jobs._tx() as db:
            row=self.scheduler._check_allocation(db,lease,now)
            checked=self.scheduler.gateway._check_row(db,row,now=now)
            if checked["task"]!=lease.task or checked["digest"]!=lease.task_digest:
                raise SandboxDenied("Lease task is no longer trusted")
            cap=checked["task"]["capability"]
            policy=self.allowed.get(cap)
            cost=self.scheduler.costs.get(cap)
            if policy is None or cost is None:
                raise SandboxDenied("No pinned image/cost policy")
            if (policy.cpu_millicores>cost.cpu_units*1000
                or policy.memory_mb>cost.memory_mb
                or policy.writable_tmp_mb>cost.disk_mb):
                raise SandboxDenied("Container limits exceed reserved budget")
            seconds=min(policy.max_wall_seconds,lease.deadline-now,
                        checked["task"]["expires_at"]-now)
            if seconds<=0:
                raise SandboxDenied("Expired container lease")
            argv=(binary,"run","--rm","--pull=never","--network=none",
                  "--read-only","--cap-drop=all","--security-opt=no-new-privileges",
                  "--pid=private","--ipc=private","--uts=private",
                  "--user=65534:65534","--pids-limit="+str(policy.pids),
                  "--memory="+str(policy.memory_mb)+"m",
                  "--memory-swap="+str(policy.memory_mb)+"m",
                  "--cpus="+f"{policy.cpu_millicores/1000:.3f}",
                  "--shm-size=1m",
                  "--tmpfs=/tmp:rw,nosuid,nodev,noexec,size="+str(policy.writable_tmp_mb)+"m",
                  "--workdir=/tmp","--ulimit=nofile=64:64",
                  "--entrypoint="+policy.entrypoint,"-i",
                  policy.image,*policy.arguments)
            return SandboxPlan(cap,lease.task_digest,lease.tenant_id,
                               lease.task_id,lease.fence,argv,seconds)

    def plan(self,lease:LocalLease,*,now:int)->SandboxPlan:
        """Never invokes Podman; safe to use in CI."""
        return self._plan(lease,now=now,binary="podman")

    @staticmethod
    def _environment()->dict:
        env={"PATH":"/usr/bin:/bin","LANG":"C","LC_ALL":"C"}
        for key in ("HOME","XDG_RUNTIME_DIR"):
            val=os.environ.get(key)
            if val and val.startswith("/") and "\x00" not in val:
                env[key]=val
        return env

    @staticmethod
    def _preflight(binary:str)->dict:
        if (sys.platform!="linux" or not hasattr(os,"geteuid") or os.geteuid()==0
                or not os.path.isabs(binary)):
            raise SandboxDenied("Rootless Linux OCI runtime required")
        try:
            response=subprocess.run([binary,"info","--format","json"],
                capture_output=True,check=False,timeout=12,shell=False,
                env=RootlessSandbox._environment())
            if response.returncode!=0 or len(response.stdout)>131072:
                raise SandboxDenied("Cannot prove rootless runtime capabilities")
            host=json.loads(response.stdout).get("host",{})
            security=host.get("security",{})
            if (security.get("rootless") is not True
                or security.get("seccompEnabled") is not True
                or host.get("cgroupVersion")!="v2"):
                raise SandboxDenied("Rootless, seccomp and cgroups v2 required")
        except (OSError,subprocess.TimeoutExpired,ValueError,TypeError,AttributeError) as exc:
            raise SandboxDenied("OCI preflight unavailable") from exc
        return {"rootless":True,"seccomp":True,"cgroups_v2":True,
                "independently_tested":False}

    def execute_local(self,lease:LocalLease)->dict:
        """Explicit local-only smoke run. Does not finalize the queue result."""
        if not self.allow_local_execution or os.environ.get(_OPT_IN)!="1":
            raise SandboxDenied("Local OCI execution is disabled")
        binary=shutil.which("podman",path="/usr/bin:/bin")
        if not binary:
            raise SandboxDenied("Podman binary not available")
        binary=os.path.realpath(binary)
        self._preflight(binary)
        plan=self._plan(lease,now=int(time.time()),binary=binary)
        body=canonical(lease.task)
        if len(body)>32768:
            raise SandboxDenied("Bounded stdin contract exceeded")
        try:
            run=subprocess.run(list(plan.argv),input=body,
                stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,
                timeout=plan.seconds,check=False,shell=False,env=self._environment())
            code=run.returncode
            status="ok" if code==0 else "failed"
        except subprocess.TimeoutExpired:
            code=None
            status="timeout"
        except OSError as exc:
            raise SandboxDenied("OCI launcher failed") from exc
        return {"schema":"osgard.original180.sandbox-smoke/1",
                "tenant_id":plan.tenant_id,"task_id":plan.task_id,
                "task_digest":plan.task_digest,"fence":plan.fence,
                "status":status,"return_code":code,
                "container_constraints_configured":True,
                "physical_enforcement_independently_tested":False,
                "result_recorded":False,"production_authorized":False}
