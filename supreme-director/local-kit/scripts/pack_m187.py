"""Build and verify an offline M187 recovery ZIP with checksums for every member."""
from __future__ import annotations
import argparse
import hashlib
import io
import json
from pathlib import Path
import zipfile

BASE = Path(__file__).resolve().parents[1]
IGNORE_DIRS = {'.git', '__pycache__', 'runtime', 'git-inspection', '.pytest_cache', '.godot'}
IGNORE_SUFFIXES = {'.pyc', '.pyo'}
SOURCE_ZIP = 'OSGARD_M186_INTEGRATION_LAB_FINAL_2026-10-28.zip'
MASTER_SHA = '71fdda8231e1cb627a36fa683eaab1c28e4bdff2da9c95e0e6f6df83624a4b6c'


def entries(base):
    for file in sorted(base.rglob('*')):
        if not file.is_file() or file.is_symlink():
            continue
        rel = file.relative_to(base)
        if ('runtime' in rel.parts and rel.name != '.gitkeep') or any(x in (IGNORE_DIRS - {'runtime'}) for x in rel.parts) or file.suffix in IGNORE_SUFFIXES:
            continue
        if rel.as_posix().startswith('evidence/m187/'):
            continue
        yield file, rel.as_posix()


def pack(dest):
    from osgard_m187.plan import recover_master
    plan = recover_master(BASE / 'originals/DIRECTOR_MASTER_180.md')
    raw = {}
    digests = {}
    for file, name in entries(BASE):
        blob = file.read_bytes()
        raw[name] = blob
        digests[name] = hashlib.sha256(blob).hexdigest()
    if digests.get('originals/DIRECTOR_MASTER_180.md') != MASTER_SHA:
        raise ValueError('Original plan hash changed')
    manifest = {
        'schema': 'osgard.m187.verified-local-kit/1',
        'recovered_from': 'OSGARD_M186_INTEGRATION_LAB_FINAL_2026-10-28.zip + DIRECTOR_MASTER_180.md',
        'master_sha256': MASTER_SHA,
        'task_count': plan['counts']['total'],
        'original_dependency_references': plan['counts']['explicit_references_in_this_document'],
        'status': 'LOCAL_RECOVERY_NOT_ORIGINAL_M181',
        'production': 'NO_GO',
        'external_integrations': 0,
        'original_task_acceptance': 0,
        'individual_file_sha256': digests,
    }
    raw['M187_PACKAGE_MANIFEST.json'] = (json.dumps(manifest, ensure_ascii=False, sort_keys=True, indent=2) + '\n').encode('utf-8')
    raw['M187_SHA256SUMS.txt'] = (''.join(hashlib.sha256(blob).hexdigest() + '  ' + name + '\n'
                                    for name, blob in sorted(raw.items()))).encode('utf-8')
    dest.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(dest, 'w', allowZip64=True) as z:
        for name, blob in sorted(raw.items()):
            info = zipfile.ZipInfo(name, (2026, 11, 4, 0, 0, 0))
            info.external_attr = (0o100644 << 16)
            info.compress_type = zipfile.ZIP_STORED if name.endswith('.bundle') else zipfile.ZIP_DEFLATED
            z.writestr(info, blob, compresslevel=6)
    return verify(dest)


def verify(path):
    with zipfile.ZipFile(path) as z:
        manifest = json.loads(z.read('M187_PACKAGE_MANIFEST.json'))
        hashes = {}
        for line in z.read('M187_SHA256SUMS.txt').decode('utf-8').splitlines():
            sha, name = line.split('  ', 1)
            if name in hashes:
                raise ValueError('Duplicate SHA256SUMS entry')
            hashes[name] = sha
        actual = set(z.namelist()) - {'M187_SHA256SUMS.txt'}
        if set(hashes) != actual:
            raise ValueError('ZIP SHA manifest does not describe exact set of entries')
        for name, expected in hashes.items():
            blob = z.read(name)
            if hashlib.sha256(blob).hexdigest() != expected:
                raise ValueError('Wrong member hash: ' + name)
        if not (len(manifest['individual_file_sha256']) == len(actual) - 1):
            raise ValueError('Source member count mismatch')
        if manifest['master_sha256'] != MASTER_SHA or manifest['task_count'] != 180:
            raise ValueError('Source plan pin invalid')
    h = hashlib.sha256()
    with open(path, 'rb') as f:
        while block := f.read(1024 * 1024): h.update(block)
    return {'file': str(path), 'sha256': h.hexdigest(),
            'size_bytes': path.stat().st_size, 'verified_entries': len(hashes),
            'original_task_acceptance': 0}


def main(argv=None):
    a = argparse.ArgumentParser()
    a.add_argument('command', choices=['pack', 'verify'])
    a.add_argument('--out', type=Path, default=Path('/mnt/data/OSGARD_EMPIRE_M187_RECOVERY_FULL_2026-11-04.zip'))
    args = a.parse_args(argv)
    print(json.dumps(pack(args.out) if args.command == 'pack' else verify(args.out), indent=2))

if __name__ == '__main__':
    main()
