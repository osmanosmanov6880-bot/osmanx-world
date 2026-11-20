"""Command-line interface for M190 offline observation ledger."""
from __future__ import annotations

import argparse
import json
from pathlib import Path
import sqlite3
import sys
from . import ledger


def build_parser():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest='command', required=True)
    init = sub.add_parser('init', help='Create immutable local ledger, never overwrites')
    init.add_argument('--db', required=True, type=Path)
    init.add_argument('--plan', required=True, type=Path)
    obs = sub.add_parser('ingest', help='Observe M189 report (no acceptance claim)')
    obs.add_argument('--db', required=True, type=Path)
    obs.add_argument('--plan', required=True, type=Path)
    obs.add_argument('--report', required=True, type=Path)
    obs.add_argument('--actor', required=True)
    obs.add_argument('--expected-head', required=True)
    note = sub.add_parser('note', help='Append review note, cannot change task status')
    note.add_argument('--db', required=True, type=Path)
    note.add_argument('--task', required=True)
    note.add_argument('--message', required=True)
    note.add_argument('--actor', required=True)
    note.add_argument('--expected-head', required=True)
    note.add_argument('--reference-sha256', default=None)
    check = sub.add_parser('verify', help='Verify chain integrity and optional external anchor')
    check.add_argument('--db', required=True, type=Path)
    check.add_argument('--expected-head')
    check.add_argument('--anchor', type=Path)
    export = sub.add_parser('export', help='Export verified records to JSON')
    export.add_argument('--db', required=True, type=Path)
    export.add_argument('--output', required=True, type=Path)
    export.add_argument('--expected-head')
    seal = sub.add_parser('anchor', help='Create an externally stored head checkpoint')
    seal.add_argument('--db', required=True, type=Path)
    seal.add_argument('--output', required=True, type=Path)
    seal.add_argument('--expected-head')
    return parser


def main(argv=None) -> int:
    args = build_parser().parse_args(argv)
    try:
        if args.command == 'init':
            result = ledger.create(args.db, args.plan)
        elif args.command == 'ingest':
            result = ledger.ingest(args.db, plan_path=args.plan, report_path=args.report,
                                   actor=args.actor, expected_head=args.expected_head)
        elif args.command == 'note':
            result = ledger.add_note(args.db, task_id=args.task, message=args.message,
                                     actor=args.actor, expected_head=args.expected_head,
                                     reference_sha256=args.reference_sha256)
        elif args.command == 'verify':
            if args.anchor is not None and args.expected_head is not None:
                raise ledger.LedgerError('specify only one of --anchor or --expected-head')
            result = ledger.verify_anchor(args.db, args.anchor) if args.anchor else \
                     ledger.verify(args.db, expected_head=args.expected_head)
        elif args.command == 'export':
            result = ledger.export_events(args.db, expected_head=args.expected_head)
            ledger.write_json_atomic(args.output, result)
            result = {'exported': str(args.output), **result['summary']}
        else:
            result = ledger.write_anchor(args.db, args.output, expected_head=args.expected_head)
    except (ledger.LedgerError, OSError, sqlite3.DatabaseError, ValueError,
            json.JSONDecodeError, KeyError, TypeError) as exc:
        print('M190_FAIL_CLOSED: ' + str(exc), file=sys.stderr)
        return 2
    print(json.dumps(result, sort_keys=True, ensure_ascii=False, indent=2))
    return 0
