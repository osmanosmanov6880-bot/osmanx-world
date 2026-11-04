"""Exact source SHA-256 gate for the M193 offline source tree."""
from pathlib import Path
import hashlib
import json

ROOT=Path(__file__).resolve().parent
EXPECTED='osgard.m193.source-manifest/1'

def main():
    data=json.loads((ROOT/'M193_SOURCE_MANIFEST.json').read_text())
    assert data.get('schema')==EXPECTED
    expected=data['files']
    assert isinstance(expected,dict) and len(expected)>=10
    for rel, digest in expected.items():
        p=ROOT/rel
        assert not p.is_symlink() and p.is_file() and p.resolve().is_relative_to(ROOT.resolve()),rel
        assert hashlib.sha256(p.read_bytes()).hexdigest()==digest,rel
    locale=ROOT/'osgard_m193/web/ru.json'
    assert locale.is_file() and not locale.is_symlink(), 'Russian UI locale missing'
    ru=json.loads(locale.read_text(encoding='utf8'))
    assert len(ru)>=80 and 'loginTitle' in ru and 'clients' in ru and 'deals' in ru
    print('M193_SOURCE_VERIFIED',len(expected),'RU_LABELS',len(ru))

if __name__=='__main__':main()
