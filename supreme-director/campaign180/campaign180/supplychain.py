"""TITAN-X26: conservative offline scan of changed repository files.

No remote vulnerability database, licensing certification, SBOM resolution or
secret disclosure. Scanner emits rules/path/line ONLY, never matched values.
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path, PurePosixPath
import re
import subprocess
import sys
import tomllib
from typing import Any

MAX_SCAN_FILES=1500
MAX_SINGLE=8*1024*1024
MAX_TOTAL=60*1024*1024
TOKEN_RULES=(
    ("PRIVATE_KEY",re.compile("-----BEGIN "+"(?:RSA |EC |OPENSSH )?PRIVATE KEY-----")),
    ("GITHUB_PAT",re.compile("gh"+"[pousr]_[A-Za-z0-9]{30,}")),
    ("OPENAI_KEY",re.compile("sk-"+"(?:proj-|svcacct-)?[A-Za-z0-9_-]{25,}")),
    ("AWS_KEY",re.compile("AK"+"IA[0-9A-Z]{16}")),
)
FLOATING=re.compile(r"^[\^~*]|[<>]|(^|[.])x($|[.])",re.I)


class ScanDenied(ValueError):
    pass


def _safe_path(root: Path, name: str) -> Path:
    if (type(name) is not str or not name or "\\" in name or "\x00" in name
            or name.startswith("/") or "." in PurePosixPath(name).parts
            or ".." in PurePosixPath(name).parts or name.endswith("/")):
        raise ScanDenied("Unsafe tracked path")
    result=root.joinpath(*PurePosixPath(name).parts)
    if not result.resolve().is_relative_to(root.resolve()):
        raise ScanDenied("Tracked path escapes root")
    cursor=root
    for part in PurePosixPath(name).parts:
        cursor=cursor/part
        if cursor.is_symlink():
            raise ScanDenied("Symbolic link in scanned path")
    return result


def scan_content(name: str, content: bytes) -> list[dict]:
    findings=[]
    if b"\x00" in content:
        return [{"rule":"BINARY_SOURCE","line":0,"severity":"warning"}]
    try:
        text=content.decode("utf-8")
    except UnicodeError:
        return [{"rule":"NON_UTF8_SOURCE","line":0,"severity":"warning"}]
    for number,line in enumerate(text.splitlines(),1):
        for rule,pattern in TOKEN_RULES:
            if pattern.search(line):
                findings.append({"rule":rule,"line":number,"severity":"blocker"})
    basename=PurePosixPath(name).name.lower()
    if basename.startswith(".env") and basename not in (".env.example",".env.sample"):
        findings.append({"rule":"SENSITIVE_CONFIG_FILENAME","line":0,"severity":"blocker"})
    if basename.startswith("requirements") and basename.endswith(".txt"):
        for number,line in enumerate(text.splitlines(),1):
            spec=line.strip()
            if spec and not spec.startswith("#") and not spec.startswith("-") and (
                    "==" not in spec and " @ " not in spec):
                findings.append({"rule":"UNPINNED_PYTHON_DEPENDENCY",
                                 "line":number,"severity":"warning"})
    if basename=="package.json":
        try:
            manifest=json.loads(text)
            if type(manifest) is not dict:
                raise ValueError()
            for bucket in ("dependencies","devDependencies","optionalDependencies"):
                packages=manifest.get(bucket,{})
                if type(packages) is not dict:
                    raise ValueError()
                for version in packages.values():
                    if type(version) is not str or FLOATING.search(version):
                        findings.append({"rule":"FLOATING_NODE_DEPENDENCY",
                                         "line":0,"severity":"warning"})
        except (ValueError,TypeError):
            findings.append({"rule":"UNPARSEABLE_PACKAGE_JSON",
                             "line":0,"severity":"blocker"})
    if basename=="pyproject.toml":
        try:tomllib.loads(text)
        except (ValueError,TypeError):
            findings.append({"rule":"UNPARSEABLE_PYPROJECT",
                             "line":0,"severity":"blocker"})
    return findings


def scan_changed(root: Path, paths: list[str]) -> dict:
    root=Path(root).resolve()
    if type(paths) is not list or not 0<=len(paths)<=MAX_SCAN_FILES:
        raise ScanDenied("Invalid or excessive changed-file list")
    all_findings=[]
    seen=set()
    total=0
    scanned=0
    for name in paths:
        path=_safe_path(root,name)
        if name in seen:
            raise ScanDenied("Duplicate changed path")
        seen.add(name)
        if not path.exists():
            all_findings.append({"path":name,"line":0,
                                 "rule":"REMOVED_FILE_NOT_INSPECTED","severity":"warning"})
            continue
        if not path.is_file():
            raise ScanDenied("Nonregular scanned path")
        size=path.stat().st_size
        total+=size
        if size>MAX_SINGLE or total>MAX_TOTAL:
            raise ScanDenied("File or total scan size cap exceeded")
        data=path.read_bytes()
        scanned+=1
        for item in scan_content(name,data):
            all_findings.append({"path":name,**item})
    blockers=[x for x in all_findings if x["severity"]=="blocker"]
    return {"schema":"osgard.original180.changed-source-scan/1",
            "scanned":scanned,"changed":len(paths),"bytes":total,
            "issues":all_findings,"blocking_rules":len(blockers),
            "local_static_scan_pass":not blockers,
            "public_vulnerability_database_queried":False,
            "license_provenance_verified":False,
            "release_authorized":False}


def main(argv=None) -> int:
    parser=argparse.ArgumentParser(description="Local changed-source scan")
    parser.add_argument("--root",type=Path,default=Path("."))
    parser.add_argument("--base",default="HEAD^",help="Local git diff base commit")
    args=parser.parse_args(argv)
    try:
        diff=subprocess.run(["git","-C",str(args.root),"diff","--name-only",
                             "-z",args.base,"HEAD"],check=True,capture_output=True,
                            timeout=20)
        paths=[p.decode("utf-8") for p in diff.stdout.split(b"\x00") if p]
        report=scan_changed(args.root,paths)
        print(json.dumps(report,sort_keys=True))
        return 0 if report["local_static_scan_pass"] else 3
    except (ScanDenied,UnicodeError,subprocess.CalledProcessError,
            subprocess.TimeoutExpired,OSError) as exc:
        print("SCAN_FAIL_CLOSED: "+str(exc),file=sys.stderr)
        return 2


if __name__=="__main__":
    raise SystemExit(main())
