"""OSGARD M187: local recovery with original 180 tasks and real test evidence."""
from __future__ import annotations

import argparse
import json
from pathlib import Path
import sys
from .plan import save_master_json
from .audit import audit
from .schedule import export_schedule

BASE = Path(__file__).resolve().parents[1]
MASTER = BASE / 'originals/DIRECTOR_MASTER_180.md'


def main(argv=None):
    p = argparse.ArgumentParser(description='OSGARD M187 SOURCE RECOVERY / NO PRODUCT CLAIMS')
    sub = p.add_subparsers(dest='command', required=True)
    plan = sub.add_parser('restore-plan')
    plan.add_argument('--master', type=Path, default=MASTER)
    plan.add_argument('--out', type=Path, default=BASE / 'recovery_m187/ORIGINAL_180_TASKS.json')
    w = sub.add_parser('plan-waves')
    w.add_argument('--master', type=Path, default=MASTER)
    w.add_argument('--out', type=Path, default=BASE / 'recovery_m187/M187_DEPENDENCY_WAVES.json')
    check = sub.add_parser('audit')
    check.add_argument('--master', type=Path, default=MASTER)
    check.add_argument('--out', type=Path, default=BASE / 'recovery_m187/M187_RECOVERY_REPORT.json')
    check.add_argument('--m180', type=Path)
    check.add_argument('--m181', type=Path)
    check.add_argument('--run-tests', action='store_true')
    args = p.parse_args(argv)
    try:
        if args.command == 'restore-plan':
            result = save_master_json(args.master, args.out)
            print(json.dumps({'status': 'HISTORICAL_PLAN_RECOVERED_NOT_PRODUCT_ACCEPTED',
                              'counts': result['counts'], 'file': str(args.out)}, ensure_ascii=False))
            return 0
        if args.command == 'plan-waves':
            waves = export_schedule(args.master, args.out)
            print(json.dumps({'status': 'DEPENDENCY_GRAPH_RECONSTRUCTED', 'tasks': waves['task_count'],
                              'edges': waves['explicit_dependency_edges'], 'waves': waves['topological_wave_count'],
                              'root_tasks': waves['root_dependencies'], 'output': str(args.out)}, ensure_ascii=False))
            return 0
        result = audit(BASE, args.master, args.m180, args.m181, args.run_tests)
        args.out.parent.mkdir(parents=True, exist_ok=True)
        args.out.write_text(json.dumps(result, indent=2, ensure_ascii=False, sort_keys=True) + '\n', encoding='utf-8')
        print(json.dumps({'status': result['local_reference_lab']['status'],
                          'original_task_acceptance': result['accepted_original_tasks'],
                          'recovered_plan': result['recovered_historical_tasks']['total'],
                          'original_M180_M181': result['original_M180_M181_canonical_board'],
                          'release': result['release'], 'report': str(args.out)}, ensure_ascii=False))
        return 0 if (result['local_reference_lab']['status'] == 'PASS_LOCAL_REFERENCE_ONLY'
                     and result['local_suite']['status'] not in ('FAIL', 'TIMEOUT')) else 2
    except (OSError, ValueError, KeyError) as exc:
        print(f'RECOVERY_BLOCKED: {type(exc).__name__}: {exc}', file=sys.stderr)
        return 3

if __name__ == '__main__':
    raise SystemExit(main())
