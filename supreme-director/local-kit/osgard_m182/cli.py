"""Command-line interface for M182: no network, no extraction, no deploy."""
from __future__ import annotations

import argparse
import json
from pathlib import Path
import sys

from .core import TEAMS, audit, compare_archives, dump_json

PREFIXES = {
    "TITAN": "TITAN-X",
    "NEXUS": "NEXUS-X",
    "COMMERCE": "COMMERCE-X",
    "EXPERIENCE": "EXPERIENCE-X",
    "GENESIS": "GENESIS-X",
    "ORBITAL": "ORBITAL-X",
}


def bootstrap(directory):
    """Generate explicit placeholders; never forge original task contents."""
    d = Path(directory)
    d.mkdir(parents=True, exist_ok=True)
    tasks = [{"id": f"{PREFIXES[team]}{i:02d}", "team": team, "parents": [],
              "description": None, "source": "PLACEHOLDER_ONLY", "independent_acceptance": "NOT_ACCEPTED"}
             for team in TEAMS for i in range(1, 31)]
    conflicts = [{"id": f"M181-CONFLICT-{i:02d}", "severity": "P0" if i <= 17 else "P1",
                  "path": None, "left_sha256": None, "right_sha256": None,
                  "resolution": "UNRESOLVED", "author": None, "reviewer": None,
                  "review_pr_url": None, "review_commit_sha": None} for i in range(1, 29)]
    contracts = [{"id": f"CONTRACT-{i:02d}", "producer": None, "consumer": None,
                  "schema_sha256": None, "test_run_url": None} for i in range(1, 10)]
    upstreams = [{"team": team, "repository_url": None, "head_sha": None,
                  "owner": None, "owner_approval_pr": None} for team in TEAMS]
    outputs = {
        "TASK_BOARD_PROVISIONAL.json": {"schema": "osgard.m182.provisional-board/1",
                "source_authority": "PROVISIONAL_NOT_M181", "reported_tasks": 180,
                "reported_dependencies": 294, "tasks": tasks},
        "CONFLICTS_PROVISIONAL.json": {"schema": "osgard.m182.conflicts/1", "conflicts": conflicts},
        "CONTRACTS_PROVISIONAL.json": {"schema": "osgard.m182.contracts/1", "contracts": contracts},
        "UPSTREAMS_PROVISIONAL.json": {"schema": "osgard.m182.upstreams/1", "teams": upstreams},
    }
    for filename, obj in outputs.items():
        dump_json(d / filename, obj)
    return sorted(outputs)


def to_markdown(report):
    out = ["# OSGARD M182 — проверяемая квитанция", "",
           f"Дата UTC: {report['generated_at_utc']}", "",
           f"**Решение: {report['release_decision']}**", "",
           "Локальный тестовый контур не принимает production решения и не подменяет внешнего ревью.", "",
           "## Контрольные контуры", "",
           "| Контур | Статус | Блокирующих причин |", "|---|---|---:|"]
    for name, value in report["checks"].items():
        count = sum(x["status"] == "BLOCKED" for x in value.get("findings", []))
        out.append(f"| `{name}` | `{value['status']}` | {count} |")
    out += ["", "## Открытые блокировки", ""]
    for i, item in enumerate(report["blockers"], 1):
        detail = item["detail"].replace("|", "/").replace("\n", " ")
        out.append(f"{i}. **{item['gate']} / {item['code']}** — {detail}")
    out += ["", "## Границы подтверждения", "",
            "- M180/M181 commits and archive pin are user-reported, not independently fetched.",
            "- Any provisional board and conflict cards are templates, not product originals.",
            "- Nine contracts require actual consumer/producer CI proof and independent review.",
            "- Production remains NO-GO even if all local metadata are present.", ""]
    return "\n".join(out)


def parser():
    p = argparse.ArgumentParser(description="Read-only OSGARD M182 integration preflight")
    sub = p.add_subparsers(dest="command", required=True)
    boot = sub.add_parser("bootstrap", help="Create clearly marked provisional input templates")
    boot.add_argument("--dir", required=True)
    cmd = sub.add_parser("audit", help="Read-only fail-closed audit (always production NO-GO)")
    cmd.add_argument("--archive", default=None)
    cmd.add_argument("--board", default=None)
    cmd.add_argument("--conflicts", default=None)
    cmd.add_argument("--contracts", default=None)
    cmd.add_argument("--upstreams", default=None)
    cmd.add_argument("--sha256", default=None)
    cmd.add_argument("--json-out", required=True)
    cmd.add_argument("--md-out", required=True)
    diff = sub.add_parser("compare", help="Read-only SHA-pinned ZIP-to-ZIP byte inventory diff")
    diff.add_argument("--left", required=True)
    diff.add_argument("--left-sha256", required=True)
    diff.add_argument("--right", required=True)
    diff.add_argument("--right-sha256", required=True)
    diff.add_argument("--json-out", required=True)
    return p


def main(argv=None):
    args = parser().parse_args(argv)
    try:
        if args.command == "bootstrap":
            files = bootstrap(args.dir)
            print(json.dumps({"created": files, "directory": args.dir,
                              "source": "PROVISIONAL_NOT_M181"}, ensure_ascii=False))
            return 0
        if args.command == "compare":
            result = compare_archives(args.left, args.right, args.left_sha256, args.right_sha256)
            dump_json(args.json_out, result)
            print(json.dumps({"status": result["status"], "added": len(result["added"]),
                              "removed": len(result["removed"]), "modified": len(result["modified"]),
                              "unchanged": result["unchanged"]}, ensure_ascii=False))
            return 0 if result["status"] == "LOCAL_DIFF_ONLY" else 2
        kwargs = {"archive": args.archive, "board": args.board, "conflicts": args.conflicts,
                  "contracts": args.contracts, "upstreams": args.upstreams}
        if args.sha256 is not None:
            kwargs["expected_sha256"] = args.sha256
        result = audit(**kwargs)
        dump_json(args.json_out, result)
        p = Path(args.md_out)
        p.parent.mkdir(parents=True, exist_ok=True)
        with p.open("x", encoding="utf-8") as file:
            file.write(to_markdown(result))
        print(json.dumps({"release_decision": result["release_decision"],
                          "blockers": len(result["blockers"]), "json": args.json_out,
                          "markdown": args.md_out}, ensure_ascii=False))
        return 2
    except (OSError, ValueError) as exc:
        print(f"M182 input/output error: {type(exc).__name__}: {exc}", file=sys.stderr)
        return 3


if __name__ == "__main__":
    raise SystemExit(main())
