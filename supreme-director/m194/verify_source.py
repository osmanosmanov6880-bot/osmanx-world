"""Check exact, reproducible M194 text source SHA-256 manifest."""
from hashlib import sha256
from pathlib import Path
import json

HERE=Path(__file__).resolve().parent
MANIFEST=HERE/'M194_SOURCE_MANIFEST.json'


def verify():
    data=json.loads(MANIFEST.read_text(encoding='utf-8'))
    assert data['schema']=='osgard.m194.source-manifest/1'
    expected=data['files']
    actual=set()
    for path in HERE.rglob('*'):
        if (not path.is_file() or '__pycache__' in path.parts or path.suffix=='.pyc'
                or path.name=='M194_SOURCE_MANIFEST.json'):
            continue
        if path.name=='patch_ui.py':
            continue
        rel=path.relative_to(HERE).as_posix()
        actual.add(rel)
    assert actual==set(expected),f'Unexpected or missing files: {actual ^ set(expected)}'
    for rel,record in expected.items():
        assert not rel.startswith('/') and '..' not in Path(rel).parts
        raw=(HERE/rel).read_bytes()
        assert len(raw)==record['bytes'],f'Length mismatch: {rel}'
        assert sha256(raw).hexdigest()==record['sha256'],f'SHA mismatch: {rel}'
    return len(expected)


if __name__=='__main__':
    print('M194_SOURCE_VERIFY_PASS:',verify(),'files')
