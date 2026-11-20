"""Deterministic exact local inventory verifier for M196 sources."""
from __future__ import annotations
from hashlib import sha256
import json
from pathlib import Path

root=Path(__file__).resolve().parent
manifest=json.loads((root/'M196_SOURCE_MANIFEST.json').read_text(encoding='utf-8'))
assert manifest['schema']=='osgard.m196.source-manifest/1'
expected=manifest['files']
actual={p.relative_to(root).as_posix() for p in root.rglob('*')
        if p.is_file() and '__pycache__' not in p.parts and p.suffix != '.pyc'
        and p.name not in ('M196_SOURCE_MANIFEST.json','modify_ui.py','build_manifest.py','m196-test-retry.log')}
# Browser smoke, all source, docs, tests, and verifier included.
assert set(expected)==actual, {'missing':sorted(set(expected)-actual),'unexpected':sorted(actual-set(expected))}
for relative,identity in expected.items():
    p=root/relative
    assert not p.is_symlink(),relative
    assert p.stat().st_size == identity['bytes'],relative
    assert sha256(p.read_bytes()).hexdigest()==identity['sha256'],relative
print('M196_MANIFEST_PASS:',len(expected),'files')
