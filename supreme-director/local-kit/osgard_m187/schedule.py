"""Deterministic dependency planning for the historical 180-task campaign.

Topological order indicates precedence, never permission to run code, make
payments, merge or deploy. All upstream integration tasks remain blocked.
"""
from __future__ import annotations

from collections import Counter, defaultdict
import json
from pathlib import Path

from .plan import recover_master, validate_tasks


def build_schedule(tasks):
    validate_tasks(tasks)
    by_id = {task['id']: task for task in tasks}
    remaining = {task['id']: set(task['explicit_deps']) for task in tasks}
    downstream = defaultdict(set)
    for key, refs in remaining.items():
        for parent in refs: downstream[parent].add(key)
    waves = []
    remaining_count = len(tasks)
    priority = {'P0': 0, 'P1': 1, 'P2': 2}
    while remaining_count:
        available = [key for key, deps in remaining.items() if not deps]
        if not available:
            raise ValueError('Cyclic or missing dependency prevented scheduling')
        available.sort(key=lambda key: (priority[by_id[key]['priority']], key))
        waves.append(available)
        for key in available:
            del remaining[key]
            remaining_count -= 1
        for key in available:
            for child in downstream[key]:
                if child in remaining: remaining[child].discard(key)
    return {
        'schema': 'osgard.m187.historical-dependency-schedule/1',
        'historical_source': 'DIRECTOR_MASTER_180.md',
        'this_is_not_M181_immutable_task_board': True,
        'task_count': len(tasks),
        'explicit_dependency_edges': sum(len(t['explicit_deps']) for t in tasks),
        'topological_wave_count': len(waves),
        'waves': [{'index': n + 1, 'task_count': len(ids), 'task_ids': ids} for n, ids in enumerate(waves)],
        'root_dependencies': waves[0],
        'all_six_real_upstreams_verified': False,
        'external_authority_required': True,
        'original_independent_acceptance': 0,
        'executable_without_upstream_and_approval': 0,
        'all_task_execution_states': {t['id']: 'BLOCKED_UPSTREAM' for t in tasks},
        'production': 'NO_GO',
    }


def export_schedule(master_path, output):
    master = recover_master(master_path)
    schedule = build_schedule(master['tasks'])
    dest = Path(output)
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_text(json.dumps(schedule, ensure_ascii=False, indent=2, sort_keys=True) + '\n', encoding='utf-8')
    return schedule
