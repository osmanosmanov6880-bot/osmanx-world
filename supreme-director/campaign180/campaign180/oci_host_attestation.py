"""Wave15 optional, fail-closed REAL host rootless OCI kernel inspection.

NO container is run unless a trusted operator explicitly enables BOTH flags
and an exact pinned image is already cached offline. This code cannot
attest isolation on an unprovisioned CI runner, and cannot authorize release.
"""
from __future__ import annotations
from dataclasses import dataclass
import json
import os
import shutil
import subprocess
import sys
import time
import re

from .sandbox import RootlessSandbox,SandboxDenied,SandboxPolicy
from .oci_gate import LocalOciGate,OciGateDenied

SCHEMA="osgard.oci-kernel-probe/1"

class HostProbeDenied(ValueError):
    pass

@dataclass(frozen=True)
class HostProbePolicy:
    image: str
    memory_mb: int=128
    cpu_millicores: int=500
    pids: int=12
    max_seconds: int=12

    def checked(self):
        # Reuse strict OCI image sha256 validation from the existing module.
        SandboxPolicy(image=self.image,entrypoint="/usr/local/bin/osgard-oci-probe",
            cpu_millicores=self.cpu_millicores,memory_mb=self.memory_mb,
            pids=self.pids,max_wall_seconds=self.max_seconds)
        if self.memory_mb<64 or self.pids>16 or self.max_seconds>20:
            raise HostProbeDenied("Probe resource budget is unsafe")
        return self

def check_kernel_report(report,*,policy:HostProbePolicy,host_ns:dict)->dict:
    """Pure result verifier: mockable in CI, not equivalent to real execution."""
    policy.checked()
    if (type(report) is not dict or set(report)!={
        "schema","uid","namespaces","root_mount_options","cap_eff",
        "no_new_privs","seccomp","memory_max","pids_max","cpu_max"} or
        report["schema"]!=SCHEMA or type(host_ns) is not dict or
        set(host_ns)!={"net","pid","user"}):
        raise HostProbeDenied("Untrusted host kernel-probe contract")
    if type(report["uid"]) is not int or report["uid"]!=65534:
        raise HostProbeDenied("Kernel did not report expected unprivileged UID")
    namespaces=report["namespaces"]
    if type(namespaces) is not dict or set(namespaces)!=set(host_ns) or any(
        type(namespaces[k]) is not str or
        not re.fullmatch(r"^[a-z]+:\[[0-9]+\]$",namespaces[k]) or
        namespaces[k]==host_ns[k] for k in host_ns):
        raise HostProbeDenied("Kernel namespaces are not separate from host")
    if (type(report["root_mount_options"]) is not str or
        "ro" not in report["root_mount_options"].split(",")):
        raise HostProbeDenied("Container root filesystem is not read-only")
    if (report["cap_eff"]!="0000000000000000" or
        report["no_new_privs"]!="1" or report["seccomp"]!="2"):
        raise HostProbeDenied("Missing kernel capability/no-new-privilege/seccomp constraints")
    for key,limit in (("memory_max",policy.memory_mb*1024*1024),
                      ("pids_max",policy.pids)):
        value=report[key]
        if type(value) is not str or not value.isdecimal() or not 1<=int(value)<=limit:
            raise HostProbeDenied("Missing enforced cgroup "+key)
    cpu=report["cpu_max"]
    if type(cpu) is not str or not re.fullmatch(r"[0-9]+ [0-9]+",cpu):
        raise HostProbeDenied("No finite cgroup CPU quota")
    maximum,period=map(int,cpu.split())
    if maximum<=0 or period<=0 or maximum/period>policy.cpu_millicores/1000+1e-6:
        raise HostProbeDenied("Cgroup CPU policy differs")
    return {"schema":"osgard.oci-host-local-evidence/1",
        "network_namespace_separate":True,"pid_namespace_separate":True,
        "user_namespace_separate":True,"read_only_root_verified":True,
        "capabilities_dropped_verified":True,"no_new_privileges_verified":True,
        "seccomp_observed":True,"cgroups_v2_limits_observed":True,
        "physical_probe_executed":True,
        "independently_accepted":False,"production_authorized":False}

class LocalRootlessHostAudit:
    def __init__(self,policy:HostProbePolicy,*,allow_local_execution:bool=False):
        if type(policy) is not HostProbePolicy or type(allow_local_execution) is not bool:
            raise HostProbeDenied("Trusted explicit probe policy required")
        self.policy=policy.checked()
        self.allow_local_execution=allow_local_execution

    def audit(self):
        if (not self.allow_local_execution or
            os.environ.get("OSGARD_EXPLICIT_LOCAL_SANDBOX")!="1" or
            os.environ.get("OSGARD_EXPLICIT_OCI_HOST_PROBE")!="1"):
            raise HostProbeDenied("Physical host probe is disabled by default")
        if (sys.platform!="linux" or os.geteuid()==0):
            raise HostProbeDenied("Dedicated non-root Linux host required")
        binary=shutil.which("podman",path="/usr/bin:/bin")
        if not binary:
            raise HostProbeDenied("Podman is not installed")
        binary=os.path.realpath(binary)
        RootlessSandbox._preflight(binary)
        LocalOciGate._image_inspect(binary,self.policy.image)
        host_ns={kind:os.readlink("/proc/self/ns/"+kind) for kind in ("net","pid","user")}
        name="osgard-physical-probe-"+str(os.getpid())
        cmd=[binary,"run","--rm","--pull=never","--network=none",
            "--read-only","--cap-drop=all","--security-opt=no-new-privileges",
            "--pid=private","--ipc=private","--uts=private",
            "--userns=private","--cgroupns=private","--no-hosts",
            "--log-driver=none","--user=65534:65534",
            "--pids-limit="+str(self.policy.pids),
            "--memory="+str(self.policy.memory_mb)+"m",
            "--memory-swap="+str(self.policy.memory_mb)+"m",
            "--cpus="+f"{self.policy.cpu_millicores/1000:.3f}",
            "--name="+name,
            "--entrypoint=/usr/local/bin/osgard-oci-probe",
            self.policy.image]
        try:
            output=subprocess.run(cmd,capture_output=True,check=False,
                  timeout=self.policy.max_seconds,shell=False,
                  env=RootlessSandbox._environment())
        except (OSError,subprocess.TimeoutExpired) as exc:
            try:
                subprocess.run([binary,"rm","--force",name],
                    stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,
                    timeout=6,check=False,shell=False,
                    env=RootlessSandbox._environment())
            except (OSError,subprocess.TimeoutExpired):pass
            raise HostProbeDenied("Physical probe did not finish within bounds") from exc
        if output.returncode!=0 or len(output.stdout)>4096:
            raise HostProbeDenied("Physical probe failed or produced oversized output")
        try:report=json.loads(output.stdout)
        except (ValueError,UnicodeDecodeError) as exc:
            raise HostProbeDenied("Untrusted physical probe output") from exc
        return check_kernel_report(report,policy=self.policy,host_ns=host_ns)
