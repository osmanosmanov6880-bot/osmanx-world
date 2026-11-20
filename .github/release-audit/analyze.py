#!/usr/bin/env python3
"""Read-only, fail-closed FULL pull-request scope audit.

Creates review evidence, not product approval or permission to merge.
Only the merge-base-to-head diff is examined. Never inspect just HEAD^.
"""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import re
import subprocess
import sys

HEX_COMMIT = re.compile(r"^[0-9a-fA-F]{40}(?:[0-9a-fA-F]{24})?$")
MODULE = re.compile(r"^m[0-9]{3}$")
KNOWN_TEAMS = frozenset({"titan", "nexus", "genesis", "orbital", "commerce", "experience"})
SECRET_BASENAMES = frozenset({"id_rsa", "id_ed25519"})
SECRET_EXTENSIONS = (".pem", ".p12", ".pfx", ".key")
PROTECTED_PREFIXES = (
    "supreme-director/originals/",
    "supreme-director/recovery/",
    "supreme-director/local-kit/originals/",
    "supreme-director/local-kit/recovery/",
)


class BoundaryError(ValueError):
    """Invalid input or unavailable Git evidence: never grant access."""


def git(repo: Path, *args: str) -> bytes:
    proc = subprocess.run(
        ["git", *args], cwd=repo, stdout=subprocess.PIPE,
        stderr=subprocess.PIPE, check=False,
    )
    if proc.returncode:
        # Deliberately avoid displaying filenames or raw Git stderr in CI logs.
        raise BoundaryError("Required Git evidence unavailable: " + args[0])
    return proc.stdout


def valid_path(raw: str) -> str:
    if not isinstance(raw, str) or not raw or raw.startswith("/") or "\\" in raw:
        raise BoundaryError("Unsafe change-set path")
    if any(ord(char) < 32 or ord(char) == 127 for char in raw):
        raise BoundaryError("Control character in change-set path")
    if any(part in ("", ".", "..") for part in raw.split("/")):
        raise BoundaryError("Noncanonical change-set path")
    return raw


def parse_name_status(data: bytes) -> list[dict]:
    """Parse Git's NUL-delimited status format, including both rename endpoints."""
    if not data:
        return []
    if not data.endswith(b"\0"):
        raise BoundaryError("Incomplete Git change stream")
    try:
        words = [word.decode("utf-8", "strict") for word in data[:-1].split(b"\0")]
    except UnicodeDecodeError as exc:
        raise BoundaryError("Non-UTF-8 file path requires manual review") from exc
    items = []
    index = 0
    while index < len(words):
        status = words[index]
        index += 1
        if not re.fullmatch(r"(?:[ACDMRTUXB]|[RC][0-9]{1,3})", status):
            raise BoundaryError("Unrecognized Git status")
        dual = status.startswith(("R", "C"))
        if index + (2 if dual else 1) > len(words):
            raise BoundaryError("Truncated rename/copy entry")
        if dual:
            old, new = valid_path(words[index]), valid_path(words[index + 1])
            index += 2
        else:
            path = valid_path(words[index])
            index += 1
            old, new = (path, None) if status == "D" else (None, path)
        items.append({"status": status, "old_path": old, "new_path": new})
    return items


def classify_path(path: str) -> tuple[str, set[str]]:
    path = valid_path(path)
    parts = path.casefold().split("/")
    low = "/".join(parts)
    flags = set()
    basename = parts[-1]
    if (basename in SECRET_BASENAMES or basename == ".env" or
        basename.startswith(".env.") or basename.endswith(SECRET_EXTENSIONS)):
        flags.add("SENSITIVE_PATH_CHANGE")
    if any(low.startswith(prefix) for prefix in PROTECTED_PREFIXES):
        flags.add("PROTECTED_ORIGINAL_CHANGE")
        return "held-originals", flags
    if (parts[0] == "sources" or
        (len(parts) >= 3 and parts[:3] == ["supreme-director", "local-kit", "sources"])):
        flags.add("UNVERIFIED_UPSTREAM_SOURCE_CHANGE")
        team = parts[1] if parts[0] == "sources" and len(parts) > 1 else (
            parts[3] if len(parts) > 3 else "unknown"
        )
        return "held-source-" + (team if team in KNOWN_TEAMS else "unknown"), flags
    if (low.startswith(".github/release-audit/") or
        low == ".github/workflows/osgard-pr-boundary.yml"):
        return "release-audit", flags
    if low.startswith("supreme-director/campaign180/"):
        return "campaign180", flags
    if low.startswith("supreme-director/local-kit/"):
        return "local-kit", flags
    if len(parts) >= 3 and parts[0] == "supreme-director" and MODULE.fullmatch(parts[1]):
        return parts[1], flags
    if low.startswith(".github/"):
        return "ci-and-ownership", flags
    if low.startswith("supreme-director/"):
        return "integration-and-docs", flags
    return "other", flags


def audit(repo: Path, base_sha: str, head_sha: str) -> dict:
    repo = Path(repo)
    if not HEX_COMMIT.fullmatch(base_sha) or not HEX_COMMIT.fullmatch(head_sha):
        raise BoundaryError("Both refs must be full Git commit SHAs")
    base = git(repo, "rev-parse", "--verify", base_sha + "^{commit}").decode().strip()
    head = git(repo, "rev-parse", "--verify", head_sha + "^{commit}").decode().strip()
    common = git(repo, "merge-base", base, head).decode().strip()
    raw = git(
        repo, "diff", "--no-ext-diff", "--no-textconv", "--find-renames",
        "--name-status", "-z", common, head,
    )
    changes = parse_name_status(raw)
    scopes: dict[str, list[dict]] = {}
    policy_flags: set[str] = set()
    for change in changes:
        labels = set()
        for path in (change["old_path"], change["new_path"]):
            if path is None:
                continue
            scope, flags = classify_path(path)
            labels.add(scope)
            policy_flags.update(flags)
        item = {**change, "scopes": sorted(labels)}
        for scope in labels:
            scopes.setdefault(scope, []).append(item)
    if len(scopes) > 1:
        policy_flags.add("MIXED_WORKSTREAMS_REQUIRES_SPLIT")
    if not changes:
        policy_flags.add("EMPTY_PULL_REQUEST_DIFF")
    entries = [{**item, "scopes": sorted({
        classify_path(p)[0] for p in (item["old_path"], item["new_path"]) if p
    })} for item in changes]
    fingerprint = hashlib.sha256(
        json.dumps(entries, sort_keys=True, ensure_ascii=False,
                   separators=(",", ":")).encode("utf-8")
    ).hexdigest()
    return {
        "schema": "osgard.pr-boundary/1",
        "base_sha": base,
        "head_sha": head,
        "merge_base_sha": common,
        "diff_scope": "MERGE_BASE_TO_HEAD_ALL_COMMITS",
        "change_count": len(changes),
        "change_set_sha256": fingerprint,
        "scopes": {key: {"change_count": len(scopes[key]),
                         "changes": scopes[key]} for key in sorted(scopes)},
        "policy_flags": sorted(policy_flags),
        "eligible_for_isolated_nonproduction_review": not policy_flags,
        "independent_review_completed": False,
        "original_180_tasks_accepted": 0,
        "merge_authorized": False,
        "production_authorized": False,
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo", default=".")
    parser.add_argument("--base-sha", required=True)
    parser.add_argument("--head-sha", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--enforce", action="store_true",
                        help="Exit 3 if any review boundary is violated")
    args = parser.parse_args(argv)
    try:
        report = audit(Path(args.repo), args.base_sha, args.head_sha)
        output = Path(args.output)
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_text(
            json.dumps(report, ensure_ascii=False, sort_keys=True, indent=2) + "\n",
            encoding="utf-8",
        )
        print(json.dumps({
            "changes": report["change_count"],
            "scopes": sorted(report["scopes"]),
            "flags": report["policy_flags"],
            "eligible_for_isolated_review":
                report["eligible_for_isolated_nonproduction_review"],
            "production_authorized": False,
        }, ensure_ascii=False))
        return 3 if args.enforce and report["policy_flags"] else 0
    except (BoundaryError, OSError) as exc:
        print("PR_BOUNDARY_NO_GO: " + str(exc), file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
