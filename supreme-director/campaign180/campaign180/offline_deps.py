"""TITAN-X05: offline-only, hash-locked wheel recovery preflight.

This preflight does not download, import, or install untrusted dependencies.
Installation into an isolated disposable environment is a separate decision.
"""
from __future__ import annotations

from hashlib import sha256
import json
from pathlib import Path
import re
import subprocess
import sys

_LOCK = re.compile(r"^([A-Za-z0-9][A-Za-z0-9_.-]*)==([A-Za-z0-9][A-Za-z0-9_.!+-]*)[ \t]+--hash=sha256:([a-f0-9]{64})$")
_NAME = re.compile(r"[-_.]+")
_MAX_WHEEL = 60 * 1024 * 1024


class DependencyError(ValueError):
    pass


def _name(value: str) -> str:
    return _NAME.sub("-",value).lower()


def inspect_offline_wheelhouse(requirements: Path, wheelhouse: Path) -> dict:
    requirements, wheelhouse = Path(requirements),Path(wheelhouse)
    if requirements.is_symlink() or not requirements.is_file():
        raise DependencyError("Explicit pinned requirements file missing")
    if wheelhouse.is_symlink() or not wheelhouse.is_dir():
        raise DependencyError("Wheelhouse missing or symlinked")
    entries=[]
    names=set()
    source=requirements.read_text(encoding="utf-8")
    if len(source.encode("utf-8")) > 100_000:
        raise DependencyError("Requirements exceed size limit")
    for number,line in enumerate(source.splitlines(),1):
        trimmed=line.strip()
        if not trimmed or trimmed.startswith("#"):
            continue
        match=_LOCK.fullmatch(trimmed)
        if not match:
            raise DependencyError("Unpinned, unhashed or unsafe requirement at line "+str(number))
        name,version,hash_value=match.groups()
        norm=_name(name)
        if norm in names:
            raise DependencyError("Duplicate normalized distribution name")
        names.add(norm)
        candidates=[]
        for wheel in sorted(wheelhouse.glob("*.whl")):
            if wheel.is_symlink() or not wheel.is_file() or wheel.stat().st_size>_MAX_WHEEL:
                raise DependencyError("Unsafe or oversized wheel")
            bits=wheel.name[:-4].split("-")
            if len(bits) < 5:
                raise DependencyError("Malformed wheel filename")
            if _name(bits[0])==norm and bits[1]==version:
                hashed=sha256(wheel.read_bytes()).hexdigest()
                if hashed==hash_value:
                    candidates.append(wheel.name)
        if len(candidates)!=1:
            raise DependencyError("Exactly one verified offline wheel required for "+name)
        entries.append({"distribution":norm,"version":version,
                        "sha256":hash_value,"wheel":candidates[0]})
    if not entries:
        raise DependencyError("Empty pinned dependency lock")
    return {"schema":"osgard.original180.offline-wheels/1",
            "offline_packages":entries,"unverified_dependencies":0,
            "network_access_required":False,"wheels_verified":True,
            "installed":False,"upstream_test_dependencies_restored":False}


def restore_into_empty_target(requirements: Path, wheelhouse: Path, target: Path,
                              *, python_executable: str = sys.executable) -> dict:
    """Explicit opt-in installation into an empty target; never uses a package index.

    Do not run against untrusted wheel files, a system environment, or a shared
    production target. pip --require-hashes also covers transitive dependencies.
    """
    report=inspect_offline_wheelhouse(requirements,wheelhouse)
    target=Path(target)
    if target.is_symlink() or (target.exists() and (
            not target.is_dir() or any(target.iterdir()))):
        raise DependencyError("Target must be new or empty and not symlinked")
    if target.resolve() in (Path("/"),Path.home().resolve(),Path.cwd().resolve()):
        raise DependencyError("Unsafe install location")
    if target.resolve()==Path(wheelhouse).resolve() or target.resolve()==Path(requirements).parent.resolve():
        raise DependencyError("Do not install into source or wheelhouse")
    target.mkdir(parents=True,exist_ok=True)
    command=[python_executable,"-m","pip","install","--no-index","--require-hashes",
             "--no-cache-dir","--disable-pip-version-check","--no-compile",
             "--find-links",str(Path(wheelhouse).resolve()),"--target",str(target.resolve()),
             "-r",str(Path(requirements).resolve())]
    try:
        done=subprocess.run(command,capture_output=True,text=True,timeout=120,check=False)
    except (OSError,subprocess.TimeoutExpired) as exc:
        raise DependencyError("Offline installer could not complete") from exc
    if done.returncode:
        raise DependencyError("Offline pip installation failed; target must be discarded")
    report["installed"]=True
    report["isolated_target"]=str(target.resolve())
    return report


def main(argv=None) -> int:
    import argparse
    parser=argparse.ArgumentParser(description="Hash-pinned offline wheel preflight")
    parser.add_argument("requirements",type=Path)
    parser.add_argument("wheelhouse",type=Path)
    parser.add_argument("--target",type=Path,help="EXPLICIT local install into new empty directory")
    args=parser.parse_args(argv)
    try:
        out=(restore_into_empty_target(args.requirements,args.wheelhouse,args.target)
             if args.target else inspect_offline_wheelhouse(args.requirements,args.wheelhouse))
        print(json.dumps(out,sort_keys=True))
    except (DependencyError,OSError) as exc:
        parser.exit(2,"FAIL_CLOSED: "+str(exc)+"\n")
    return 0


if __name__=="__main__":
    raise SystemExit(main())
