#!/usr/bin/env python3
"""Audit candidate R134/R135 source archives against original SHA-256 manifests.

This tool reads bytes; it never extracts archives, executes included code or
claims reconstruction from filenames alone. Nested ZIPs are scanned with limits.
"""
import argparse
import hashlib
import io
import json
import pathlib
import zipfile

EMPTY_SHA = hashlib.sha256(b'').hexdigest()


def sha_stream(stream):
    h = hashlib.sha256()
    while chunk := stream.read(1024 * 1024):
        h.update(chunk)
    return h.hexdigest()


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--manifest', required=True, type=pathlib.Path)
    p.add_argument('--source', required=True, action='append', type=pathlib.Path)
    p.add_argument('--output', required=True, type=pathlib.Path)
    p.add_argument('--nested-depth', type=int, default=2)
    p.add_argument('--max-nested-mb', type=int, default=300)
    p.add_argument('--max-entry-mb', type=int, default=1024)
    p.add_argument('--require-complete', action='store_true')
    a = p.parse_args()
    manifest = json.loads(a.manifest.read_text(encoding='utf-8'))
    families = ('baseline_sha256_files', 'target_sha256_files', 'payload_sha256_files')
    for family in families:
        if not isinstance(manifest.get(family), dict):
            p.error('missing SHA-256 dictionary: ' + family)
    expected = {}
    for family in families:
        for path, sha in manifest[family].items():
            if len(sha) != 64:
                p.error('invalid SHA-256 for ' + path)
            expected.setdefault(sha, []).append((family, path))
    matches = {}
    stats = {'scanned_files': 0, 'scanned_nested_zips': 0, 'skipped_large_files': 0}
    warnings = []
    seen_zips = set()

    def record(label, sha, size):
        if sha in expected:
            matches.setdefault(sha, {'bytes': size, 'locations': [], 'expected': expected[sha]})
            if len(matches[sha]['locations']) < 10:
                matches[sha]['locations'].append(label)

    def scan_zip(z, label, depth=0):
        for entry in z.infolist():
            if entry.is_dir():
                continue
            name = label + '::' + entry.filename
            if entry.file_size > a.max_entry_mb * 1024 * 1024:
                stats['skipped_large_files'] += 1
                warnings.append('Oversized entry skipped: ' + name)
                continue
            try:
                is_nested = (depth < a.nested_depth
                             and entry.filename.lower().endswith('.zip')
                             and entry.file_size <= a.max_nested_mb * 1024 * 1024)
                if is_nested:
                    with z.open(entry) as src:
                        data = src.read()
                    sha = hashlib.sha256(data).hexdigest()
                    record(name, sha, len(data))
                    stats['scanned_files'] += 1
                    if sha not in seen_zips and zipfile.is_zipfile(io.BytesIO(data)):
                        seen_zips.add(sha)
                        stats['scanned_nested_zips'] += 1
                        with zipfile.ZipFile(io.BytesIO(data)) as child:
                            scan_zip(child, name, depth + 1)
                else:
                    with z.open(entry) as src:
                        sha = sha_stream(src)
                    stats['scanned_files'] += 1
                    record(name, sha, entry.file_size)
            except (OSError, RuntimeError, ValueError, zipfile.BadZipFile) as e:
                warnings.append('Cannot inspect ' + name + ': ' + str(e))

    for source in a.source:
        if not source.exists():
            p.error('source missing: ' + str(source))
        if source.is_dir():
            for path in sorted(source.rglob('*')):
                if not path.is_file() or path.is_symlink():
                    continue
                if path.stat().st_size > a.max_entry_mb * 1024 * 1024:
                    stats['skipped_large_files'] += 1
                    continue
                if zipfile.is_zipfile(path):
                    with zipfile.ZipFile(path) as z:
                        scan_zip(z, str(path))
                else:
                    with path.open('rb') as f:
                        h = sha_stream(f)
                    stats['scanned_files'] += 1
                    record(str(path), h, path.stat().st_size)
        elif zipfile.is_zipfile(source):
            with zipfile.ZipFile(source) as z:
                scan_zip(z, str(source))
        else:
            with source.open('rb') as f:
                h = sha_stream(f)
            stats['scanned_files'] += 1
            record(str(source), h, source.stat().st_size)

    with a.manifest.open('rb') as f:
        manifest_sha = sha_stream(f)
    report = {'schema': 'OSGARD_R135_SHA256_SOURCE_AUDIT_V1',
              'manifest_sha256': manifest_sha,
              'sources': [str(s) for s in a.source],
              'stats': stats, 'warnings': warnings,
              'families': {}, 'matching_sha256': matches,
              'empty_match_is_not_provenance': True}
    for family in families:
        data = manifest[family]
        found = {name: sha for name, sha in data.items() if sha in matches}
        missing = [name for name, sha in data.items() if sha not in matches]
        report['families'][family] = {
            'total': len(data), 'verified_by_sha256': len(found),
            'verified_nonempty': sum(sha != EMPTY_SHA for sha in found.values()),
            'missing_count': len(missing), 'missing_paths': missing}
    a.output.parent.mkdir(parents=True, exist_ok=True)
    a.output.write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    print('Baseline R134:', report['families']['baseline_sha256_files']['verified_by_sha256'], '/', len(manifest['baseline_sha256_files']))
    print('Target R135:', report['families']['target_sha256_files']['verified_by_sha256'], '/', len(manifest['target_sha256_files']))
    print('Missing R135:', report['families']['target_sha256_files']['missing_count'])
    print('Archive members scanned:', stats['scanned_files'])
    print('Report:', a.output)
    return 2 if a.require_complete and report['families']['target_sha256_files']['missing_count'] else 0


if __name__ == '__main__':
    raise SystemExit(main())
