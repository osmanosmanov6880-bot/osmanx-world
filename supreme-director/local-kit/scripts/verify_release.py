#!/usr/bin/env python3
"""Standalone SHA256SUMS/ZIP verifier. Never extracts or runs bundle code."""
from __future__ import annotations
import hashlib
from pathlib import Path
import re
import stat
import sys
import zipfile

ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT))
from osgard_m182.core import safe_member_name


def verify(path):
    p=Path(path)
    if not p.is_file() or p.is_symlink():
        raise ValueError("ZIP missing or symlink")
    with zipfile.ZipFile(p,"r") as z:
        infos=z.infolist()
        names=[i.filename for i in infos]
        if not names or len(names)!=len(set(n.casefold() for n in names)):
            raise ValueError("missing or duplicate entries")
        for i in infos:
            if not safe_member_name(i.filename)[0] or i.is_dir() or (i.flag_bits & 1):
                raise ValueError("unsafe path, directory or encryption")
            ftype=stat.S_IFMT(i.external_attr>>16) if i.create_system==3 else 0
            if ftype not in (0,stat.S_IFREG):
                raise ValueError("nonregular member")
        if "SHA256SUMS.txt" not in names:
            raise ValueError("manifest absent")
        manifest=z.read("SHA256SUMS.txt").decode("utf-8")
        entries={}
        for line in manifest.splitlines():
            if not line:
                continue
            m=re.fullmatch(r"([0-9a-f]{64})  (.+)",line)
            if not m or m[2] in entries:
                raise ValueError("malformed or duplicate manifest line")
            entries[m[2]]=m[1]
        if set(entries) != set(names)-{"SHA256SUMS.txt"}:
            raise ValueError("manifest does not cover exact archive members")
        for name,digest in entries.items():
            calc=hashlib.sha256(z.read(name)).hexdigest()
            if calc!=digest:
                raise ValueError("modified payload: "+name)
        if not z.read("evidence/ADMISSION_RESULT.json").find(b'"release_decision": "PRODUCTION_NO_GO"')>=0:
            raise ValueError("NO-GO receipt missing")
    return {"status":"BYTE_INTEGRITY_PASS","file_count":len(names),
            "archive_sha256":hashlib.sha256(p.read_bytes()).hexdigest(),
            "release_authorization":"NOT_GRANTED"}

if __name__=="__main__":
    import json
    target=Path(sys.argv[1]) if len(sys.argv)>1 else ROOT.parent/"OSGARD_M182_READONLY_INTEGRATION_PACKAGE_2026-10-27.zip"
    print(json.dumps(verify(target),sort_keys=True))
