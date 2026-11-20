"""TITAN-X02: source/package/dependency inventory without network access.

Enumerates actual tracked manifest bytes, lockfile presence and direct
version constraints; NEVER installs or guesses ownership of the canonical
KRAKEN/DevSwarm/Command product modules.
"""
from __future__ import annotations
import argparse
from hashlib import sha256
import json
from pathlib import Path
import re
import tomllib
from .registry import EvidenceError,git_files,load_upstreams,repository_inventory
from .titan_baseline import snapshot

_EXACT_PY=re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]*==[0-9][A-Za-z0-9._+!-]*(?:\s*;\s*.+)?$")
_PY_REQ=re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]*\s*==\s*[0-9][A-Za-z0-9._+!-]*(?:\s+--hash=sha256:[a-f0-9]{64})$")
_LOCK_NAMES={"uv.lock","poetry.lock","pdm.lock","pipfile.lock","requirements.lock",
             "package-lock.json","pnpm-lock.yaml","yarn.lock","cargo.lock","go.sum"}
_MANIFEST_NAMES={"pyproject.toml","package.json","cargo.toml","go.mod","pipfile"}

def _read(path:Path):
    if path.is_symlink() or not path.is_file() or path.stat().st_size>512000:
        raise EvidenceError("Missing, symlinked or oversized package manifest")
    return path.read_bytes()

def _raw_dependencies(path:str,body:bytes)->tuple[list[str],list[str]]:
    name=Path(path).name.lower()
    declared=[]
    issues=[]
    if name=="pyproject.toml":
        try:doc=tomllib.loads(body.decode("utf-8"))
        except (UnicodeError,tomllib.TOMLDecodeError) as exc:
            raise EvidenceError("Invalid pyproject.toml: "+path) from exc
        project=doc.get("project",{})
        if type(project) is not dict:raise EvidenceError("Invalid Python project")
        requirements=project.get("dependencies",[])
        if type(requirements) is not list or any(type(r) is not str for r in requirements):
            raise EvidenceError("Invalid Python dependencies")
        optional=project.get("optional-dependencies",{})
        if type(optional) is not dict:raise EvidenceError("Invalid optional dependencies")
        for extra,reqs in optional.items():
            if type(reqs) is not list or any(type(x) is not str for x in reqs):
                raise EvidenceError("Invalid Python optional dependencies")
            requirements += reqs
        declared=list(requirements)
        for r in requirements:
            if not _EXACT_PY.fullmatch(r.strip()):
                issues.append("UNLOCKED_OR_FLOATING_PYTHON_DEPENDENCY")
        build=doc.get("build-system",{})
        if build:
            if type(build) is not dict or type(build.get("requires",[])) is not list:
                raise EvidenceError("Invalid build-system")
            for r in build["requires"]:
                if type(r) is not str:raise EvidenceError("Invalid build requirement")
                declared.append("build:"+r)
    elif name=="package.json":
        try:doc=json.loads(body)
        except (ValueError,UnicodeError) as exc:raise EvidenceError("Invalid package.json") from exc
        if type(doc) is not dict:raise EvidenceError("Invalid Node package metadata")
        for group in ("dependencies","devDependencies","optionalDependencies"):
            deps=doc.get(group,{})
            if type(deps) is not dict:raise EvidenceError("Invalid Node dependency group")
            for n,version in sorted(deps.items()):
                if type(n) is not str or type(version) is not str:
                    raise EvidenceError("Invalid Node dependency entry")
                declared.append(n+"@"+version)
                if not re.fullmatch(r"[0-9]+\.[0-9]+\.[0-9]+(?:[-+][A-Za-z0-9.-]+)?",version):
                    issues.append("FLOATING_NODE_DEPENDENCY")
    elif name.startswith("requirements") and name.endswith(".txt"):
        for line in body.decode("utf-8").splitlines():
            line=line.strip()
            if not line or line.startswith("#"):continue
            if line.startswith(("-","git+","http:","https:")):
                issues.append("UNSAFE_OR_DYNAMIC_REQUIREMENT")
                continue
            declared.append(line)
            if not _PY_REQ.fullmatch(line):
                issues.append("UNHASHED_OR_UNPINNED_REQUIREMENT")
    return declared,sorted(set(issues))

def inventory(root:Path)->dict:
    root=Path(root).resolve()
    baseline=snapshot(root)
    tracked=git_files(root)
    files=set(tracked)
    data=[]
    issues=[]
    for path in tracked:
        filename=Path(path).name.lower()
        if filename not in _MANIFEST_NAMES and not (
            filename.startswith("requirements") and filename.endswith(".txt")
        ) and filename not in _LOCK_NAMES:
            continue
        body=_read(root/path)
        dependency_list,flags=_raw_dependencies(path,body)
        dirname=str(Path(path).parent)
        lock_candidates=[]
        if filename=="pyproject.toml":
            lock_candidates=["uv.lock","poetry.lock","pdm.lock","requirements.lock"]
        elif filename=="package.json":
            lock_candidates=["package-lock.json","pnpm-lock.yaml","yarn.lock"]
        elif filename=="cargo.toml":lock_candidates=["Cargo.lock"]
        elif filename=="go.mod":lock_candidates=["go.sum"]
        lock_found=any((Path(path).parent/c).as_posix() in files for c in lock_candidates)
        if dependency_list and lock_candidates and not lock_found:
            flags.append("DECLARED_DEPENDENCIES_WITHOUT_LOCKFILE")
        for flag in flags:issues.append({"path":path,"rule":flag})
        data.append({"path":path,"sha256":sha256(body).hexdigest(),
                     "bytes":len(body),"dependencies":dependency_list,
                     "lockfile_present":lock_found if lock_candidates else None,
                     "risks":sorted(set(flags))})
    if not data:issues.append({"path":None,"rule":"NO_PACKAGE_MANIFESTS"})
    return {"schema":"osgard.original180.titan-dependency-inventory/1",
            "task_id":"TITAN-X02","checkout_sha":baseline["checkout_commit"],
            "checkout_tree":baseline["checkout_tree"],
            "titan_source_status":baseline["status"],
            "manifests":data,"manifest_count":len(data),
            "risks":sorted(issues,key=lambda x:(x["path"] or "",x["rule"])),
            "network_access":False,"dependencies_installed":False,
            "canonical_upstream_dependencies_verified":False,
            "status":"BLOCKED_UPSTREAM" if baseline["status"]=="BLOCKED_UPSTREAM"
                     else ("IN_PROGRESS" if issues else "READY_FOR_REVIEW"),
            "independently_accepted":False,"production_authorized":False}

def main(argv=None):
    parser=argparse.ArgumentParser(description="TITAN-X02 read-only package inventory")
    parser.add_argument("--root",type=Path,default=Path("."))
    opts=parser.parse_args(argv)
    print(json.dumps(inventory(opts.root),ensure_ascii=False,sort_keys=True))
    return 0

if __name__=="__main__":
    raise SystemExit(main())
