"""Local, read-only source recovery gates and bounded reproducible checks."""
from __future__ import annotations

import hashlib
import io
import json
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
import zipfile

from .plan import recover_master, sha256_file

EXPECTED_M181_SHA256 = 'c6d0ff3ff9caa435e6928244ab70ecee8156747306ac3174faca82702be2969a'
EXPECTED_M180_GIT_SHA = 'e8f88465d98c966bd6931883cc5c873b9fcd94a1'
EXPECTED_M181_GIT_SHA = 'ff5e6de7e9614add995d11a7330fc2f13d2c1206'
EXPECTED_M186_GIT_SHA = '564e308f2eadcbdf1d7ca6e8f84d1abedb52d05d'
SHA_RE = re.compile(r'[a-f0-9]{64}\Z')


def inspect_archive(path, expected_sha=None, max_members=10000, max_bytes=2_000_000_000):
    """Inspect metadata and CRC while never extracting or executing archived content."""
    if not path:
        return {'status': 'MISSING', 'archive': None, 'sha256': None,
                'reason': 'Original archive bytes unavailable'}
    src = Path(path)
    if not src.is_file() or src.is_symlink():
        return {'status': 'MISSING_OR_UNSAFE_PATH', 'archive': str(src)}
    if src.stat().st_size > max_bytes:
        return {'status': 'TOO_LARGE', 'archive': str(src)}
    actual = sha256_file(src)
    if expected_sha is not None and (not SHA_RE.fullmatch(expected_sha) or actual != expected_sha):
        return {'status': 'SHA256_MISMATCH', 'archive': str(src), 'sha256': actual}
    try:
        with zipfile.ZipFile(src) as z:
            entries = z.infolist()
            if len(entries) > max_members or not entries:
                return {'status': 'ENTRY_COUNT_LIMIT', 'archive': str(src), 'sha256': actual}
            seen, total = set(), 0
            for row in entries:
                q = row.filename
                parts = q.replace('\\', '/').split('/')
                if (not q or '\\' in q or q.startswith('/') or '..' in parts or
                        any(x in ('', '.') for x in parts[:-1]) or '\x00' in q):
                    return {'status': 'UNSAFE_PATH', 'entry': q, 'sha256': actual}
                if q.rstrip('/').casefold() in seen:
                    return {'status': 'DUPLICATE_ENTRY', 'entry': q, 'sha256': actual}
                seen.add(q.rstrip('/').casefold())
                unix_mode = row.external_attr >> 16
                if (unix_mode & 0o170000) == 0o120000:
                    return {'status': 'SYMLINK_ENTRY', 'entry': q, 'sha256': actual}
                if row.flag_bits & 1:
                    return {'status': 'ENCRYPTED_ENTRY', 'entry': q, 'sha256': actual}
                total += row.file_size
                if total > max_bytes:
                    return {'status': 'UNCOMPRESSED_SIZE_LIMIT', 'sha256': actual}
            # CRC is verified as the archive members are streamed.
            for row in entries:
                if row.is_dir():
                    continue
                with z.open(row) as item:
                    while item.read(1024 * 1024):
                        pass
    except (ValueError, OSError, zipfile.BadZipFile, RuntimeError, EOFError) as exc:
        return {'status': 'BAD_ARCHIVE', 'type': type(exc).__name__, 'sha256': actual}
    return {'status': 'SHA_PIN_AND_CRC_PASS' if expected_sha else 'CRC_PASS_UNPINNED',
            'archive': str(src), 'sha256': actual,
            'file_count': sum(not x.is_dir() for x in entries),
            'uncompressed_size': total,
            'proves_canonical_M180_M181': False if expected_sha is None else None}


def inspect_bundle(bundle):
    result = {'status': 'MISSING_BUNDLE', 'm180_commit_found': False,
              'm181_commit_found': False, 'm186_commit_found': False}
    bundle = Path(bundle)
    if not bundle.is_file() or shutil.which('git') is None:
        return result
    result['bundle_sha256'] = sha256_file(bundle)
    with tempfile.TemporaryDirectory(prefix='osgard-m187-git-') as folder:
        clone = Path(folder) / 'copy'
        try:
            p = subprocess.run(['git', 'clone', '--quiet', '--no-checkout', str(bundle), str(clone)], capture_output=True,
                               text=True, timeout=90)
            if p.returncode:
                return {**result, 'status': 'LOCAL_GIT_CLONE_FAILED', 'exit_code': p.returncode}
            for name, sha in [('m180', EXPECTED_M180_GIT_SHA),
                              ('m181', EXPECTED_M181_GIT_SHA),
                              ('m186', EXPECTED_M186_GIT_SHA)]:
                check = subprocess.run(['git', '-C', str(clone), 'cat-file', '-e', sha + '^{commit}'],
                                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                                       timeout=15)
                result[name + '_commit_found'] = check.returncode == 0
            result['status'] = 'LOCAL_GIT_BUNDLE_INSPECTED'
        except (OSError, subprocess.TimeoutExpired):
            result['status'] = 'GIT_INSPECTION_FAILED'
    return result


def run_local_lab(base):
    """Run real local SQLite and nine-contract positive/negative reference flow."""
    from osgard_m184.storage import DirectorDB
    from osgard_m185.review import ReviewDB
    from osgard_m186.storage import LabDB
    from osgard_m186.contracts import SCENARIOS
    base = Path(base)
    with tempfile.TemporaryDirectory(prefix='osgard-m187-lab-') as workspace:
        workspace = Path(workspace)
        evidence = workspace / 'evidence'
        evidence.mkdir()
        db_path = workspace / 'director.sqlite3'
        board_path = base / 'docs/M182_WORKPLAN_180_PROPOSED.json'
        DirectorDB(db_path).bootstrap(board_path, base / 'templates/CONFLICTS_PROVISIONAL.json',
                                     base / 'templates/CONTRACTS_PROVISIONAL.json')
        ReviewDB(db_path, evidence).review_bootstrap(base / 'templates/TRUSTED_REVIEWERS_EMPTY.json')
        db = LabDB(db_path, evidence, base / 'templates/REFERENCE_CONTRACTS_M186.json')
        db.lab_bootstrap()
        healthy = db.run_reference({'scenario': 'LEARNING_PLATFORM', 'operator': 'local-operator',
                                    'budget_points': 1200, 'risk_profile': 'PUBLIC_DEMO_ONLY',
                                    'inject_fault_at': None})
        blocked = db.run_reference({'scenario': 'LEARNING_PLATFORM', 'operator': 'local-operator',
                                    'budget_points': 1200, 'risk_profile': 'PUBLIC_DEMO_ONLY',
                                    'inject_fault_at': 'CONTRACT-05'})
        doctor = db.doctor()
        summary = db.summary()
        good = (healthy['result']['outcome'] == 'REFERENCE_FLOW_COMPLETE' and
                blocked['result']['outcome'] == 'BLOCKED_REFERENCE_CONTRACT' and
                doctor['health'] == 'LOCAL_INTEGRITY_PASS' and
                summary['independent_acceptance'] == 0 and
                summary['real_integrations'] == 0)
        return {'status': 'PASS_LOCAL_REFERENCE_ONLY' if good else 'FAIL_LOCAL_REFERENCE',
                'healthy_steps': len(healthy['result']['steps']),
                'blocked_steps': len(blocked['result']['steps']),
                'failure_injected_at': 'CONTRACT-05',
                'doctor': doctor['health'],
                'original_task_acceptance': summary['independent_acceptance'],
                'actual_product_integrations': summary['real_integrations'],
                'real_payments_or_external_AI_called': False}


def audit(base, master, m180=None, m181=None, run_tests=False):
    base = Path(base)
    verified = recover_master(master)
    package_test = {'status': 'NOT_RUN'}
    if run_tests:
        try:
            cp = subprocess.run([sys.executable, '-m', 'unittest', 'discover', '-s', 'tests', '-q'],
                                cwd=base, capture_output=True, text=True, timeout=180)
            summary = (cp.stdout + '\n' + cp.stderr)[-4000:]
            package_test = {'status': 'PASS' if cp.returncode == 0 else 'FAIL',
                            'exit_code': cp.returncode, 'tail': summary}
        except subprocess.TimeoutExpired:
            package_test = {'status': 'TIMEOUT', 'exit_code': None}
    lab = run_local_lab(base)
    m186_bundle = inspect_bundle(base / 'evidence/m186/M186_LOCAL_HISTORY.bundle')
    report = {
        'schema': 'osgard.m187.restore-verification/1',
        'source_master_sha256': verified['original_master_sha256'],
        'recovered_historical_tasks': verified['counts'],
        'original_M180_M181_canonical_board': 'NOT_PROVEN',
        'original_M180_snapshot': inspect_archive(m180),
        'original_M181_snapshot': inspect_archive(m181, EXPECTED_M181_SHA256),
        'm186_git_bundle': m186_bundle,
        'local_reference_lab': lab,
        'original_M181_sha256_expected': EXPECTED_M181_SHA256,
        'original_M180_git_commit_expected': EXPECTED_M180_GIT_SHA,
        'original_M181_git_commit_expected': EXPECTED_M181_GIT_SHA,
        'local_suite': package_test,
        'recovered_plan_not_product_integration': True,
        'accepted_original_tasks': 0,
        'verified_live_integrations': 0,
        'release': 'PRODUCTION_NO_GO',
    }
    return report
