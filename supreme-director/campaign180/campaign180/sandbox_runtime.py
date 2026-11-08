"""Closed-operation subprocess executor with real POSIX resource limits.

TITAN-X09/X10 PARTIAL ONLY. This is not a container, seccomp policy,
network namespace or arbitrary-code sandbox. The user cannot supply code,
paths or executable arguments. No external worker execution is authorized.
"""
from __future__ import annotations
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import time
from typing import Any

from .contracts import canonical, digest, validate_task,ContractError
from .resource_limits import ResourceLimits,ResourceDenied

class SandboxDenied(ValueError):
    pass

_ALLOWED={"sum_i64","sha256_text","utf8_length","sleep_ms"}
_SCRIPT=Path(__file__).with_name("bounded_worker.py").resolve()

def _job(value:Any,limits:ResourceLimits)->bytes:
    if type(value) is not dict or set(value)!={"operation","value"}:
        raise SandboxDenied("Fixed-operation job schema required")
    op=value["operation"]
    if type(op) is not str or op not in _ALLOWED:
        raise SandboxDenied("No user code, shell or network operations allowed")
    payload=value["value"]
    if op=="sum_i64" and (type(payload) is not list or
        not 1<=len(payload)<=limits.max_operations or
        any(type(x) is not int or abs(x)>2**63-1 for x in payload)):
        raise SandboxDenied("Invalid bounded integer operations")
    if op in ("sha256_text","utf8_length") and (type(payload) is not str or
        len(payload.encode("utf-8"))>min(8192,limits.input_bytes)):
        raise SandboxDenied("Invalid bounded UTF-8 text")
    if op=="sleep_ms" and (type(payload) is not int or not 0<=payload<=10000):
        raise SandboxDenied("Invalid synthetic wait")
    data=canonical(value)
    if len(data)>limits.input_bytes:
        raise SandboxDenied("Job input exceeds budget")
    return data

def run_allowlisted_task(authorization:dict,*,expected_tenant:str,
                         expected_actor:str,scopes:set[str],now:int,
                         limits:ResourceLimits|None=None)->dict:
    """Revalidate envelope and run one closed-set operation; no arbitrary code."""
    limits=(limits or ResourceLimits()).checked()
    if type(authorization) is not dict or set(authorization)!={
        "task","digest","authorization","external_execution_permitted"}:
        raise SandboxDenied("Untrusted task validation provenance")
    task=authorization["task"]
    if (authorization["digest"]!=digest(task) or
        authorization["authorization"]!="LOCAL_VALIDATION_ONLY" or
        authorization["external_execution_permitted"] is not False):
        raise SandboxDenied("Invalid or altered authorized envelope")
    validate_task(task,tenant_id=expected_tenant,actor_id=expected_actor,
        allow_capabilities={"sandbox.evaluate"},allowed_scopes=scopes,now=now)
    payload=_job(task["body"],limits)
    # Resource limits are enforced BEFORE the fixed script starts. The only
    # code path is an absolute, trusted script filename in this package.
    if not _SCRIPT.is_file():
        raise SandboxDenied("Pinned worker missing")
    started=time.monotonic()
    with tempfile.TemporaryDirectory(prefix="osgard-allowlisted-worker-") as directory:
        try:
            proc=subprocess.Popen(
                [sys.executable,"-I","-S","-B",str(_SCRIPT)],
                stdin=subprocess.PIPE,stdout=subprocess.PIPE,
                stderr=subprocess.DEVNULL,cwd=directory,
                env={"PYTHONDONTWRITEBYTECODE":"1","PYTHONNOUSERSITE":"1",
                     "LC_ALL":"C.UTF-8"},
                start_new_session=True,preexec_fn=limits.worker_rlimits)
        except (OSError,ValueError,subprocess.SubprocessError) as exc:
            raise SandboxDenied("OS worker isolation setup denied") from exc
        try:
            stdout,_=proc.communicate(payload,timeout=limits.wall_ms/1000)
        except subprocess.TimeoutExpired as exc:
            os.killpg(proc.pid,signal.SIGKILL)
            proc.communicate()
            raise SandboxDenied("Worker exceeded wall-time deadline") from exc
    elapsed=round((time.monotonic()-started)*1000)
    if len(stdout)>limits.output_bytes:
        raise SandboxDenied("Worker output exceeded resource limit")
    if proc.returncode!=0:
        raise SandboxDenied("Worker terminated or rejected an unsafe operation")
    try:
        result=json.loads(stdout)
    except (ValueError,UnicodeDecodeError) as exc:
        raise SandboxDenied("Untrusted worker output") from exc
    if type(result) is not dict or set(result)!={"status","output"} or result["status"]!="ok":
        raise SandboxDenied("Unexpected worker response contract")
    return {"schema":"osgard.local-allowlist-execution/1",
            "task_id":task["task_id"],"tenant_id":expected_tenant,
            "task_sha256":authorization["digest"],"result":result["output"],
            "wall_ms":elapsed,"input_bytes":len(payload),"output_bytes":len(stdout),
            "resource_limits_enforced":True,"arbitrary_code_execution":False,
            "network_namespace_isolated":False,
            "external_execution_authorized":False,
            "independently_accepted":False}
