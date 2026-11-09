#!/usr/bin/env python3
"""Fixed no-network Linux OCI probe; install as /usr/local/bin/osgard-oci-probe.

This script is intentionally read-only and accepts NO user arguments. It
reports kernel-observed security settings, not a blanket security claim.
It must be packaged inside an owner-reviewed, digest-pinned offline image.
"""
from __future__ import annotations
import json
import os
from pathlib import Path

def read(path,cap=100000):
    p=Path(path)
    if not p.is_file() or p.stat().st_size>cap:return ""
    return p.read_text(encoding="utf-8",errors="replace")[:cap]

def _ns(kind):
    return os.readlink("/proc/self/ns/"+kind)

def run():
    status={}
    for line in read("/proc/self/status").splitlines():
        if ":" in line:
            name,value=line.split(":",1)
            if name in ("CapEff","NoNewPrivs","Seccomp","Seccomp_filters"):
                status[name]=value.strip()
    mountinfo=read("/proc/self/mountinfo",200000)
    root_flags=""
    for line in mountinfo.splitlines():
        fields=line.split()
        if len(fields)>6 and fields[4]=="/":
            root_flags=fields[5]
            break
    return {
        "schema":"osgard.oci-kernel-probe/1",
        "uid":os.geteuid(),
        "namespaces":{k:_ns(k) for k in ("net","pid","user")},
        "root_mount_options":root_flags,
        "cap_eff":status.get("CapEff",""),
        "no_new_privs":status.get("NoNewPrivs",""),
        "seccomp":status.get("Seccomp",""),
        "memory_max":read("/sys/fs/cgroup/memory.max",128).strip(),
        "pids_max":read("/sys/fs/cgroup/pids.max",128).strip(),
        "cpu_max":read("/sys/fs/cgroup/cpu.max",128).strip(),
    }

if __name__=="__main__":
    print(json.dumps(run(),sort_keys=True,separators=(",",":")))
