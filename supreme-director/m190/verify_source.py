"""Verify M190 source SHA-256 manifest and strict source inventory."""
from __future__ import annotations

import hashlib
import json
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parent


def main():
    manifest = json.loads((ROOT / 'M190_SOURCE_MANIFEST.json').read_text(encoding='utf-8'))
    assert manifest['schema'] == 'osgard.m190.source-manifest/1'
    expected = manifest['files']
    assert len(expected) >= 7
    for relative, meta in expected.items():
        assert relative and not relative.startswith('/') and '..' not in relative.split('/')
        path = ROOT / relative
        assert path.is_file() and not path.is_symlink(), relative
        data = path.read_bytes()
        assert hashlib.sha256(data).hexdigest() == meta['sha256'], relative
        assert len(data) == meta['bytes'], relative
    actual = {p.relative_to(ROOT).as_posix() for p in ROOT.rglob('*')
              if p.is_file() and '__pycache__' not in p.parts and not p.name.endswith('.pyc')
              and p.name != 'M190_SOURCE_MANIFEST.json'}
    assert actual == set(expected), {'missing': sorted(set(expected)-actual),
                                     'unlisted': sorted(actual-set(expected))}
    print('M190_SOURCE_MANIFEST_PASS', len(expected))
    return 0


if __name__ == '__main__':
    sys.exit(main())
