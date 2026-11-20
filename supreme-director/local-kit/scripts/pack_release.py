#!/usr/bin/env python3
"""Deterministic source-only M182 delivery ZIP; never includes product M181.

Build from project root AFTER all evidence and the local tooling Git bundle
exist. SHA256SUMS lists all members except SHA256SUMS itself.
"""
from __future__ import annotations
import hashlib
from pathlib import Path
import stat
import sys
import zipfile

ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT.parent / "OSGARD_M182_READONLY_INTEGRATION_PACKAGE_2026-10-27.zip"
EXCLUDED_DIRS = {".git", "__pycache__", ".pytest_cache", ".mypy_cache", ".ruff_cache"}
DATE = (2026, 10, 27, 0, 0, 0)


def hexdigest(data):
    return hashlib.sha256(data).hexdigest()


def safe_list():
    sys.path.insert(0, str(ROOT))
    from osgard_m182.core import safe_member_name
    result = []
    for path in ROOT.rglob("*"):
        if any(part in EXCLUDED_DIRS for part in path.relative_to(ROOT).parts):
            continue
        if path.is_symlink():
            raise ValueError(f"refuse symlink: {path}")
        if not path.is_file() or path.name.endswith(".pyc") or path.name == "SHA256SUMS.txt":
            continue
        rel = path.relative_to(ROOT).as_posix()
        if not safe_member_name(rel)[0]:
            raise ValueError(f"refuse unsafe path: {rel}")
        result.append((rel, path))
    return sorted(result)


def build(output=OUTPUT):
    files = safe_list()
    if not any(rel == "evidence/M182_SOURCE_GIT.bundle" for rel, _ in files):
        raise ValueError("Missing separately verified local M182 Git bundle")
    if not any(rel == "evidence/M182_UNITTEST_FINAL.log" for rel, _ in files):
        raise ValueError("Missing real unittest log")
    manifest = "".join(hexdigest(path.read_bytes()) + "  " + name + "\n" for name,path in files)
    (ROOT / "SHA256SUMS.txt").write_text(manifest,encoding="utf-8")
    all_files = files + [("SHA256SUMS.txt",ROOT / "SHA256SUMS.txt")]
    all_files.sort()
    with zipfile.ZipFile(output,"w",compression=zipfile.ZIP_DEFLATED,compresslevel=9,strict_timestamps=True) as z:
        for name,path in all_files:
            info=zipfile.ZipInfo(name,date_time=DATE)
            info.create_system=3
            info.external_attr=(stat.S_IFREG | 0o644) << 16
            info.compress_type=zipfile.ZIP_DEFLATED
            z.writestr(info,path.read_bytes(),compress_type=zipfile.ZIP_DEFLATED,compresslevel=9)
    return {"archive": str(output), "sha256": hexdigest(Path(output).read_bytes()),
            "files":len(all_files), "bytes":Path(output).stat().st_size}

if __name__ == "__main__":
    import json
    print(json.dumps(build(),ensure_ascii=False,sort_keys=True))
