#!/usr/bin/env python3
"""M189 read-only, fail-closed provenance and task-evidence admission gate.

Never executes submitted commands, sends requests, changes Git refs, or authorizes
production. Even locally valid signed evidence is NOT original-task acceptance.
"""
from __future__ import annotations

import argparse
from collections import Counter
import hashlib
import json
from pathlib import Path, PurePosixPath
import re
import subprocess
import sys
from typing import Any

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey

TEAMS = ('TITAN', 'NEXUS', 'COMMERCE', 'EXPERIENCE', 'GENESIS', 'ORBITAL')
REPO = re.compile(r'https://github\.com/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+(?:\.git)?\Z')
HEX40 = re.compile(r'[0-9a-f]{40}\Z')
HEX64 = re.compile(r'[0-9a-f]{64}\Z')
HEX128 = re.compile(r'[0-9a-f]{128}\Z')
KINDS = {'unit', 'integration', 'negative', 'regression', 'e2e'}
MASTER_SHA256 = '71fdda8231e1cb627a36fa683eaab1c28e4bdff2da9c95e0e6f6df83624a4b6c'


def require(condition: bool, message: str) -> None:
    if not condition:
        raise ValueError(message)


def sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            h.update(chunk)
    return h.hexdigest()


def canonical(value: Any) -> bytes:
    return json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=False,
                      allow_nan=False).encode('utf-8')


def safe_file(root: Path, relative: str) -> Path:
    require(isinstance(relative, str) and 0 < len(relative) <= 250,
            'invalid relative file path')
    require('\\' not in relative and '\x00' not in relative and ':' not in relative,
            'unsafe path characters')
    path = PurePosixPath(relative)
    require(not path.is_absolute() and all(p not in ('', '.', '..') for p in relative.split('/')),
            'path traversal prohibited')
    base = root.resolve(strict=True)
    target = root.joinpath(*path.parts)
    require(target.resolve(strict=True).is_relative_to(base), 'path escapes source root')
    require(not target.is_symlink() and target.is_file(), 'symlinks/nonfiles prohibited')
    return target


def signed(payload: dict, approval: Any, keys: Any) -> bool:
    if not isinstance(approval, dict) or set(approval) != {'key_id', 'signature'}:
        return False
    key_id, signature = approval['key_id'], approval['signature']
    if not isinstance(key_id, str) or not isinstance(signature, str):
        return False
    if not isinstance(keys, dict) or key_id not in keys:
        return False
    key_hex = keys[key_id]
    if not isinstance(key_hex, str) or not HEX64.fullmatch(key_hex) or not HEX128.fullmatch(signature):
        return False
    try:
        Ed25519PublicKey.from_public_bytes(bytes.fromhex(key_hex)).verify(
            bytes.fromhex(signature), canonical(payload))
        return True
    except (InvalidSignature, ValueError, TypeError):
        return False


def git_value(repo: Path, *arguments: str) -> str:
    cp = subprocess.run(['git', '-C', str(repo), *arguments], capture_output=True,
                        text=True, timeout=8, check=False)
    require(cp.returncode == 0, 'git evidence unavailable')
    return cp.stdout.strip()


def canonical_repo(url: Any) -> str:
    require(isinstance(url, str) and REPO.fullmatch(url) is not None,
            'GitHub owner/repository URL required')
    return url[:-4] if url.endswith('.git') else url


def admitted_baselines(source: dict, trust: dict, workspace: Path) -> tuple[dict, dict]:
    require(source.get('schema') == 'osgard.m189.upstream-registry/1', 'upstream schema mismatch')
    rows = source.get('teams')
    require(isinstance(rows, list) and len(rows) == 6, 'exactly six upstream rows required')
    require({r.get('team') for r in rows if isinstance(r, dict)} == set(TEAMS),
            'unknown or duplicate upstream teams')
    results, accepted = {}, {}
    for row in rows:
        team = row['team']
        required = {'team', 'repo', 'commit', 'tree', 'owner_approval'}
        require(set(row) == required, 'upstream row has unsupported fields')
        baseline = {name: row[name] for name in ('team', 'repo', 'commit', 'tree')}
        if any(baseline.get(name) is None for name in ('repo', 'commit', 'tree')):
            results[team] = {'status': 'BLOCKED_UPSTREAM', 'reason': 'MISSING_CANONICAL_SOURCE'}
            continue
        try:
            url = canonical_repo(row['repo'])
            require(isinstance(row['commit'], str) and HEX40.fullmatch(row['commit']) is not None,
                    'invalid commit pin')
            require(isinstance(row['tree'], str) and HEX40.fullmatch(row['tree']) is not None,
                    'invalid tree pin')
            require(signed(baseline, row['owner_approval'], trust.get('owner_keys')),
                    'trusted owner signature absent or invalid')
            checkout = workspace / team
            require(checkout.is_dir() and not checkout.is_symlink(), 'team checkout missing')
            require(git_value(checkout, 'rev-parse', 'HEAD') == row['commit'], 'HEAD drift')
            require(git_value(checkout, 'rev-parse', 'HEAD^{tree}') == row['tree'], 'tree drift')
            require(canonical_repo(git_value(checkout, 'remote', 'get-url', 'origin')) == url,
                    'Git remote mismatch')
        except (ValueError, OSError, subprocess.TimeoutExpired) as e:
            results[team] = {'status': 'BLOCKED_UPSTREAM', 'reason': str(e)}
            continue
        results[team] = {'status': 'LOCAL_BASELINE_CHECKED', 'commit': row['commit']}
        accepted[team] = (row, checkout)
    return results, accepted


def review_submission(sub: dict, task: dict, baseline: dict, checkout: Path,
                      trust: dict, evidence_root: Path) -> str:
    required = {'task_id', 'repo', 'commit', 'author', 'artifacts', 'tests',
                'rollback_path', 'rollback_sha256', 'review'}
    require(set(sub) == required, 'submission shape mismatch')
    require(sub['task_id'] == task['id'], 'task mismatch')
    require(canonical_repo(sub['repo']) == canonical_repo(baseline['repo']), 'repo mismatch')
    require(sub['commit'] == baseline['commit'], 'commit mismatch')
    require(isinstance(sub['author'], str) and 3 <= len(sub['author']) <= 80,
            'author required')
    require(isinstance(sub['artifacts'], list) and bool(sub['artifacts']), 'artifact hashes missing')
    paths = set()
    for item in sub['artifacts']:
        require(isinstance(item, dict) and set(item) == {'path', 'sha256'}, 'invalid artifact')
        require(item['path'] not in paths, 'duplicate artifact path')
        paths.add(item['path'])
        require(isinstance(item['sha256'], str) and HEX64.fullmatch(item['sha256']) is not None,
                'invalid artifact sha')
        require(sha256(safe_file(checkout, item['path'])) == item['sha256'], 'artifact SHA mismatch')
    require(isinstance(sub['tests'], list), 'test list missing')
    kinds = set()
    for record in sub['tests']:
        require(isinstance(record, dict) and set(record) ==
                {'kind', 'command', 'exit_code', 'log_path', 'log_sha256'}, 'test shape mismatch')
        require(record['kind'] in KINDS and record['kind'] not in kinds, 'test kind missing/duplicate')
        kinds.add(record['kind'])
        require(type(record['exit_code']) is int and record['exit_code'] == 0,
                'test failed or unknown exit code')
        require(isinstance(record['command'], str) and 2 <= len(record['command']) <= 500,
                'test command missing')
        require(isinstance(record['log_sha256'], str) and HEX64.fullmatch(record['log_sha256']) is not None,
                'test log SHA missing')
        require(sha256(safe_file(evidence_root, record['log_path'])) == record['log_sha256'],
                'test log SHA mismatch')
    require(kinds == KINDS, 'all five applicable test categories required')
    require(isinstance(sub['rollback_sha256'], str) and HEX64.fullmatch(sub['rollback_sha256']) is not None,
            'rollback digest invalid')
    require(sha256(safe_file(checkout, sub['rollback_path'])) == sub['rollback_sha256'],
            'rollback artifact SHA mismatch')
    require(isinstance(sub['review'], dict), 'review missing')
    reviewer = sub['review'].get('key_id')
    require(isinstance(reviewer, str) and reviewer != sub['author'],
            'independent reviewer required')
    signed_payload = {key: sub[key] for key in required - {'review'}}
    require(signed(signed_payload, sub['review'], trust.get('reviewer_keys')),
            'review signature missing/invalid')
    return 'READY_FOR_EXTERNAL_REVIEW'


def evaluate(plan: dict, baselines: dict, evidence: dict, trust: dict,
             workspace: Path, evidence_root: Path) -> dict:
    require(plan.get('schema') == 'osgard.original-180-oct17.recovered/1', 'plan schema mismatch')
    require(plan.get('original_master_sha256') == MASTER_SHA256, 'source provenance mismatch')
    tasks = plan.get('tasks')
    require(isinstance(tasks, list) and len(tasks) == 180, '180 original tasks required')
    ids = [t['id'] for t in tasks]
    require(len(set(ids)) == 180, 'duplicate task IDs')
    require(trust.get('schema') == 'osgard.m189.trust-keys/1', 'trust schema mismatch')
    require(evidence.get('schema') == 'osgard.m189.submissions/1', 'evidence schema mismatch')
    submissions = evidence.get('submissions')
    require(isinstance(submissions, list), 'submissions must be array')
    by_id = {}
    for sub in submissions:
        require(isinstance(sub, dict) and isinstance(sub.get('task_id'), str), 'invalid submission')
        require(sub['task_id'] in ids and sub['task_id'] not in by_id, 'unknown/duplicate task ID')
        by_id[sub['task_id']] = sub
    baseline_status, accepted = admitted_baselines(baselines, trust, workspace)
    rows = []
    # Baselines verified locally are only an input to individual evidence checks.
    for t in tasks:
        team, tid = t['team'], t['id']
        if team not in accepted:
            status, reason = 'BLOCKED_UPSTREAM', baseline_status[team]['reason']
        elif tid not in by_id:
            status, reason = 'AWAITING_EVIDENCE', 'NO_SIGNED_SUBMISSION'
        else:
            try:
                baseline, checkout = accepted[team]
                status = review_submission(by_id[tid], t, baseline, checkout,
                                           trust, evidence_root)
                reason = 'SIGNED_LOCAL_EVIDENCE_NOT_ORIGINAL_ACCEPTANCE'
            except (ValueError, OSError, subprocess.TimeoutExpired) as e:
                status, reason = 'EVIDENCE_REJECTED', str(e)
        rows.append({'id': tid, 'team': team, 'priority': t['priority'],
                     'status': status, 'reason': reason, 'depends_on': t['explicit_deps']})
    # Compute the least fixed point, not a single pass over preliminary statuses.
    # A child must not remain READY if its parent becomes BLOCKED_DEPENDENCY
    # due to a grandparent. The least fixed point also fails closed on cycles.
    ready = set()
    for _ in range(len(rows)):
        added = {row['id'] for row in rows
                 if row['status'] == 'READY_FOR_EXTERNAL_REVIEW'
                 and row['id'] not in ready
                 and all(dep in ready for dep in row['depends_on'])}
        if not added:
            break
        ready.update(added)
    for row in rows:
        if row['status'] == 'READY_FOR_EXTERNAL_REVIEW' and row['id'] not in ready:
            row['status'] = 'BLOCKED_DEPENDENCY'
            row['reason'] = 'TRANSITIVE_TASK_DEPENDENCY_UNVERIFIED'
    counter = Counter(r['status'] for r in rows)
    return {'schema': 'osgard.m189.admission-report/1',
            'original_task_acceptance': 0, 'verified_production_upstreams': 0,
            'production_authorized': False, 'release_gate': 'NO_GO',
            'signed_local_evidence_ready': counter['READY_FOR_EXTERNAL_REVIEW'],
            'statuses': dict(sorted(counter.items())), 'baseline_results': baseline_status,
            'tasks': rows,
            'notice': 'Local signatures and file hashes are not a product launch authorization or independent original-task acceptance.'}


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--plan', type=Path, required=True)
    parser.add_argument('--master', type=Path, required=True)
    parser.add_argument('--upstreams', type=Path, required=True)
    parser.add_argument('--submissions', type=Path, required=True)
    parser.add_argument('--trust', type=Path, required=True)
    parser.add_argument('--workspace', type=Path, required=True)
    parser.add_argument('--evidence-root', type=Path, required=True)
    parser.add_argument('--output', type=Path)
    parser.add_argument('--require-production-ready', action='store_true')
    args = parser.parse_args(argv)
    try:
        require(sha256(args.master) == MASTER_SHA256, 'source master SHA mismatch')
        data = {key: json.loads(path.read_text(encoding='utf-8')) for key, path in {
            'plan': args.plan, 'baselines': args.upstreams, 'evidence': args.submissions,
            'trust': args.trust}.items()}
        result = evaluate(data['plan'], data['baselines'], data['evidence'], data['trust'],
                          args.workspace, args.evidence_root)
    except (ValueError, OSError, json.JSONDecodeError) as exc:
        print('M189_ADMISSION_ERROR: ' + str(exc), file=sys.stderr)
        return 1
    payload = json.dumps(result, ensure_ascii=False, indent=2, sort_keys=True) + '\n'
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(payload, encoding='utf-8')
    else:
        print(payload, end='')
    return 2 if args.require_production_ready and not result['production_authorized'] else 0


if __name__ == '__main__':
    sys.exit(main())
