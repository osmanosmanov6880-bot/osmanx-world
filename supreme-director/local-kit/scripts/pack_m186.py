"""Deterministic, path-safe archive of M186 local integration reference lab, not production release."""
from __future__ import annotations
import argparse
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import subprocess
import tempfile
import zipfile

PARENT_SHA = '9cb812ff6fb4a744c316cc1d5b6e5776849892194db85dcbe3d49b2f265771a3'
SAFE = re.compile(r'[A-Za-z0-9_.@/+ -]+\Z')
MAX_FILE_BYTES = 160_000_000
MAX_FILES = 800
MAX_TOTAL_UNCOMPRESSED = 440_000_000


def digest(data):
    return hashlib.sha256(data).hexdigest()


def rel_check(name):
    if not isinstance(name, str) or not name or not SAFE.fullmatch(name) or '\\' in name:
        raise ValueError('unsafe archive path')
    p = PurePosixPath(name)
    if p.is_absolute() or name.startswith('./') or any(x in ('', '.', '..') for x in name.split('/')) or '.git' in p.parts:
        raise ValueError('archive traversal or metadata path')
    return name


def artifact_bytes(files):
    if not isinstance(files, dict) or not 1 <= len(files) <= MAX_FILES:
        raise ValueError('invalid payload count')
    total = 0
    output = {}
    for name, data in files.items():
        rel_check(name)
        if name in {'MANIFEST.json', 'SHA256SUMS.txt'} or not isinstance(data, bytes) or len(data) > MAX_FILE_BYTES:
            raise ValueError('reserved path or oversized payload')
        total += len(data)
        if total > MAX_TOTAL_UNCOMPRESSED:
            raise ValueError('excessive payload size')
        output[name] = data
    if 'README.md' not in output or 'osgard_m186/contracts.py' not in output or 'tests/test_m186.py' not in output:
        raise ValueError('required source missing')
    manifest = {
        'schema': 'osgard.m186.local-archive/1',
        'authority': 'LOCAL_TOOLING_ONLY',
        'product_production': 'NO_GO',
        'files': [{'path': name, 'size': len(data), 'sha256': digest(data)} for name, data in sorted(output.items())],
    }
    output['MANIFEST.json'] = (json.dumps(manifest, sort_keys=True, indent=2) + '\n').encode('utf8')
    sums = '\n'.join(digest(output[k]) + '  ' + k for k in sorted(output)) + '\n'
    output['SHA256SUMS.txt'] = sums.encode('utf8')
    return output


def pack_files(files, target):
    data = artifact_bytes(files)
    target = Path(target)
    target.parent.mkdir(parents=True, exist_ok=True)
    fd, temp = tempfile.mkstemp(prefix='m186-', suffix='.zip', dir=str(target.parent))
    os.close(fd)
    try:
        with zipfile.ZipFile(temp, 'w', compression=zipfile.ZIP_DEFLATED, compresslevel=9, allowZip64=True) as archive:
            for name in sorted(data):
                info = zipfile.ZipInfo(name, date_time=(2020, 1, 1, 0, 0, 0))
                info.compress_type = zipfile.ZIP_DEFLATED
                info.create_system = 3
                info.external_attr = (0o644 << 16)
                info.flag_bits = 0x800
                archive.writestr(info, data[name], compress_type=zipfile.ZIP_DEFLATED, compresslevel=9)
        report = verify_zip(temp)
        if report['status'] != 'LOCAL_ARCHIVE_VERIFIED':
            raise ValueError('local self-verification failed')
        os.replace(temp, target)
        return {**report, 'sha256': digest(target.read_bytes()), 'bytes': target.stat().st_size}
    finally:
        if os.path.exists(temp):
            os.unlink(temp)


def verify_zip(path):
    try:
        with zipfile.ZipFile(path, 'r') as z:
            files = z.infolist()
            if not 3 <= len(files) <= MAX_FILES + 2:
                raise ValueError('invalid member count')
            names = [rel_check(f.filename) for f in files]
            if len(set(names)) != len(names) or z.testzip() is not None:
                raise ValueError('duplicate or corrupt members')
            if any(f.is_dir() or ((f.external_attr >> 16) & 0o170000) == 0o120000 for f in files):
                raise ValueError('directory or symlink')
            if sum(f.file_size for f in files) > MAX_TOTAL_UNCOMPRESSED + 2_000_000:
                raise ValueError('oversized archive')
            if 'SHA256SUMS.txt' not in names or 'MANIFEST.json' not in names:
                raise ValueError('missing manifest')
            manifest = json.loads(z.read('MANIFEST.json'))
            if manifest.get('schema') != 'osgard.m186.local-archive/1' or manifest.get('product_production') != 'NO_GO':
                raise ValueError('manifest schema/release mismatch')
            expected = {x['path']: x for x in manifest['files']}
            if len(expected) != len(manifest['files']):
                raise ValueError('duplicate manifest entry')
            if set(expected) != set(names) - {'MANIFEST.json', 'SHA256SUMS.txt'}:
                raise ValueError('manifest member mismatch')
            for name, record in expected.items():
                data = z.read(name)
                if digest(data) != record['sha256'] or len(data) != record['size']:
                    raise ValueError('file checksum mismatch')
            sums = z.read('SHA256SUMS.txt').decode('utf8').splitlines()
            checksum_dict = {}
            for line in sums:
                if len(line) < 67 or line[64:66] != '  ' or not re.fullmatch('[0-9a-f]{64}', line[:64]):
                    raise ValueError('invalid checksum line')
                key = line[66:]
                if key in checksum_dict:
                    raise ValueError('duplicate checksum line')
                checksum_dict[key] = line[:64]
            if set(checksum_dict) != set(names) - {'SHA256SUMS.txt'} or any(digest(z.read(k)) != h for k,h in checksum_dict.items()):
                raise ValueError('checksum list invalid')
            return {'status': 'LOCAL_ARCHIVE_VERIFIED', 'files': len(names),
                    'not_six_product_integration': True, 'production': 'NO_GO'}
    except (OSError, zipfile.BadZipFile, UnicodeError, json.JSONDecodeError, KeyError, TypeError) as exc:
        raise ValueError('invalid local archive: ' + type(exc).__name__) from exc


def build_payload(root, additions=()):
    root = Path(root).resolve(strict=True)
    source_checksums = {}
    if (root / '.git').is_dir() or (root / '.git').is_file():
        committed = subprocess.check_output(['git', 'ls-files', '-z'], cwd=root).split(b'\x00')
        base_paths = {x.decode('utf8') for x in committed if x}
    elif (root / 'MANIFEST.json').is_file():
        # A distributed source ZIP has no .git. Use its verified manifest as
        # the deterministic member catalog, and independently re-hash files.
        manifest = json.loads((root / 'MANIFEST.json').read_text('utf8'))
        if manifest.get('schema') != 'osgard.m186.local-archive/1':
            raise ValueError('extracted archive manifest schema invalid')
        entries = manifest.get('files')
        if not isinstance(entries, list) or not 1 <= len(entries) <= MAX_FILES:
            raise ValueError('invalid unpacked file list')
        source_checksums = {row['path']: row['sha256'] for row in entries}
        if len(source_checksums) != len(entries):
            raise ValueError('duplicate unpacked manifest paths')
        base_paths = set(source_checksums)
    else:
        raise ValueError('no Git working tree or verified unpacked manifest')
    paths = sorted(base_paths | set(additions))
    payload = {}
    for rel in paths:
        rel_check(rel)
        file = root / rel
        if not file.exists() or not file.is_file() or file.is_symlink():
            raise ValueError('unsafe or missing tracked file: ' + rel)
        file.resolve(strict=True).relative_to(root)
        if file.stat().st_size > MAX_FILE_BYTES:
            raise ValueError('oversized file: ' + rel)
        payload[rel] = file.read_bytes()
        if rel in source_checksums and digest(payload[rel]) != source_checksums[rel]:
            raise ValueError('unpacked source member digest mismatch: ' + rel)
    provenance=json.loads(payload['evidence/m186/PARENT_M185_SOURCE_CONTINUITY.json'])
    if (provenance.get('parent_sha256')!=PARENT_SHA or
        provenance.get('unchanged_parent_members')!=153 or
        provenance.get('original_m181_verified') is not False or
        provenance.get('production_authorized') is not False):
        raise ValueError('M185 parent source continuity receipt missing or impossible')
    return payload


def main():
    p=argparse.ArgumentParser()
    p.add_argument('--source',required=True)
    p.add_argument('--out',required=True)
    p.add_argument('--extra',action='append',default=[])
    args=p.parse_args()
    result=pack_files(build_payload(args.source, args.extra),args.out)
    print(json.dumps(result,sort_keys=True))

if __name__=='__main__':main()
