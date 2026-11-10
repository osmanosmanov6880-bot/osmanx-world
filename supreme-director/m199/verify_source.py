"""Independent M199 deterministic SHA-256 file inventory check."""
from pathlib import Path
import hashlib
import json

root = Path(__file__).resolve().parent
manifest = json.loads((root / 'M199_SOURCE_MANIFEST.json').read_text(encoding='utf-8'))
assert manifest['schema'] == 'osgard.m199.source-manifest/1'
listed = manifest['files']
assert isinstance(listed, dict) and listed
actual = {p.relative_to(root).as_posix() for p in root.rglob('*')
          if p.is_file() and p.name != 'M199_SOURCE_MANIFEST.json'
          and '__pycache__' not in p.parts and p.suffix != '.pyc'}
assert actual == set(listed), {'unexpected': sorted(actual - set(listed)),
                                'missing': sorted(set(listed) - actual)}
for rel, expected in listed.items():
    assert rel.startswith(('osgard_m199/', 'tests/', 'docs/')) or rel in ('README.md', 'pyproject.toml', 'smoke.py', 'verify_source.py', 'build_manifest.py', 'M199_RELEASE_GATE_RU.md'), rel
    assert '..' not in Path(rel).parts, rel
    path = root / rel
    assert hashlib.sha256(path.read_bytes()).hexdigest() == expected, rel
print('M199_SOURCE_SHA256_PASS:', len(listed))
