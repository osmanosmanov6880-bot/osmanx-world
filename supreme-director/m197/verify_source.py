"""Exact source list and digest verifier, usable from any working directory."""
import hashlib
import json
from pathlib import Path

ROOT=Path(__file__).resolve().parent
MANIFEST=ROOT/'M197_SOURCE_MANIFEST.json'

def main():
    info=json.loads(MANIFEST.read_text(encoding='utf-8'))
    assert info['schema']=='osgard.m197.source-manifest/1'
    expected=info['files']
    actual={p.relative_to(ROOT).as_posix() for p in ROOT.rglob('*')
            if p.is_file() and '__pycache__' not in p.parts and p.suffix!='.pyc'
            and p.name not in ('M197_SOURCE_MANIFEST.json','build_manifest.py') and p.suffix not in ('.log','.png','.zip')}
    if actual!=set(expected):
        raise SystemExit(f'M197_SOURCE_INVENTORY_FAIL extra={sorted(actual-set(expected))} missing={sorted(set(expected)-actual)}')
    for rel,sha in expected.items():
        path=ROOT/rel
        if '..' in Path(rel).parts or path.is_symlink() or not path.is_file():
            raise SystemExit('M197_UNSAFE_PATH: '+rel)
        value=hashlib.sha256(path.read_bytes()).hexdigest()
        if value!=sha:
            raise SystemExit('M197_SHA256_MISMATCH: '+rel)
    print('M197_SOURCE_SHA256_PASS:',len(expected),'files')

if __name__=='__main__':main()
