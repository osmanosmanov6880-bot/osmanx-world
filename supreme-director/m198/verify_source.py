"""Verify exact M198 source inventory and SHA-256; manifest excludes itself."""
import hashlib
import json
from pathlib import Path

BASE=Path(__file__).resolve().parent
MANIFEST=BASE/'M198_SOURCE_MANIFEST.json'


def main():
    manifest=json.loads(MANIFEST.read_text(encoding='utf-8'))
    assert manifest.get('schema')=='osgard.m198.source-manifest/1'
    expected=manifest['files']
    actual={p.relative_to(BASE).as_posix() for p in BASE.rglob('*') if p.is_file()
      and p.name!='M198_SOURCE_MANIFEST.json' and '__pycache__' not in p.parts
      and not p.name.endswith('.pyc')}
    assert actual==set(expected),{'missing':sorted(set(expected)-actual),'extra':sorted(actual-set(expected))}
    for path,digest in expected.items():
        assert hashlib.sha256((BASE/path).read_bytes()).hexdigest()==digest,path
    print('M198_SOURCE_VERIFY_PASS',len(expected),'files')


if __name__=='__main__':main()
