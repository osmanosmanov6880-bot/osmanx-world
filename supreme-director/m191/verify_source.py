"""Verify exact M191 text-source inventory and SHA-256 without running source code."""
from __future__ import annotations
import hashlib
import json
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parent
MANIFEST = ROOT / "M191_SOURCE_MANIFEST.json"


def verify() -> int:
    data = json.loads(MANIFEST.read_text(encoding="utf-8"))
    assert data["schema"] == "osgard.m191.source-inventory/1"
    expected = data["files"]
    actual = {p.relative_to(ROOT).as_posix(): p for p in ROOT.rglob("*")
              if p.is_file() and not p.is_symlink() and p.name != MANIFEST.name
              and "__pycache__" not in p.parts and not p.name.endswith(".pyc")}
    assert set(actual) == set(expected), f"Inventory drift: missing={set(expected)-set(actual)} extra={set(actual)-set(expected)}"
    for name, p in actual.items():
        assert not name.startswith("/") and ".." not in Path(name).parts and "\\" not in name
        assert hashlib.sha256(p.read_bytes()).hexdigest() == expected[name], name
    print("M191_SOURCE_VERIFY_PASS", len(actual), "files")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(verify())
    except (ValueError, AssertionError, OSError, json.JSONDecodeError) as e:
        print("M191_SOURCE_VERIFY_FAILED", str(e), file=sys.stderr)
        sys.exit(2)
