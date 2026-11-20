"""Restore the 180 original engineering briefs from the Oct-17 source Markdown.

This is NOT the missing M180/M181 canonical task board. The source Markdown is
an independent historical assignment that cannot prove upstream integrations.
"""
from __future__ import annotations

from collections import Counter, defaultdict
import hashlib
import json
from pathlib import Path
import re

ORIGINAL_MASTER_SHA256 = '71fdda8231e1cb627a36fa683eaab1c28e4bdff2da9c95e0e6f6df83624a4b6c'
TEAM_IDS = ('TITAN', 'NEXUS', 'COMMERCE', 'EXPERIENCE', 'GENESIS', 'ORBITAL')
TASK_RE = re.compile(r'^### ((?:' + '|'.join(TEAM_IDS) + r')-X\d{2}) \u00b7 (P[012]) \u2014 ([^\n]+)$', re.M)
REFERENCE_RE = re.compile(r'\b(?:' + '|'.join(TEAM_IDS) + r')-X\d{2}\b')


def sha256_file(path):
    h = hashlib.sha256()
    with Path(path).open('rb') as f:
        for part in iter(lambda: f.read(1024 * 1024), b''):
            h.update(part)
    return h.hexdigest()


def _read_metadata(section):
    for line in section.splitlines():
        if line.startswith('**') and line.count('**') >= 6:
            chunks = line.split('**')
            if len(chunks) >= 7:
                return chunks[2].strip().removesuffix('.'), chunks[4].strip().removesuffix('.'), chunks[6].strip().removesuffix('.')
    raise ValueError('Missing task scope/dependency/status metadata')


def recover_master(path, require_sha=True):
    path = Path(path)
    actual = sha256_file(path)
    if require_sha and actual != ORIGINAL_MASTER_SHA256:
        raise ValueError('Original Oct-17 master SHA-256 mismatch; refusing unpinned source')
    content = path.read_text(encoding='utf-8-sig')
    hits = list(TASK_RE.finditer(content))
    if len(hits) != 180:
        raise ValueError(f'Expected 180 original headings, found {len(hits)}')
    tasks = []
    for idx, h in enumerate(hits):
        end = hits[idx + 1].start() if idx + 1 < len(hits) else content.find('\n## ', h.end())
        if end < 0: end = len(content)
        section = content[h.end():end]
        deps, scope, state = _read_metadata(section)
        if state != 'PLANNED':
            raise ValueError('Historical task status mismatch: ' + h.group(1))
        refs = sorted(set(REFERENCE_RE.findall(deps)))
        if h.group(1) in refs:
            raise ValueError('Self-dependency: ' + h.group(1))
        tasks.append({
            'id': h.group(1), 'team': h.group(1).split('-')[0],
            'ordinal': int(h.group(1)[-2:]), 'priority': h.group(2),
            'title': h.group(3).strip(), 'dependency_clause_ru': deps,
            'explicit_deps': refs, 'edit_scope_ru': scope,
            'original_status': 'PLANNED', 'current_verified_integration': False,
            'local_recovery_status': 'BLOCKED_UPSTREAM',
            'm181_task_board_correspondence': 'NOT_ESTABLISHED',
            'independent_acceptance': False,
            'source_line': content.count('\n', 0, h.start()) + 1,
        })
    validate_tasks(tasks)
    return {
        'schema': 'osgard.original-180-oct17.recovered/1',
        'original_master_sha256': actual,
        'source_document': 'DIRECTOR_MASTER_180.md',
        'authorship_status': 'HISTORICAL_USER_PROVIDED_PLAN',
        'relationship_to_M180_M181_task_board': 'NOT_PROVEN',
        'original_294_dependency_edges': 'UNVERIFIED_WITHOUT_M180_M181',
        'counts': {'total': 180, 'teams': dict(Counter(t['team'] for t in tasks)),
                   'priorities': dict(Counter(t['priority'] for t in tasks)),
                   'explicit_references_in_this_document': sum(len(t['explicit_deps']) for t in tasks)},
        'production': 'NO_GO',
        'original_task_acceptance': 0,
        'tasks': tasks
    }


def validate_tasks(tasks):
    if len(tasks) != 180: raise ValueError('Task count must equal 180')
    counts = Counter(t['team'] for t in tasks)
    if counts != Counter({x: 30 for x in TEAM_IDS}):
        raise ValueError('Each of six teams must own 30 briefs')
    p = Counter(t['priority'] for t in tasks)
    if p != Counter({'P0': 60, 'P1': 90, 'P2': 30}):
        raise ValueError('Priority distribution changed')
    ids = [t['id'] for t in tasks]
    if len(set(ids)) != len(ids): raise ValueError('Duplicate task identifiers')
    if any(t['ordinal'] not in range(1, 31) or t['id'] != f"{t['team']}-X{t['ordinal']:02d}" for t in tasks):
        raise ValueError('Team sequence mismatch')
    idset = set(ids)
    for t in tasks:
        for ref in t['explicit_deps']:
            if ref not in idset: raise ValueError(f"Unresolved reference {t['id']} -> {ref}")
    graph = {t['id']: t['explicit_deps'] for t in tasks}
    visiting = set()
    done = set()
    def visit(node):
        if node in visiting: raise ValueError('Circular explicit dependency at ' + node)
        if node in done: return
        visiting.add(node)
        for parent in graph[node]: visit(parent)
        visiting.remove(node)
        done.add(node)
    for node in graph: visit(node)


def save_master_json(src, output):
    recovered = recover_master(src)
    dest = Path(output)
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_text(json.dumps(recovered, ensure_ascii=False, indent=2, sort_keys=True) + '\n', encoding='utf-8')
    return recovered
