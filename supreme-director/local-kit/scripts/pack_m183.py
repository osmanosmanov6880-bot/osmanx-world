"""Deterministic M183 engineering ZIP and source SHA-256 manifest.

No source execution, no extraction, no network, no production deploy.
Emits a separate download checksum outside the packed tree to avoid recursion.
"""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import stat
import zipfile

from osgard_m182.core import safe_member_name

EXCLUDED_DIRS = {'.git','__pycache__','.pytest_cache','.mypy_cache','.ruff_cache'}
EXCLUDED_FILENAMES = {'SHA256SUMS.txt'}
FIXED_TIME = (2026,10,27,0,0,0)


def sha256(data):
    return hashlib.sha256(data).hexdigest()


def sources(root):
    root = Path(root)
    if root.is_symlink() or not root.is_dir():
        raise ValueError('Existing non-symlink source directory required')
    members = {}
    for file in root.rglob('*'):
        if any(x in EXCLUDED_DIRS for x in file.relative_to(root).parts) or file.name in EXCLUDED_FILENAMES:
            continue
        if file.is_symlink():
            raise ValueError('Symlink not allowed in release tree')
        if not file.is_file():
            continue
        name = file.relative_to(root).as_posix()
        if not safe_member_name(name)[0] or name in members:
            raise ValueError('Unsafe or duplicate source member')
        if file.stat().st_size > 200_000_000:
            raise ValueError('File exceeds pack limit')
        members[name] = file.read_bytes()
    if not members:
        raise ValueError('No release files')
    return members


def make_manifest(members):
    # Manifest records all packed files except its own non-self-hash entry.
    return ''.join(f'{sha256(data)}  {name}\n' for name,data in sorted(members.items()))


def build(root, out):
    root, out = Path(root), Path(out)
    if out.exists():
        raise FileExistsError(str(out))
    members = sources(root)
    manifest = make_manifest(members)
    manifest_bytes = manifest.encode('utf-8')
    members['SHA256SUMS.txt'] = manifest_bytes
    with out.open('xb') as dst:
        with zipfile.ZipFile(dst,'w',compression=zipfile.ZIP_DEFLATED,compresslevel=6,allowZip64=False) as z:
            for name,data in sorted(members.items()):
                info=zipfile.ZipInfo(name,date_time=FIXED_TIME)
                info.create_system=3
                info.external_attr=(stat.S_IFREG|0o644)<<16
                info.compress_type=zipfile.ZIP_DEFLATED
                z.writestr(info,data,compress_type=zipfile.ZIP_DEFLATED,compresslevel=6)
    verify(out)
    return {'archive':str(out),'size_bytes':out.stat().st_size,
            'sha256':sha256(out.read_bytes()),'files':len(members)}


def verify(path):
    with zipfile.ZipFile(path) as z:
        names=z.namelist()
        if len(names)!=len(set(names)) or 'SHA256SUMS.txt' not in names or z.testzip():
            raise ValueError('Archive CRC/list invalid')
        manifest=z.read('SHA256SUMS.txt').decode('utf-8')
        map_hash={}
        for line in manifest.splitlines():
            digest,sep,name=line.partition('  ')
            if not sep or len(digest)!=64 or name in map_hash or not safe_member_name(name)[0]:
                raise ValueError('Bad manifest row')
            map_hash[name]=digest
        if set(map_hash)!=(set(names)-{'SHA256SUMS.txt'}):
            raise ValueError('Missing or extra archive members')
        for name in map_hash:
            if sha256(z.read(name))!=map_hash[name]:
                raise ValueError('Mismatched source bytes')
        return {'verified':True,'files':len(names),'sha256':sha256(Path(path).read_bytes())}


def main(argv=None):
    p=argparse.ArgumentParser(description='Create/verify M183 deterministic local engineering archive')
    sub=p.add_subparsers(dest='command',required=True)
    x=sub.add_parser('build');x.add_argument('--source',required=True);x.add_argument('--out',required=True)
    y=sub.add_parser('verify');y.add_argument('--archive',required=True)
    a=p.parse_args(argv)
    d=build(a.source,a.out) if a.command=='build' else verify(a.archive)
    print(json.dumps(d,ensure_ascii=False,sort_keys=True))
    return 0

if __name__=='__main__':
    raise SystemExit(main())
