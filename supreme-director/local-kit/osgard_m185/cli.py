"""OSGARD M185 CLI. Signed votes require external reviewer keys and remain LOCAL ONLY."""
from __future__ import annotations
import argparse
import base64
import json
import os
from pathlib import Path
import stat
import sys
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

from osgard_m184.storage import DirectorDB, encode, sha
from .review import ReviewDB, validate_local_vote
from .api import serve

BASE = Path(__file__).resolve().parents[1]


def offline_sign(challenge_file, private_key_file, out_file):
    payload = json.loads(Path(challenge_file).read_text("utf-8"))
    validate_local_vote(payload)
    keypath = Path(private_key_file)
    if not keypath.is_file() or keypath.is_symlink() or keypath.stat().st_size > 50_000:
        raise ValueError("invalid reviewer private key file")
    if os.name == "posix" and stat.S_IMODE(keypath.stat().st_mode) & 0o077:
        raise ValueError("reviewer private key must have mode 0600")
    private = serialization.load_pem_private_key(keypath.read_bytes(), password=None)
    if not isinstance(private, Ed25519PrivateKey):
        raise ValueError("only Ed25519 accepted")
    raw = private.public_key().public_bytes(serialization.Encoding.Raw, serialization.PublicFormat.Raw)
    if sha(raw) != payload["key_sha256"]:
        raise ValueError("review challenge key fingerprint mismatch")
    signed = base64.b64encode(private.sign(encode(payload).encode("utf-8"))).decode("ascii")
    result = {"schema": "osgard.m185.detached-local-review/1", "challenge": payload,
              "signature_b64": signed, "scope": "LOCAL_EVIDENCE_ONLY", "production_authorized": False}
    out = Path(out_file)
    if out.exists() or out.is_symlink():
        raise ValueError("refusing overwrite of existing signed vote")
    fd = os.open(str(out), os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    with os.fdopen(fd, "w", encoding="utf8") as file:
        file.write(json.dumps(result, sort_keys=True, ensure_ascii=False, indent=2) + "\n")
    return {"status": "DETACHED_LOCAL_VOTE_WRITTEN", "output": str(out),
            "product_acceptance": False, "production_authorized": False}


def main(argv=None):
    p = argparse.ArgumentParser(description="OSGARD M185 verified local review, never production")
    sub = p.add_subparsers(dest="command", required=True)
    init = sub.add_parser("init-review")
    init.add_argument("--db", required=True)
    init.add_argument("--root", required=True)
    init.add_argument("--trust", required=True)
    init.add_argument("--plan", default=str(BASE/"docs/M182_WORKPLAN_180_PROPOSED.json"))
    init.add_argument("--conflicts", default=str(BASE/"templates/CONFLICTS_PROVISIONAL.json"))
    init.add_argument("--contracts", default=str(BASE/"templates/CONTRACTS_PROVISIONAL.json"))
    init.add_argument("--observations", default=str(BASE/"docs/m183/CURRENT_GITHUB_DEFAULT_BRANCH_OBSERVATIONS_2026-10-27.json"))
    provision = sub.add_parser("provision-trust")
    for name in ("db", "root", "trust", "expected-current-sha"):
        provision.add_argument("--"+name, required=True)
    commands = ["serve", "doctor", "summary", "cases", "reviewers", "evidence"]
    for command in commands:
        sp = sub.add_parser(command)
        sp.add_argument("--db", required=True)
        sp.add_argument("--root", required=True)
        if command == "serve": sp.add_argument("--port", type=int, default=8765)
    reg = sub.add_parser("register-evidence")
    for name in ("db", "root", "target", "path", "sha256", "actor"):
        reg.add_argument("--"+name,required=True)
    case = sub.add_parser("create-case")
    for name in ("db", "root", "evidence-id", "proposer", "description"):
        case.add_argument("--"+name,required=True)
    challenge = sub.add_parser("challenge")
    for name in ("db", "root", "case-id", "reviewer-id", "verdict", "reason"):
        challenge.add_argument("--"+name,required=True)
    vote = sub.add_parser("submit")
    for name in ("db", "root", "case-id", "reviewer-id", "verdict", "reason", "signature-b64"):
        vote.add_argument("--"+name,required=True)
    sign = sub.add_parser("sign-offline")
    for name in ("challenge", "private-key", "out"):
        sign.add_argument("--"+name,required=True)
    args = p.parse_args(argv)
    try:
        if args.command == "sign-offline": result = offline_sign(args.challenge, args.private_key, args.out)
        elif args.command == "init-review":
            base_db = DirectorDB(args.db)
            base_result = base_db.bootstrap(args.plan, args.conflicts, args.contracts, args.observations)
            review = ReviewDB(args.db, args.root)
            result = {"base": base_result, "review": review.review_bootstrap(args.trust)}
        elif args.command == "serve":
            srv, token = serve(args.db, args.root, BASE/"dashboard/m185", args.port)
            print(f"M185 LOCAL-ONLY: http://127.0.0.1:{srv.server_port}", flush=True)
            print(f"M185 BEARER TOKEN (do not share): {token}", flush=True)
            print("PRODUCT_ACCEPTANCE=0 / PRODUCTION_NO_GO / Ctrl+C to stop", flush=True)
            try: srv.serve_forever(poll_interval=0.2)
            except KeyboardInterrupt: pass
            finally: srv.server_close()
            return 0
        else:
            db = ReviewDB(args.db, args.root)
            if args.command == "provision-trust": result = db.provision_trust(args.trust, args.expected_current_sha)
            elif args.command == "doctor": result = db.doctor()
            elif args.command == "summary": result = db.summary()
            elif args.command == "cases": result = db.cases()
            elif args.command == "reviewers": result = db.trustees()
            elif args.command == "evidence": result = db.evidence_items()
            elif args.command == "register-evidence": result = db.register_evidence(args.target, args.path, args.sha256, args.actor)
            elif args.command == "create-case": result = db.create_case(int(args.evidence_id), args.proposer, args.description)
            elif args.command == "challenge": result = db.challenge(args.case_id, args.reviewer_id, args.verdict, args.reason)
            elif args.command == "submit": result = db.submit(args.case_id, args.reviewer_id, args.verdict, args.reason, args.signature_b64)
            else: raise ValueError("unknown action")
        print(json.dumps(result, sort_keys=True, ensure_ascii=False, indent=2))
        return 2 if args.command == "doctor" and result["health"] != "LOCAL_INTEGRITY_PASS" else 0
    except (ValueError, OSError, KeyError) as exc:
        print(f"M185 BLOCKED: {type(exc).__name__}: {exc}", file=sys.stderr)
        return 3

if __name__ == "__main__":
    raise SystemExit(main())
