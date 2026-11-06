"""Validate the exact source inventory against this module's SHA-256 manifest."""
import hashlib
import json
from pathlib import Path

root=Path(__file__).parent.resolve()
manifest=json.loads((root/'M192_SOURCE_MANIFEST.json').read_text())
assert manifest['schema']=='osgard.m192.source-manifest/1'
found={p.relative_to(root).as_posix() for p in root.rglob('*')
       if p.is_file() and '__pycache__' not in p.parts and p.suffix != '.pyc'
       and p.name not in ('M192_SOURCE_MANIFEST.json','test-results.txt')}
expected=set(manifest['files'])
assert found==expected, {'missing':sorted(expected-found),'extra':sorted(found-expected)}
for relative,sha in manifest['files'].items():
    assert '..' not in relative.split('/') and not relative.startswith('/')
    f=root/relative
    assert f.is_file() and not f.is_symlink()
    assert hashlib.sha256(f.read_bytes()).hexdigest()==sha,relative
print('M192_SOURCE_INTEGRITY_PASS',len(found),'files')
