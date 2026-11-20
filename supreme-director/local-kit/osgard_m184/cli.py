"""M184 CLI. The only server address is 127.0.0.1; no production controls."""
from __future__ import annotations
import argparse
import json
from pathlib import Path
import sys
from .storage import DirectorDB
from .api import serve


def main(argv=None):
    p = argparse.ArgumentParser(description="OSGARD M184 local-only Director Studio")
    sub = p.add_subparsers(dest="command", required=True)
    bootstrap = sub.add_parser("bootstrap")
    bootstrap.add_argument("--db", required=True)
    bootstrap.add_argument("--plan", required=True)
    bootstrap.add_argument("--conflicts", required=True)
    bootstrap.add_argument("--contracts", required=True)
    bootstrap.add_argument("--observations")
    doctor = sub.add_parser("doctor")
    doctor.add_argument("--db", required=True)
    summary = sub.add_parser("summary")
    summary.add_argument("--db", required=True)
    server = sub.add_parser("serve")
    server.add_argument("--db", required=True)
    server.add_argument("--port", type=int, default=8765)
    note = sub.add_parser("note")
    note.add_argument("--db", required=True)
    note.add_argument("--kind", required=True, choices=["task", "conflict", "contract"])
    note.add_argument("--target", required=True)
    note.add_argument("--actor", required=True)
    note.add_argument("--note", required=True)
    evidence = sub.add_parser("register-evidence")
    evidence.add_argument("--db", required=True)
    evidence.add_argument("--root", required=True)
    evidence.add_argument("--target", required=True)
    evidence.add_argument("--path", required=True)
    evidence.add_argument("--sha256", required=True)
    evidence.add_argument("--actor", required=True)
    args = p.parse_args(argv)
    try:
        if args.command == "serve":
            http, token = serve(args.db, Path(__file__).resolve().parents[1] / "dashboard" / "m184", args.port)
            print("M184 LOCAL-ONLY: http://127.0.0.1:" + str(http.server_port), flush=True)
            print("M184 BEARER TOKEN (do not share): " + token, flush=True)
            print("PRODUCTION_NO_GO; ctrl-c stops the local server", flush=True)
            try: http.serve_forever(poll_interval=0.2)
            except KeyboardInterrupt: pass
            finally: http.server_close()
            return 0
        db = DirectorDB(args.db)
        if args.command == "bootstrap":
            obj = db.bootstrap(args.plan, args.conflicts, args.contracts, args.observations)
        elif args.command == "doctor": obj = db.doctor()
        elif args.command == "summary": obj = db.summary()
        elif args.command == "note": obj = db.add_note(args.kind, args.target, args.actor, args.note)
        elif args.command == "register-evidence":
            obj = db.register_local_evidence(args.target, args.path, args.sha256, args.actor, args.root)
        else: return 3
        print(json.dumps(obj, ensure_ascii=False, indent=2))
        return 2 if args.command == "doctor" and obj["health"] != "LOCAL_INTEGRITY_PASS" else 0
    except (ValueError, OSError) as exc:
        print("M184 BLOCKED: " + type(exc).__name__ + ": " + str(exc), file=sys.stderr)
        return 3

if __name__ == "__main__":
    raise SystemExit(main())
