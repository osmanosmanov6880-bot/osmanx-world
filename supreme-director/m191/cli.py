"""No-network CLI: create, verify and restore externally anchored local bundles."""
from __future__ import annotations
import argparse
import json
from pathlib import Path
import sqlite3
import sys
from . import recovery
from m190 import ledger


def main(argv=None) -> int:
    p = argparse.ArgumentParser(description=__doc__)
    subs = p.add_subparsers(dest="command", required=True)
    backup = subs.add_parser("backup", help="backup existing SQLite ledger, with external anchor")
    backup.add_argument("--db", required=True, type=Path)
    backup.add_argument("--anchor", required=True, type=Path)
    backup.add_argument("--bundle", required=True, type=Path)
    verify = subs.add_parser("verify", help="check existing immutable recovery bundle")
    verify.add_argument("--bundle", required=True, type=Path)
    verify.add_argument("--anchor", required=True, type=Path)
    restore = subs.add_parser("restore", help="restore into a NEW SQLite filename")
    restore.add_argument("--bundle", required=True, type=Path)
    restore.add_argument("--anchor", required=True, type=Path)
    restore.add_argument("--out-db", required=True, type=Path)
    a = p.parse_args(argv)
    try:
        if a.command == "backup":
            result = recovery.create_backup(a.db, a.anchor, a.bundle)
        elif a.command == "verify":
            result = recovery.verify_bundle(a.bundle, a.anchor)
        else:
            result = recovery.restore_backup(a.bundle, a.anchor, a.out_db)
    except (recovery.RecoveryError, ledger.LedgerError, sqlite3.DatabaseError,
            json.JSONDecodeError, OSError, ValueError) as exc:
        print("M191_RECOVERY_NO_GO: " + str(exc), file=sys.stderr)
        return 2
    print(json.dumps(result, ensure_ascii=False, indent=2, sort_keys=True))
    return 0
