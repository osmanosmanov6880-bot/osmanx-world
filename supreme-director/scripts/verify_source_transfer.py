#!/usr/bin/env python3
"""Verify the M188 source-only transfer by SHA-256. No network or product actions."""
from __future__ import annotations
import hashlib
import json
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1] / "local-kit"
MANIFEST = ROOT / "SOURCE_TRANSFER_MANIFEST.json"
EXPECTED_SOURCE_ZIP_SHA = "e5a25cb74a3f456266f33d8d6330cb127764916e940797f3228f049057a7a436"


def verify():
    obj = json.loads(MANIFEST.read_text(encoding="utf-8"))
    if obj.get("schema") != "osgard.m188.text-source-subset/1":
        raise ValueError("Unknown M188 source manifest schema")
    if obj.get("original_zip_sha256") != EXPECTED_SOURCE_ZIP_SHA:
        raise ValueError("Unexpected original M187 ZIP pin")
    files = obj["files"]
    if len(files) != 129:
        raise ValueError("Expected exactly 129 source files plus manifest")
    named = set(files)
    for name, meta in sorted(files.items()):
        rel = Path(name)
        if rel.is_absolute() or ".." in rel.parts or not name or "\\" in name:
            raise ValueError("Unsafe manifest path: " + name)
        path = ROOT / rel
        if path.is_symlink() or not path.is_file():
            raise ValueError("Missing or symlink source file: " + name)
        if path.stat().st_size != meta["size"]:
            raise ValueError("Size mismatch: " + name)
        actual_sha = hashlib.sha256(path.read_bytes()).hexdigest()
        if actual_sha != meta["sha256"]:
            raise ValueError("SHA-256 mismatch: " + name)
    actual = {
        p.relative_to(ROOT).as_posix()
        for p in ROOT.rglob("*")
        if p.is_file() and "__pycache__" not in p.parts and p.suffix != ".pyc"
    }
    if actual != named | {"SOURCE_TRANSFER_MANIFEST.json"}:
        missing = sorted((named | {"SOURCE_TRANSFER_MANIFEST.json"}) - actual)
        extra = sorted(actual - named - {"SOURCE_TRANSFER_MANIFEST.json"})
        raise ValueError(f"Unlisted or missing files, missing={missing}, extra={extra}")
    return {
        "status": "PASS", "published_text_files": len(actual),
        "files_sha256_verified": len(files),
        "historical_zip_sha256": EXPECTED_SOURCE_ZIP_SHA,
        "product_integrations": 0,
        "original_tasks_independently_accepted": 0,
        "historical_binary_inputs_in_repo": False,
    }


if __name__ == "__main__":
    try:
        print(json.dumps(verify(), ensure_ascii=False, indent=2))
    except (OSError, ValueError, KeyError, json.JSONDecodeError) as err:
        print("M188_SOURCE_VERIFY_FAILED: " + str(err), file=sys.stderr)
        sys.exit(1)
