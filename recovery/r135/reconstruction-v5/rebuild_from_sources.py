#!/usr/bin/env python3
"""Rebuild the explicitly reconstructed V5 tree from verified local sources.

Inputs are local directories or ZIP files: use the original R135/R136 delta ZIPs,
the R135 standalone source and the checked-out recovery branch files. This does
not restore the missing original 503 MB archive.
"""
import argparse
import hashlib
import json
import pathlib
import shutil
import tempfile
import zipfile

def digest_stream(stream):
    h = hashlib.sha256()
    for chunk in iter(lambda: stream.read(1024 * 1024), b''):
        h.update(chunk)
    return h.hexdigest()

def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--manifest', required=True, type=pathlib.Path)
    p.add_argument('--source', required=True, action='append', type=pathlib.Path)
    p.add_argument('--out', required=True, type=pathlib.Path)
    a = p.parse_args()
    if a.out.exists():
        p.error('output already exists')
    data = json.loads(a.manifest.read_text(encoding='utf-8'))
    expected = data['files']
    needed = set(expected.values())
    found = {}
    with tempfile.TemporaryDirectory(prefix='osgard-verified-') as tmp:
        cache = pathlib.Path(tmp)
        def record(stream):
            # Stream to a temporary file, then keep only verified expected bytes.
            file = cache / '_candidate'
            with file.open('wb') as dst:
                h = hashlib.sha256()
                while True:
                    block = stream.read(1024 * 1024)
                    if not block:
                        break
                    h.update(block)
                    dst.write(block)
            sha = h.hexdigest()
            if sha in needed and sha not in found:
                target = cache / sha
                file.replace(target)
                found[sha] = target
            else:
                file.unlink()
        for source in a.source:
            if source.is_dir():
                for file in source.rglob('*'):
                    if file.is_symlink() or not file.is_file() or any(x in file.parts for x in ('.godot', '.git', '__pycache__', '.pytest_cache')):
                        continue
                    with file.open('rb') as stream:
                        record(stream)
            elif zipfile.is_zipfile(source):
                with zipfile.ZipFile(source) as z:
                    for entry in z.infolist():
                        if not entry.is_dir():
                            with z.open(entry) as stream:
                                record(stream)
            else:
                p.error('source must be directory or ZIP: ' + str(source))
        missing = [name for name, sha in expected.items() if sha not in found]
        if missing:
            print('Missing verified files (no output was created):')
            print('\n'.join(missing))
            return 1
        a.out.mkdir(parents=True)
        for name, sha in expected.items():
            rel = pathlib.PurePosixPath(name)
            if rel.is_absolute() or '..' in rel.parts or '\\' in name:
                raise ValueError('unsafe manifest path: ' + name)
            dest = a.out.joinpath(*rel.parts)
            dest.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(found[sha], dest)
        print('Verified reconstruction files:', len(expected))
    return 0

if __name__ == '__main__':
    raise SystemExit(main())
