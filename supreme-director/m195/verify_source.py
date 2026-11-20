"""Verify exact M195 portable source inventory and SHA-256 before running code."""
from hashlib import sha256
import json
from pathlib import Path, PurePosixPath

ROOT=Path(__file__).resolve().parent

def verify():
    manifest=json.loads((ROOT/'M195_SOURCE_MANIFEST.json').read_text(encoding='utf-8'))
    if manifest.get('schema')!='osgard.m195.source-manifest/1':raise ValueError('unknown manifest')
    expected=manifest.get('files')
    if not isinstance(expected,dict) or not expected:raise ValueError('empty inventory')
    listed=set()
    for name,sha in expected.items():
        if (not isinstance(name,str) or '\\' in name or PurePosixPath(name).is_absolute()
                or any(s in ('','.','..') for s in name.split('/'))):
            raise ValueError('unsafe path: '+str(name))
        p=ROOT.joinpath(*PurePosixPath(name).parts)
        if p.is_symlink() or not p.is_file():raise ValueError('source missing or symlink: '+name)
        if sha256(p.read_bytes()).hexdigest()!=sha:raise ValueError('SHA mismatch: '+name)
        listed.add(name)
    actual={str(p.relative_to(ROOT)).replace('\\','/') for p in ROOT.rglob('*')
            if p.is_file() and '__pycache__' not in p.parts and p.suffix!='.pyc'
            and p.name not in ('test_run.log','regression_m192.log','regression_m193.log','regression_m194.log')
            and not p.name.endswith('.png') and p.name!='make_ui.py'
            and p.name!='M195_SOURCE_MANIFEST.json'}
    if listed!=actual:raise ValueError('inventory mismatch: '+repr(sorted(listed^actual)))
    return {'status':'PASS','verified_files':len(listed),'schema':manifest['schema']}

if __name__=='__main__':print(json.dumps(verify(),ensure_ascii=False))
