"""CLI M183, strict read-only reconciliation; outputs are no-clobber local files."""
from __future__ import annotations
import argparse
import json
import sys
from pathlib import Path
from .core import (build_report, write_json_new, write_new, to_markdown)
from .dashboard import write_dashboard


def main(argv=None):
    p = argparse.ArgumentParser(description='OSGARD M183 local readiness evidence diagnostic (never production GO)')
    p.add_argument('command', choices=['assess'])
    p.add_argument('--m182-archive', required=True)
    p.add_argument('--m181-archive', default=None)
    p.add_argument('--workplan', required=True)
    p.add_argument('--old-observations', required=True)
    p.add_argument('--current-observations', required=True)
    p.add_argument('--evidence-index', default=None)
    p.add_argument('--evidence-root', default=None)
    p.add_argument('--json-out', required=True)
    p.add_argument('--md-out', required=True)
    p.add_argument('--html-out', required=True)
    a = p.parse_args(argv)
    if bool(a.evidence_index) != bool(a.evidence_root):
        p.error('--evidence-index and --evidence-root must be supplied together')
    outputs = [Path(a.json_out), Path(a.md_out), Path(a.html_out)]
    if len({str(x.resolve()) for x in outputs}) != 3 or any(x.exists() for x in outputs):
        print('M183 output files must be distinct and not already exist', file=sys.stderr)
        return 3
    try:
        r = build_report(a.m182_archive, a.workplan, a.old_observations,
                         a.current_observations, a.m181_archive, a.evidence_index, a.evidence_root)
        write_json_new(a.json_out, r)
        write_new(a.md_out, to_markdown(r))
        write_dashboard(a.html_out, r)
        print(json.dumps({'decision': r['decision'],
                          'm182_parent': r['engineering']['m182_parent']['status'],
                          'original_m181': r['engineering']['m181_original']['status'],
                          'world_criteria_verified': r['world_readiness']['independently_verified'],
                          'world_criteria_total': r['world_readiness']['total_criteria'],
                          'out_files': list(map(str, outputs))}, ensure_ascii=False))
        return 2
    except (OSError, ValueError, TypeError) as ex:
        print(f'M183 error: {type(ex).__name__}: {ex}', file=sys.stderr)
        return 3

if __name__ == '__main__':
    raise SystemExit(main())
