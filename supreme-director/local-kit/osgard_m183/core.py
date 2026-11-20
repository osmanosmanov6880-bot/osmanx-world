"""M183 evidence explorer; no deploy, approval, network or product mutation.

An arbitrary JSON assertion or hash of a local file never counts as independent
review. The only possible release verdict is PRODUCTION_NO_GO.
"""
from __future__ import annotations

from collections import Counter, defaultdict, deque
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import re

from osgard_m182.core import EXPECTED_M181_SHA256, SHA40, SHA64, TEAMS, inspect_zip, read_json
from .criteria import GATES, DOMAINS

M182_ARCHIVE_SHA256 = 'f3b601f7922646ef1858c8c68fdd6523f970f3ed837fecabc3a8c9d558cea9b0'
PHASE_QUOTAS = {'A': 12, 'B': 48, 'C': 90, 'D': 30}
PHASE_ORDER = {x: i for i, x in enumerate('ABCD')}
TEAM_PREFIX = re.compile(r'^M182-(TITAN|NEXUS|COMMERCE|EXPERIENCE|GENESIS|ORBITAL)-([ABCD])\d{2}$')
REPO = re.compile(r'^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?/[A-Za-z0-9_.-]+$')
BRANCH = re.compile(r'^[A-Za-z0-9][A-Za-z0-9_./-]{0,127}$')
MAX_EVIDENCE_BYTES = 100_000_000


def now():
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


def finding(code, detail, status='BLOCKED'):
    return {'code': code, 'status': status, 'detail': detail}


def inspect_m182_package(path):
    result = inspect_zip(path, M182_ARCHIVE_SHA256)
    if result['status'] != 'LOCAL_VERIFIED':
        return {'status': 'BLOCKED', 'sha256': result.get('sha256'), 'file_count': 0,
                'findings': result['findings']}
    paths = {m['path'] for m in result['members']}
    required = {'README.md', 'osgard_m182/core.py', 'osgard_m182/cli.py',
                'tests/test_m182.py', 'docs/M182_MASTER_PLAN_RU.md', 'SHA256SUMS.txt'}
    missing = sorted(required - paths)
    return {'status': 'LOCAL_BYTES_VERIFIED' if not missing else 'BLOCKED',
            'sha256': result['sha256'], 'file_count': result['file_count'],
            'findings': [finding('M182_MISSING_FILES', ', '.join(missing))] if missing else []}


def validate_workplan(path):
    """Strictly validate the separate M182 PROPOSED board, not original M181."""
    findings = []
    try:
        board = read_json(path)
    except (OSError, ValueError) as ex:
        return {'status': 'BLOCKED', 'findings': [finding('WORKPLAN_UNAVAILABLE', type(ex).__name__)],
                'counts': {}, 'discovery_ready_ids': []}
    if not isinstance(board, dict) or not isinstance(board.get('tasks'), list):
        return {'status': 'BLOCKED', 'findings': [finding('WORKPLAN_SCHEMA', 'tasks list required')],
                'counts': {}, 'discovery_ready_ids': []}
    rows = board['tasks']
    if board.get('not_original_M181_board') is not True or board.get('schema') != 'osgard.m182.workplan/1':
        findings.append(finding('WORKPLAN_ORIGIN', 'Plan must be explicitly marked as not the original M181 board'))
    if len(rows) != 180:
        findings.append(finding('WORKPLAN_COUNT', f'180 expected, {len(rows)} provided'))
    ids, parents_by_id, team_counts, phase_counts = set(), {}, Counter(), Counter()
    for i, row in enumerate(rows):
        if not isinstance(row, dict):
            findings.append(finding('WORKPLAN_ENTRY', f'not object at index {i}'))
            continue
        ident, team, phase = row.get('id'), row.get('team'), row.get('phase')
        m = TEAM_PREFIX.fullmatch(ident) if isinstance(ident, str) else None
        if not m or ident in ids or m.group(1) != team or m.group(2) != phase:
            findings.append(finding('WORKPLAN_ID', f'invalid/duplicate/mismatched ID at {i}'))
            continue
        ids.add(ident)
        team_counts[team] += 1
        phase_counts[phase] += 1
        if row.get('source_task_id') is not None or row.get('status') != 'NOT_ACCEPTED' or row.get('planning_only') is not True:
            findings.append(finding('WORKPLAN_FALSE_ACCEPTANCE', f'{ident} must remain unaccepted plan-only'))
        dep = row.get('local_dependencies')
        if not isinstance(dep, list) or any(not isinstance(x, str) for x in dep) or len(set(dep)) != len(dep):
            findings.append(finding('WORKPLAN_DEPS', f'{ident} missing/duplicate dependencies'))
            continue
        parents_by_id[ident] = dep
    if any(team_counts[t] != 30 for t in TEAMS) or phase_counts != Counter(PHASE_QUOTAS):
        findings.append(finding('WORKPLAN_DISTRIBUTION', f'teams={dict(team_counts)}, phases={dict(phase_counts)}'))
    children = defaultdict(list)
    indegree = {k: 0 for k in ids}
    edges = 0
    for ident, parents in parents_by_id.items():
        for p in parents:
            edges += 1
            if p not in ids or p == ident:
                findings.append(finding('WORKPLAN_UNKNOWN_PARENT', f'{ident} <- {p}'))
                continue
            if PHASE_ORDER[ident.split('-')[2][0]] < PHASE_ORDER[p.split('-')[2][0]]:
                findings.append(finding('WORKPLAN_PHASE_REVERSE', f'{ident} <- {p}'))
            indegree[ident] += 1
            children[p].append(ident)
    if edges != 174:
        findings.append(finding('WORKPLAN_EDGES', f'174 proposed edges expected, observed {edges}'))
    frontier = deque(k for k, v in indegree.items() if v == 0)
    topological_count = 0
    while frontier:
        v = frontier.popleft()
        topological_count += 1
        for child in children[v]:
            indegree[child] -= 1
            if indegree[child] == 0:
                frontier.append(child)
    if topological_count != len(ids):
        findings.append(finding('WORKPLAN_CYCLE', 'Local dependency graph contains a cycle'))
    read_only_discovery = sorted(i for i, p in parents_by_id.items() if not p and i.endswith('A01'))
    other_zeros = sorted(i for i, p in parents_by_id.items() if not p and not i.endswith('A01'))
    if len(read_only_discovery) != 6 or other_zeros:
        findings.append(finding('WORKPLAN_FRONTIER', 'Expected only six read-only A01 discovery entries'))
    return {'status': 'VALID_LOCAL_PROPOSAL_ONLY' if not findings else 'BLOCKED',
            'counts': {'tasks': len(rows), 'new_plan_edges': edges,
                       'tasks_by_team': dict(team_counts), 'tasks_by_phase': dict(phase_counts)},
            'discovery_ready_ids': read_only_discovery if not findings else [],
            'findings': findings}


def _normalize_snapshots(rows, attr):
    if not isinstance(rows, list):
        raise ValueError(f'{attr} must be list')
    out = {}
    for row in rows:
        if not isinstance(row, dict):
            raise ValueError(f'{attr}: snapshot entry not object')
        repo = row.get('repo')
        sha = row.get('observed_head_sha')
        branch = row.get('branch')
        if not isinstance(repo, str) or not REPO.fullmatch(repo) or repo in out:
            raise ValueError(f'{attr}: invalid/duplicate repository')
        if not isinstance(sha, str) or not SHA40.fullmatch(sha):
            raise ValueError(f'{attr}: invalid 40-char Git SHA')
        if not isinstance(branch, str) or not BRANCH.fullmatch(branch) or '..' in branch or '//' in branch or branch.endswith('/'):
            raise ValueError(f'{attr}: invalid branch')
        if row.get('team_assignment') is not None:
            raise ValueError(f'{attr}: unverified team assignment is forbidden')
        out[repo] = {'sha': sha, 'branch': branch}
    return out


def compare_git_observations(previous, current):
    """Two operator-supplied snapshots of verified live reads; not a cryptographic Git attestation."""
    findings = []
    try:
        a, b = read_json(previous), read_json(current)
        old = _normalize_snapshots(a.get('observed_repositories'), 'previous')
        new = _normalize_snapshots(b.get('observed_repositories'), 'current')
    except (OSError, ValueError, TypeError, AttributeError) as ex:
        return {'status': 'BLOCKED', 'findings': [finding('GIT_SNAPSHOT_INVALID', type(ex).__name__)],
                'observations': [], 'changed_count': 0, 'confirmed_team_mappings': 0}
    if not new or not old:
        findings.append(finding('GIT_OBSERVATIONS_EMPTY', 'At least one repository required in both snapshots'))
    results = []
    for repo in sorted(old.keys() | new.keys()):
        lhs, rhs = old.get(repo), new.get(repo)
        if lhs and rhs:
            status = ('UNCHANGED' if lhs == rhs else
                      'BRANCH_CHANGED' if lhs['branch'] != rhs['branch'] else 'COMMIT_CHANGED')
        elif lhs:
            status = 'NOT_OBSERVED_NOW'
        else:
            status = 'NEWLY_OBSERVED'
        results.append({'repo': repo, 'status': status,
                        'previous_sha': lhs['sha'] if lhs else None,
                        'current_sha': rhs['sha'] if rhs else None,
                        'branch': rhs['branch'] if rhs else lhs['branch'],
                        'team_assignment': None})
    return {'status': 'OBSERVATIONAL_DIFF_ONLY' if not findings else 'BLOCKED',
            'findings': findings, 'observations': results,
            'changed_count': sum(x['status'] == 'COMMIT_CHANGED' for x in results),
            'confirmed_team_mappings': 0,
            'note': 'Repo refs were read via connected GitHub; JSON files alone do not provide independent signed authority'}


def inspect_local_evidence(index_path, evidence_root):
    """Evidence file presence and SHA are NOT a passing global quality gate."""
    findings = []
    staged, rejected = [], []
    try:
        obj = read_json(index_path)
        items = obj.get('items') if isinstance(obj, dict) else None
    except (OSError, ValueError) as ex:
        return {'status': 'BLOCKED', 'staged': [], 'rejected': [],
                'findings': [finding('EVIDENCE_INDEX_INVALID', type(ex).__name__)]}
    if not isinstance(items, list) or len(items) > 128:
        return {'status': 'BLOCKED', 'staged': [], 'rejected': [],
                'findings': [finding('EVIDENCE_INDEX_SCHEMA', 'items list <=128 required')]}
    catalog = {g['id'] for g in GATES}
    seen = set()
    root = Path(evidence_root)
    if not root.is_dir() or root.is_symlink():
        return {'status': 'BLOCKED', 'staged': [], 'rejected': [],
                'findings': [finding('EVIDENCE_ROOT', 'Existing non-symlink evidence directory required')]}
    root_real = root.resolve()
    for pos, item in enumerate(items):
        if not isinstance(item, dict):
            rejected.append({'index': pos, 'reason': 'INVALID_ITEM'})
            continue
        ident, rel, digest = item.get('gate_id'), item.get('relative_path'), item.get('sha256')
        if ident not in catalog or ident in seen:
            rejected.append({'index': pos, 'reason': 'UNKNOWN_OR_DUPLICATE_GATE_ID'})
            continue
        seen.add(ident)
        if not isinstance(rel, str) or not rel or '\\' in rel or Path(rel).is_absolute() or '..' in Path(rel).parts or '\x00' in rel:
            rejected.append({'gate_id': ident, 'reason': 'UNSAFE_RELATIVE_PATH'})
            continue
        if not isinstance(digest, str) or not SHA64.fullmatch(digest):
            rejected.append({'gate_id': ident, 'reason': 'INVALID_DIGEST'})
            continue
        file = root / rel
        try:
            resolved = file.resolve(strict=True)
            resolved.relative_to(root_real)
            if not file.is_file() or file.is_symlink():
                raise ValueError('not a regular nonsymlink file')
            if file.stat().st_size > MAX_EVIDENCE_BYTES:
                raise ValueError('oversized file')
            h = hashlib.sha256()
            with file.open('rb') as f:
                for chunk in iter(lambda: f.read(1024 * 1024), b''):
                    h.update(chunk)
            if h.hexdigest() != digest:
                raise ValueError('digest mismatch')
        except (OSError, ValueError):
            rejected.append({'gate_id': ident, 'reason': 'FILE_INVALID_OR_SHA_MISMATCH'})
            continue
        staged.append({'gate_id': ident, 'sha256': digest,
                       'status': 'PRESENT_LOCAL_UNVERIFIED', 'relative_path': rel})
    if rejected:
        findings.append(finding('EVIDENCE_REJECTED', f'{len(rejected)} evidence items rejected'))
    return {'status': 'LOCAL_ARTIFACTS_STAGED_NOT_INDEPENDENTLY_VERIFIED' if not findings else 'BLOCKED',
            'staged': staged, 'rejected': rejected, 'findings': findings}


def build_report(m182_archive, plan, old_observations, new_observations,
                 m181_archive=None, evidence_index=None, evidence_root=None):
    parent = inspect_m182_package(m182_archive)
    product = inspect_zip(m181_archive, EXPECTED_M181_SHA256)
    proposed = validate_workplan(plan)
    refs = compare_git_observations(old_observations, new_observations)
    staged = (inspect_local_evidence(evidence_index, evidence_root)
              if evidence_index and evidence_root else
              {'status': 'NOT_SUBMITTED', 'staged': [], 'rejected': [], 'findings': []})
    blockers = []
    for name, check in [('m182_parent', parent), ('m181_original', product),
                        ('proposed_plan', proposed), ('github_observations', refs),
                        ('world_evidence', staged)]:
        if check.get('status') in ('BLOCKED', 'NOT_SUBMITTED'):
            blockers.append({'gate': name, 'status': check['status']})
    blockers.extend([
        {'gate': 'canonical_six_upstreams', 'status': 'UNVERIFIED'},
        {'gate': '28_conflict_reviewer_proofs', 'status': 'UNVERIFIED'},
        {'gate': '9_contracts_staging_e2e', 'status': 'UNVERIFIED'},
        {'gate': '180_original_tasks_independently_accepted', 'status': 'UNVERIFIED'},
        {'gate': 'real_users_and_paid_demand', 'status': 'UNMEASURED'},
        {'gate': 'production_slo_and_disaster_recovery', 'status': 'UNMEASURED'},
        {'gate': 'external_security_accessibility_reviews', 'status': 'NOT_PERFORMED'},
        {'gate': 'release_owner_authorization', 'status': 'NOT_OBTAINED'},
    ])
    catalog = [{**gate} for gate in GATES]
    return {'schema': 'osgard.m183.readiness/1', 'generated_utc': now(),
            'product': 'OSGARD DIRECTOR MULTI-TEAM ECOSYSTEM',
            'decision': 'PRODUCTION_NO_GO', 'best_in_world_claim': 'UNPROVEN',
            'status': 'ENGINEERING_READINESS_DIAGNOSTICS_ONLY',
            'lineage': {'m180_m181': 'NOT_PROVEN', 'm182_m183': 'LOCAL_GIT_DERIVED_ONLY'},
            'engineering': {'m182_parent': parent, 'm181_original': {k: v for k, v in product.items() if k != 'members'},
                            'proposed_plan': proposed, 'github_observations': refs,
                            'world_evidence': staged},
            'world_readiness': {'criteria': catalog, 'total_criteria': len(catalog),
                                'independently_verified': 0,
                                'staged_local_evidence_not_acceptance': len(staged['staged']),
                                'domains': {domain: {'required': len(rows), 'independently_verified': 0}
                                            for domain, rows in DOMAINS.items()}},
            'original_tasks_independently_accepted_with_evidence': 0,
            'known_reported_conflicts': {'P0': 17, 'P1': 11, 'status': 'NOT_RECONCILED'},
            'blockers': blockers,
            'limitations': ['M183 is separate local engineering code, not deployed product',
                            'No independent product review or production CI performed',
                            'GitHub observations do not assign repositories to the six product teams',
                            'Unknown product-market fit; world-class ranking not objectively measurable']}


def write_new(path, text):
    """No-clobber output; verifies parent is an existing real directory."""
    p = Path(path)
    if not p.parent.is_dir() or p.parent.is_symlink() or p.is_symlink():
        raise ValueError('Output parent must exist and not be a symlink')
    with p.open('x', encoding='utf-8') as f:
        f.write(text)
    return p


def write_json_new(path, result):
    return write_new(path, json.dumps(result, ensure_ascii=False, indent=2, sort_keys=True) + '\n')


def to_markdown(report):
    eng = report['engineering']
    refs = eng['github_observations']
    out = [
        '# OSGARD M183 — журнал готовности к мировой платформе', '',
        f"**Снято UTC:** {report['generated_utc']}", '',
        '**Принцип:** локальные метрики не являются внешней приёмкой.', '',
        f"**Вывод:** `{report['decision']}` / WORLD LEADERSHIP `{report['best_in_world_claim']}`", '',
        '## Установленные инженерные факты', '',
        f"- Родительский M182 ZIP: `{eng['m182_parent']['status']}`; файлов: {eng['m182_parent']['file_count']}",
        f"- Оригинальный M181 ZIP: `{eng['m181_original']['status']}`",
        f"- Новый workplan: `{eng['proposed_plan']['status']}` — это не оригинальный M181 TASK_BOARD",
        f"- Число доступных read-only discovery: {len(eng['proposed_plan']['discovery_ready_ids'])}",
        f"- Канонических соответствий команд и GitHub: {refs['confirmed_team_mappings']}",
        f"- Неподписанных мировых критериев: {report['world_readiness']['total_criteria']}", '',
        '## GitHub: сравнение наблюдаемых default branch ref', '',
        '| Репозиторий | Изменение | Ранее | Сейчас |', '|---|---|---|---|',
    ]
    for r in refs['observations']:
        out.append(f"| `{r['repo']}` | `{r['status']}` | `{r['previous_sha'] or '-'}` | `{r['current_sha'] or '-'}` |")
    out += ['', '## Что необходимо подтвердить для мирового уровня', '',
            '| Область | Критериев | Независимо подтверждено |', '|---|---:|---:|']
    for domain, item in report['world_readiness']['domains'].items():
        out.append(f"| {domain} | {item['required']} | {item['independently_verified']} |")
    out += ['', '## Непройденные выпускные условия', '']
    for b in report['blockers']:
        out.append(f"- `{b['gate']}`: `{b['status']}`")
    out += ['', 'Никаких production approvals, GitHub push, merges, sandbox execution или реальных клиентских KPI этот пакет не выполняет.', '']
    return '\n'.join(out)
