"""Build and verify a small deterministic OSGARD local-preview ZIP.

Only allowlisted source files enter the bundle; no secret material, tracked
database, browser profile or remote deployment configuration is packaged.
Hash validation is a content integrity check, not a claim of original 180
task acceptance or production readiness.
"""
from __future__ import annotations

import argparse
from hashlib import sha256
import json
import os
from pathlib import Path, PurePosixPath
import re
import subprocess
import sys
import tempfile
import zipfile

SCHEMA="osgard.original180.local-preview-zip/1"
ROOTNAME="OSGARD_LOCAL_PREVIEW"
MANIFEST="CHECKSUMS.json"
MAX_FILES=90
MAX_FILE=1024*1024
MAX_UNCOMPRESSED=12*1024*1024
REVISION=re.compile(r"^[a-f0-9]{40}$")
MODULE=re.compile(r"^[a-z][a-z0-9_]*\.py$")
ASSETS=frozenset({"index.html","console.js","console.css"})

RUN_LOCAL=(
    "from campaign180.preview_launcher import run\n"
    "if __name__=='__main__':\n"
    "    try:raise SystemExit(run())\n"
    "    except KeyboardInterrupt:print('\\nЛокальный сервер остановлен')\n"
)
START_SH="#!/bin/sh\nset -eu\ncd \"$(dirname \"$0\")\"\nexec python3 run_local.py \"$@\"\n"
START_CMD="@echo off\r\ncd /d \"%~dp0\"\r\npy -3 run_local.py %*\r\nif errorlevel 1 pause\r\n"


class PreviewBundleDenied(ValueError):
    pass


def _files(source:Path)->dict[str,bytes]:
    source=Path(source)
    pkg=source/"campaign180"
    ui=source/"assets"
    example=source/"examples"/"demo-site.json"
    readme=source/"docs"/"WAVE27_LOCAL_PREVIEW_RU.md"
    for directory in (pkg,ui):
        if directory.is_symlink() or not directory.is_dir():
            raise PreviewBundleDenied("Application source directory unavailable")
    result={}
    for item in sorted(pkg.iterdir()):
        if item.name=="__pycache__" and item.is_dir() and not item.is_symlink():
            continue  # compileall and unittest create this folder before packaging.
        if (item.is_symlink() or not item.is_file()
                or (item.name not in ("__init__.py","__main__.py")
                    and not MODULE.fullmatch(item.name))):
            raise PreviewBundleDenied("Unexpected Python package entry")
        result["campaign180/"+item.name]=item.read_bytes()
    for item in sorted(ui.iterdir()):
        if item.is_symlink() or not item.is_file() or item.name not in ASSETS:
            raise PreviewBundleDenied("Unexpected browser asset")
        result["assets/"+item.name]=item.read_bytes()
    for item in (example,readme):
        if item.is_symlink() or not item.is_file():
            raise PreviewBundleDenied("Missing required demonstrator source")
    result.update({
        "examples/demo-site.json":example.read_bytes(),
        "README_RU.md":readme.read_bytes(),
        "run_local.py":RUN_LOCAL.encode("utf-8"),
        "start.sh":START_SH.encode("utf-8"),
        "start.cmd":START_CMD.encode("utf-8"),
    })
    if (len(result)<40 or len(result)>MAX_FILES-1 or
            any(len(body)>MAX_FILE for body in result.values()) or
            sum(len(x) for x in result.values())>MAX_UNCOMPRESSED):
        raise PreviewBundleDenied("Invalid source bundle size")
    return result


def _name(value:str)->str:
    if (type(value) is not str or not value or "\\" in value
            or "\x00" in value or value.startswith("/")):
        raise PreviewBundleDenied("Unsafe ZIP member name")
    p=PurePosixPath(value)
    if "." in p.parts or ".." in p.parts or len(p.parts)<2 or p.parts[0]!=ROOTNAME:
        raise PreviewBundleDenied("Unsafe preview path")
    return str(p)


def _info(name:str)->zipfile.ZipInfo:
    name=_name(name)
    entry=zipfile.ZipInfo(name,(1980,1,1,0,0,0))
    entry.compress_type=zipfile.ZIP_DEFLATED
    entry.create_system=3
    entry.external_attr=(0o100755 if name.endswith("/start.sh") else 0o100644)<<16
    return entry


def build(source:Path,archive:Path,revision:str)->dict:
    if type(revision) is not str or not REVISION.fullmatch(revision):
        raise PreviewBundleDenied("Exact Git commit SHA required")
    files=_files(source)
    manifest={
        "schema":SCHEMA,"revision":revision,
        "purpose":"interactive local preview only",
        "production_authorized":False,
        "independently_accepted_original_tasks":0,
        "files":[{"path":name,"bytes":len(blob),
                  "sha256":sha256(blob).hexdigest()}
                 for name,blob in sorted(files.items())],
    }
    raw=(json.dumps(manifest,ensure_ascii=False,sort_keys=True,
                    separators=(",",":"))+"\n").encode("utf-8")
    archive=Path(archive)
    if archive.is_symlink() or archive.exists():
        raise PreviewBundleDenied("Refuse to overwrite existing output")
    archive.parent.mkdir(parents=True,exist_ok=True)
    with zipfile.ZipFile(archive,"x",compression=zipfile.ZIP_DEFLATED,
                         compresslevel=9,allowZip64=False) as z:
        for name,blob in sorted({**files,MANIFEST:raw}.items()):
            z.writestr(_info(ROOTNAME+"/"+name),blob,
                       compress_type=zipfile.ZIP_DEFLATED,compresslevel=9)
    return verify(archive)


def verify(archive:Path)->dict:
    archive=Path(archive)
    if archive.is_symlink() or not archive.is_file() or archive.stat().st_size>MAX_UNCOMPRESSED:
        raise PreviewBundleDenied("Missing or oversized preview archive")
    try:
        with zipfile.ZipFile(archive) as z:
            items=z.infolist()
            if not 42<=len(items)<=MAX_FILES:
                raise PreviewBundleDenied("Unexpected ZIP member count")
            all_names=[_name(i.filename) for i in items]
            if len(set(all_names))!=len(all_names):
                raise PreviewBundleDenied("Duplicate ZIP names")
            if any(i.is_dir() or i.file_size>MAX_FILE or i.flag_bits&1
                   or ((i.external_attr>>16)&0o170000) not in (0,0o100000)
                   for i in items):
                raise PreviewBundleDenied("Unexpected ZIP member type")
            manifest_path=ROOTNAME+"/"+MANIFEST
            if all_names.count(manifest_path)!=1:
                raise PreviewBundleDenied("Checksum manifest missing")
            m=json.loads(z.read(manifest_path))
            if (type(m) is not dict or m.get("schema")!=SCHEMA
                    or not REVISION.fullmatch(str(m.get("revision","")))
                    or m.get("production_authorized") is not False
                    or m.get("independently_accepted_original_tasks")!=0
                    or type(m.get("files")) is not list):
                raise PreviewBundleDenied("Unsafe or incorrect manifest")
            listed=set()
            total=0
            for rec in m["files"]:
                if type(rec) is not dict or set(rec)!={"path","bytes","sha256"}:
                    raise PreviewBundleDenied("Invalid member metadata")
                name=_name(ROOTNAME+"/"+rec["path"])
                if name in listed or name==manifest_path:
                    raise PreviewBundleDenied("Duplicate checksum entry")
                listed.add(name)
                if type(rec["bytes"]) is not int or not 0<=rec["bytes"]<=MAX_FILE:
                    raise PreviewBundleDenied("Invalid file length")
                data=z.read(name)
                total+=len(data)
                if (len(data)!=rec["bytes"] or
                        sha256(data).hexdigest()!=rec["sha256"]):
                    raise PreviewBundleDenied("Member SHA-256 mismatch")
            if listed!=set(all_names)-{manifest_path} or total>MAX_UNCOMPRESSED:
                raise PreviewBundleDenied("Unmanifested file or oversized ZIP")
            return {
                "revision":m["revision"],"verified":True,
                "file_count":len(listed),
                "size_bytes":archive.stat().st_size,
                "sha256":sha256(archive.read_bytes()).hexdigest(),
                "production_authorized":False,
            }
    except (OSError,ValueError,KeyError,RuntimeError,
            zipfile.BadZipFile,json.JSONDecodeError) as exc:
        if isinstance(exc,PreviewBundleDenied):
            raise
        raise PreviewBundleDenied("Corrupted or untrusted preview archive") from exc


def smoke(archive:Path)->dict:
    result=verify(archive)
    with tempfile.TemporaryDirectory(prefix="osgard-preview-smoke-") as directory:
        with zipfile.ZipFile(archive) as z:
            z.extractall(directory)
        runner=Path(directory)/ROOTNAME/"run_local.py"
        completed=subprocess.run([sys.executable,str(runner),"--self-test"],
                                  stdout=subprocess.PIPE,stderr=subprocess.PIPE,
                                  text=True,timeout=60,check=False)
        if (completed.returncode!=0 or
                "OSGARD_PREVIEW_SMOKE_PASS" not in completed.stdout):
            raise PreviewBundleDenied("Actual extracted SQLite/API smoke failed")
    return {**result,"smoke":"PASS","public_server_started":False}


def main(argv=None)->int:
    p=argparse.ArgumentParser(description="OSGARD reproducible local preview")
    sub=p.add_subparsers(dest="operation",required=True)
    build_parser=sub.add_parser("build")
    build_parser.add_argument("--source",type=Path,
                              default=Path(__file__).resolve().parent.parent)
    build_parser.add_argument("--output",type=Path,required=True)
    build_parser.add_argument("--revision",required=True)
    for action in ("verify","smoke"):
        parser=sub.add_parser(action)
        parser.add_argument("--archive",type=Path,required=True)
    args=p.parse_args(argv)
    if args.operation=="build":
        result=build(args.source,args.output,args.revision)
    elif args.operation=="verify":
        result=verify(args.archive)
    else:
        result=smoke(args.archive)
    print(json.dumps(result,sort_keys=True))
    return 0


if __name__=="__main__":
    raise SystemExit(main())
