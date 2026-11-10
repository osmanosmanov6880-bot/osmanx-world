"""TITAN-X25 local static preview: offline build, manifest and re-verification.

No HTTP server, host deployment, CI publish, payment, CDN or external resource.
Directory creation refuses to replace any existing preview.
"""
from __future__ import annotations
import argparse
from hashlib import sha256
import json
import os
from pathlib import Path
import re
import shutil
import sys
from typing import Mapping,Any

from .builder import render_site,validate_site_spec
from .contracts import canonical,digest

PREVIEW_SCHEMA="osgard.original180.offline-preview/1"
_NAME=re.compile(r"^[a-z][a-z0-9-]{0,39}$")
_MAX_PREVIEW_FILES=12
_MAX_FILE=128*1024
_MANIFEST="PREVIEW_MANIFEST.json"

class PreviewDenied(ValueError):
    pass

def _directory(path:Path):
    if path.is_symlink() or not path.is_dir():
        raise PreviewDenied("Required preview directory is missing or symbolic link")

def _file_ok(path:Path):
    if path.is_symlink() or not path.is_file():
        raise PreviewDenied("Missing or unsafe preview file")

def write_preview(spec:dict,parent:Path,folder:str,*,
                  datasets:Mapping[str,list[dict]]|None=None)->dict:
    """Write isolated, new static preview; file hashes are deterministic."""
    if type(folder) is not str or not _NAME.fullmatch(folder):
        raise PreviewDenied("Preview folder must be a safe slug")
    parent=Path(parent)
    _directory(parent)
    normalized=validate_site_spec(spec)
    rendered=render_site(normalized,datasets=datasets)
    if not rendered or len(rendered)>_MAX_PREVIEW_FILES:
        raise PreviewDenied("Unsafe preview page count")
    if any(not name.endswith(".html") or "/" in name or ".." in name
           or len(blob)>_MAX_FILE for name,blob in rendered.items()):
        raise PreviewDenied("Unsafe rendered page")
    manifest={
        "schema":PREVIEW_SCHEMA,
        "tenant_id":normalized["tenant_id"],
        "project_id":normalized["project_id"],
        "spec_sha256":digest(normalized),
        "files":[{"path":name,"bytes":len(blob),
                  "sha256":sha256(blob).hexdigest()}
                 for name,blob in sorted(rendered.items())],
        "network_requested":False,
        "production_published":False
    }
    target=parent/folder
    if target.exists() or target.is_symlink():
        raise PreviewDenied("Refuse to overwrite a preview directory")
    target.mkdir(mode=0o700)
    written=[]
    try:
        for name,blob in sorted(rendered.items()):
            file=target/name
            with file.open("xb") as stream:
                stream.write(blob)
                stream.flush()
                os.fsync(stream.fileno())
            written.append(file)
        metadata=target/_MANIFEST
        with metadata.open("xb") as stream:
            stream.write(canonical(manifest)+b"\n")
            stream.flush()
            os.fsync(stream.fileno())
        written.append(metadata)
        report=verify_preview(target,expected_spec_sha256=manifest["spec_sha256"])
        return {"directory":str(target),"files":report["files"],
                "manifest_sha256":report["manifest_sha256"],
                "production_published":False,"offline_only":True}
    except BaseException:
        # Only remove our own newly-created build paths; never delete an
        # existing target or unrelated files that another process created.
        for file in reversed(written):
            if file.is_file() and not file.is_symlink():
                file.unlink()
        try:target.rmdir()
        except OSError:pass
        raise

def verify_preview(folder:Path,*,expected_spec_sha256:str|None=None)->dict:
    """Read-only integrity check for exactly the signed-list-of-files bytes."""
    folder=Path(folder)
    _directory(folder)
    manifest_path=folder/_MANIFEST
    _file_ok(manifest_path)
    try:
        content=manifest_path.read_bytes()
        if len(content)>8192:raise PreviewDenied("Excessive manifest")
        manifest=json.loads(content.decode("utf-8"))
    except (ValueError,UnicodeError,OSError) as exc:
        raise PreviewDenied("Unreadable or noncanonical preview manifest") from exc
    if (type(manifest) is not dict or set(manifest)!={"schema","tenant_id",
            "project_id","spec_sha256","files","network_requested","production_published"}
            or manifest["schema"]!=PREVIEW_SCHEMA
            or manifest["network_requested"] is not False
            or manifest["production_published"] is not False
            or type(manifest["files"]) is not list
            or not 1<=len(manifest["files"])<=_MAX_PREVIEW_FILES
            or content!=canonical(manifest)+b"\n"):
        raise PreviewDenied("Invalid or modified preview manifest")
    if type(manifest["spec_sha256"]) is not str or len(manifest["spec_sha256"])!=64:
        raise PreviewDenied("Invalid source digest")
    if expected_spec_sha256 is not None and expected_spec_sha256!=manifest["spec_sha256"]:
        raise PreviewDenied("Unexpected specification identity")
    files={}
    for row in manifest["files"]:
        if (type(row) is not dict or set(row)!={"path","bytes","sha256"}
            or type(row["path"]) is not str or not _NAME.fullmatch(
                row["path"][:-5] if row["path"].endswith(".html") else "")
            or type(row["bytes"]) is not int or row["bytes"]<1 or row["bytes"]>_MAX_FILE
            or type(row["sha256"]) is not str or len(row["sha256"])!=64
            or row["path"] in files):
            raise PreviewDenied("Unsafe/duplicate preview file declaration")
        page=folder/row["path"]
        _file_ok(page)
        blob=page.read_bytes()
        if len(blob)!=row["bytes"] or sha256(blob).hexdigest()!=row["sha256"]:
            raise PreviewDenied("Preview bytes differ from manifest")
        if (b'default-src &#39;none&#39;' not in blob
                or b'<meta name="robots" content="noindex,nofollow">' not in blob
                or b'<script' in blob.lower()):
            raise PreviewDenied("Required static preview security policy missing")
        files[row["path"]]=row
    actual={p.name for p in folder.iterdir()}
    if actual!=set(files)|{_MANIFEST}:
        raise PreviewDenied("Unexpected or missing preview files")
    return {"schema":PREVIEW_SCHEMA,"files":len(files),
            "manifest_sha256":sha256(content).hexdigest(),
            "spec_sha256":manifest["spec_sha256"],
            "integrity_verified":True,
            "external_resources_verified":False,
            "production_published":False}

def main(argv=None)->int:
    parser=argparse.ArgumentParser(description="Create or verify offline static site preview")
    subs=parser.add_subparsers(dest="command",required=True)
    build=subs.add_parser("build")
    build.add_argument("spec",type=Path)
    build.add_argument("parent",type=Path)
    build.add_argument("name")
    verify=subs.add_parser("verify")
    verify.add_argument("folder",type=Path)
    args=parser.parse_args(argv)
    try:
        if args.command=="build":
            spec=json.loads(args.spec.read_text(encoding="utf-8"))
            report=write_preview(spec,args.parent,args.name)
        else:report=verify_preview(args.folder)
        print(json.dumps(report,sort_keys=True))
        return 0
    except (ValueError,OSError) as exc:
        print("PREVIEW_DENIED: "+str(exc),file=sys.stderr)
        return 2

if __name__=="__main__":
    raise SystemExit(main())
