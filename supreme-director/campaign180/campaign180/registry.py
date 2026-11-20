"""Read-only, fail-closed provenance for the original OSGARD 180 campaign.

This cannot authorize a six-team upstream, merge, deployment, or acceptance.
"""
from __future__ import annotations

from collections import Counter
from hashlib import sha256
import json
import os
from pathlib import Path
import re
import subprocess
import tomllib

TEAMS = ('TITAN', 'NEXUS', 'COMMERCE', 'EXPERIENCE', 'GENESIS', 'ORBITAL')
MASTER_SHA256 = '71fdda8231e1cb627a36fa683eaab1c28e4bdff2da9c95e0e6f6df83624a4b6c'
VALID_PRIORITIES = {'P0': 60, 'P1': 90, 'P2': 30}
TASK_RE = re.compile(r'^(TITAN|NEXUS|COMMERCE|EXPERIENCE|GENESIS|ORBITAL)-X(0[1-9]|[12][0-9]|30)$')
CANONICAL_REPO_RE = re.compile(r'^https://github\.com/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$')
SHA_RE = re.compile(r'^[a-f0-9]{40}$')


class EvidenceError(ValueError):
    """Fail closed: evidence is invalid, missing, or overclaims acceptance."""


def root_from_module() -> Path:
    return Path(__file__).resolve().parents[3]


def file_sha256(path: Path) -> str:
    h = sha256()
    with path.open('rb') as stream:
        for chunk in iter(lambda: stream.read(131072), b''):
            h.update(chunk)
    return h.hexdigest()


def load_original(root: Path) -> dict:
    root = Path(root)
    master = root / 'supreme-director/originals/DIRECTOR_MASTER_180.md'
    origin = root / 'supreme-director/recovery/ORIGINAL_180_TASKS.json'
    if not master.is_file() or not origin.is_file():
        raise EvidenceError('Original master or recovered 180-task source is missing')
    if file_sha256(master) != MASTER_SHA256:
        raise EvidenceError('Canonical October 17 master SHA256 does not match')
    payload = json.loads(origin.read_text(encoding='utf-8'))
    if payload.get('original_master_sha256') != MASTER_SHA256:
        raise EvidenceError('Recovered task register does not bind canonical master')
    tasks = payload.get('tasks')
    if not isinstance(tasks, list) or len(tasks) != 180:
        raise EvidenceError('Task source must contain exactly 180 records')
    if any(type(t) is not dict for t in tasks):
        raise EvidenceError('Every task must be an object')
    ids = [t.get('id') for t in tasks]
    if len(set(ids)) != 180 or any(type(i) is not str or not TASK_RE.fullmatch(i) for i in ids):
        raise EvidenceError('Task IDs are missing, invalid, or duplicated')
    if Counter(t.get('team') for t in tasks) != Counter(dict.fromkeys(TEAMS, 30)):
        raise EvidenceError('Must have 30 tasks in each of 6 teams')
    if Counter(t.get('priority') for t in tasks) != Counter(VALID_PRIORITIES):
        raise EvidenceError('Priority counts must match master P0/P1/P2')
    for task in tasks:
        if task['team'] != task['id'].split('-X')[0]:
            raise EvidenceError('Team/task ID mismatch')
        if not isinstance(task.get('title'), str) or not task['title'].strip():
            raise EvidenceError('Task title missing')
        deps = task.get('explicit_deps', [])
        if not isinstance(deps, list) or any(d not in ids for d in deps):
            raise EvidenceError('Task references unknown explicit dependency')
        if task.get('independent_acceptance'):
            raise EvidenceError('Historical recovery must not assert independent acceptance')
    return payload


def load_upstreams(root: Path) -> dict:
    path = root / 'supreme-director/campaign180/data/UPSTREAM_REGISTRY.json'
    record = json.loads(path.read_text(encoding='utf-8'))
    teams = record.get('teams')
    if not isinstance(teams, dict) or set(teams) != set(TEAMS):
        raise EvidenceError('Upstream registry must explicitly cover six teams')
    for team, source in teams.items():
        if not isinstance(source, dict):
            raise EvidenceError('Upstream record must be object: ' + team)
        url = source.get('repository_url')
        commit = source.get('commit_sha')
        approver = source.get('approved_by')
        reviewer = source.get('independent_reviewer')
        verified = source.get('owner_approved', False)
        if type(verified) is not bool:
            raise EvidenceError('Upstream approved field must be boolean')
        if verified:
            if (not isinstance(url, str) or not CANONICAL_REPO_RE.fullmatch(url)
                    or not isinstance(commit, str) or not SHA_RE.fullmatch(commit)
                    or not isinstance(approver, str) or not approver.strip()
                    or not isinstance(reviewer, str) or not reviewer.strip()
                    or approver == reviewer):
                raise EvidenceError('Approved upstream lacks distinct reviewer and pinned URL/SHA: ' + team)
        elif url is not None or commit is not None:
            # Do not blur 'candidate' with provenance. Candidate repos live in a different record.
            raise EvidenceError('Unapproved upstream cannot claim canonical URL/SHA: ' + team)
    return record


def _git(root: Path, *args: str) -> str:
    process = subprocess.run(['git', '-C', str(root), *args], capture_output=True,
                             text=True, encoding='utf-8', check=False, timeout=15)
    if process.returncode:
        raise EvidenceError('Git inspection failed (' + ' '.join(args) + ')')
    return process.stdout.strip()


def git_files(root: Path) -> list[str]:
    p = subprocess.run(['git', '-C', str(root), 'ls-files', '-z'],
                       capture_output=True, check=False, timeout=15)
    if p.returncode:
        raise EvidenceError('Cannot list tracked git files')
    paths = [os.fsdecode(v) for v in p.stdout.split(b'\0') if v]
    for path in paths:
        candidate = Path(path)
        if candidate.is_absolute() or '..' in candidate.parts or '\x00' in path:
            raise EvidenceError('Path traversal in tracked paths')
    return sorted(paths)


def _manifest_kind(path: str) -> str | None:
    name = Path(path).name.lower()
    if name in ('pyproject.toml', 'package.json', 'cargo.toml', 'go.mod',
                'requirements.txt', 'uv.lock', 'poetry.lock', 'pdm.lock',
                'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock',
                'cargo.lock', 'go.sum', 'pipfile.lock'):
        return 'dependency-metadata'
    if name.startswith('requirements') and name.endswith('.txt'):
        return 'requirements'
    return None


def repository_inventory(root: Path) -> dict:
    root = Path(root).resolve()
    sha = _git(root, 'rev-parse', 'HEAD')
    if not SHA_RE.fullmatch(sha):
        raise EvidenceError('Git SHA is not an immutable 40-character commit ID')
    tree = git_files(root)
    manifest = []
    component_count = Counter()
    deps = []
    tracked_private_keys = []
    for name in tree:
        path = root / name
        if not path.exists() or not path.is_file() or path.is_symlink():
            raise EvidenceError('Tracked file is absent, non-file or symlink: ' + name)
        size = path.stat().st_size
        if size > 25 * 1024 * 1024:
            raise EvidenceError('Unexpected oversized tracked source: ' + name)
        component_count[name.split('/')[0]] += 1
        h = file_sha256(path)
        manifest.append({'path': name, 'bytes': size, 'sha256': h})
        if re.search(r'(^|/)(\.env(\..*)?|id_rsa|id_ed25519|.*\.(?:pem|p12|pfx|key))$',name,re.I):
            tracked_private_keys.append(name)
        k = _manifest_kind(name)
        if k:
            deps.append({'path': name, 'sha256': h, 'kind': k})
    upstream = load_upstreams(root)
    return {'schema': 'osgard.original180.repository-inventory/1',
            'repository_commit': sha,
            'file_count': len(manifest), 'file_manifest': manifest,
            'file_manifest_sha256': sha256(json.dumps(manifest, sort_keys=True,
                                     separators=(',', ':')).encode()).hexdigest(),
            'top_level_file_counts': dict(sorted(component_count.items())),
            'dependency_manifests': deps,
            'tracked_sensitive_path_flags': tracked_private_keys,
            'upstream_approved_count': sum(1 for r in upstream['teams'].values()
                                           if r.get('owner_approved') is True),
            'six_team_upstream_evidence_complete': all(
                r.get('owner_approved') is True for r in upstream['teams'].values()),
            'external_deploy_authorized': False,
            'original_tasks_production_accepted': 0}
