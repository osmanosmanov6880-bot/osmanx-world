"""OSGARD M182 independent-input admission preflight.

IMPORTANT: This library never accepts a production release. It checks local
structures and emits evidence for a separate human / trusted GitHub review.
It does not extract ZIPs, run product code, approve tasks or mutate services.
"""
from __future__ import annotations

from collections import Counter, defaultdict, deque
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import unicodedata
import zipfile

EXPECTED_M181_SHA256 = "c6d0ff3ff9caa435e6928244ab70ecee8156747306ac3174faca82702be2969a"
EXPECTED_M180_COMMIT = "e8f88465d98c966bd6931883cc5c873b9fcd94a1"
REPORTED_M181_COMMIT = "ff5e6de7e9614add995d11a7330fc2f13d2c1206"
TEAMS = ("TITAN", "NEXUS", "COMMERCE", "EXPERIENCE", "GENESIS", "ORBITAL")
SEVERITIES = ("P0", "P1")
SHA64 = re.compile(r"^[0-9a-f]{64}$")
SHA40 = re.compile(r"^[0-9a-f]{40}$")
GITHUB_REPO = re.compile(r"^https://github\.com/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+(?:\.git)?$")
MAX_ZIP_BYTES = 2_000_000_000
MAX_MEMBER_BYTES = 250_000_000
MAX_TOTAL_UNCOMPRESSED = 2_000_000_000
MAX_MEMBERS = 20000
MAX_RATIO = 250
CHUNK = 1024 * 1024


def timestamp():
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


def sha256_file(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for piece in iter(lambda: f.read(CHUNK), b""):
            h.update(piece)
    return h.hexdigest()


def safe_member_name(name):
    """Validate a ZIP member for cross-platform safe identity without extracting."""
    if not isinstance(name, str) or not name or "\\" in name or "\x00" in name:
        return False, "invalid name or backslash"
    if name.startswith("/") or name.startswith("~") or re.match(r"^[a-zA-Z]:", name):
        return False, "absolute, drive or home path"
    if unicodedata.normalize("NFC", name) != name:
        return False, "non-canonical unicode path"
    if any(unicodedata.category(c) in ("Cc", "Cf") for c in name):
        return False, "control or invisible-format character"
    if len(name) > 1024:
        return False, "path too long"
    segments = name.rstrip("/").split("/")
    if not segments or any(s in ("", ".", "..") for s in segments):
        return False, "empty or traversal segment"
    if any(s.endswith((" ", ".")) for s in segments):
        return False, "Windows trailing space or dot"
    for segment in segments:
        stem = segment.split(".")[0].casefold()
        if stem in {"con", "prn", "aux", "nul", "com1", "com2", "com3", "com4",
                    "com5", "com6", "com7", "com8", "com9", "lpt1", "lpt2", "lpt3",
                    "lpt4", "lpt5", "lpt6", "lpt7", "lpt8", "lpt9"}:
            return False, "reserved Windows basename"
        if ":" in segment:
            return False, "Windows alternate stream"
    return True, None


def _finding(code, status, detail):
    return {"code": code, "status": status, "detail": detail}


def _missing(path, code):
    return {"status": "BLOCKED", "findings": [_finding(code, "BLOCKED", f"Required file unavailable: {path}")]}


def inspect_zip(path, expected_sha256=EXPECTED_M181_SHA256):
    """Safe read-only inspection. Read payload only after full archive SHA PIN matches."""
    result = {"path": str(path) if path else None, "status": "BLOCKED", "sha256": None,
              "file_count": 0, "directory_count": 0, "findings": [], "members": []}
    if not path or not Path(path).is_file():
        result["findings"].append(_finding("M181_ARCHIVE_MISSING", "BLOCKED", "M181 ZIP not available in this runtime"))
        return result
    p = Path(path)
    if p.is_symlink() or not p.is_file() or p.stat().st_size > MAX_ZIP_BYTES:
        result["findings"].append(_finding("ARCHIVE_TYPE_OR_SIZE", "BLOCKED", "symlink, nonfile or oversized archive"))
        return result
    if not isinstance(expected_sha256, str) or not SHA64.fullmatch(expected_sha256):
        result["findings"].append(_finding("PIN_INVALID", "BLOCKED", "expected SHA256 is not a 64-char lowercase hex digest"))
        return result
    result["sha256"] = sha256_file(p)
    if result["sha256"] != expected_sha256:
        result["findings"].append(_finding("SHA256_MISMATCH", "BLOCKED", "archive differs from expected pinned bytes; payload is not read"))
        return result
    try:
        with zipfile.ZipFile(p, "r") as z:
            infos = z.infolist()
            if len(infos) > MAX_MEMBERS:
                result["findings"].append(_finding("MEMBER_LIMIT", "BLOCKED", "archive exceeds entry count limit"))
                return result
            seen = set()
            all_file_paths = set()
            all_dir_paths = set()
            total_size = 0
            # All metadata validation precedes any decompression.
            for info in infos:
                name = info.filename
                ok, why = safe_member_name(name)
                if not ok:
                    result["findings"].append(_finding("UNSAFE_PATH", "BLOCKED", f"{name!r}: {why}"))
                    continue
                canon = name.rstrip("/").casefold()
                if canon in seen:
                    result["findings"].append(_finding("DUPLICATE_PATH", "BLOCKED", f"case-insensitive duplicate: {name}"))
                    continue
                seen.add(canon)
                raw_type = stat.S_IFMT(info.external_attr >> 16) if info.create_system == 3 else 0
                if raw_type and raw_type not in (stat.S_IFREG, stat.S_IFDIR):
                    result["findings"].append(_finding("SPECIAL_MEMBER", "BLOCKED", f"symlink/device/fifo: {name}"))
                if info.flag_bits & 1:
                    result["findings"].append(_finding("ENCRYPTED_MEMBER", "BLOCKED", f"encrypted entry: {name}"))
                if info.file_size > MAX_MEMBER_BYTES:
                    result["findings"].append(_finding("MEMBER_SIZE", "BLOCKED", f"oversized entry: {name}"))
                total_size += info.file_size
                if total_size > MAX_TOTAL_UNCOMPRESSED:
                    result["findings"].append(_finding("TOTAL_SIZE", "BLOCKED", "archive exceeds total uncompressed limit"))
                if info.file_size > 1024 * 1024 and info.file_size / max(info.compress_size, 1) > MAX_RATIO:
                    result["findings"].append(_finding("COMPRESSION_RATIO", "BLOCKED", f"suspicious decompression ratio: {name}"))
                if info.is_dir():
                    all_dir_paths.add(canon)
                else:
                    all_file_paths.add(canon)
            for path_casefold in all_file_paths:
                segments = path_casefold.split("/")
                for i in range(1, len(segments)):
                    if "/".join(segments[:i]) in all_file_paths:
                        result["findings"].append(_finding("FILE_DIR_COLLISION", "BLOCKED", f"file used as parent directory: {path_casefold}"))
                        break
            if any(f["status"] == "BLOCKED" for f in result["findings"]):
                return result
            if not infos:
                result["findings"].append(_finding("EMPTY_ZIP", "BLOCKED", "archive has no members"))
                return result
            for info in infos:
                if info.is_dir():
                    result["directory_count"] += 1
                    continue
                digest = hashlib.sha256()
                # Reading through ZipExtFile verifies CRC; no extraction to disk.
                with z.open(info, "r") as member:
                    for piece in iter(lambda: member.read(CHUNK), b""):
                        digest.update(piece)
                result["file_count"] += 1
                result["members"].append({"path": info.filename, "size": info.file_size,
                                          "sha256": digest.hexdigest()})
    except (OSError, zipfile.BadZipFile, zipfile.LargeZipFile, RuntimeError, ValueError, EOFError) as exc:
        result["findings"].append(_finding("ARCHIVE_READ_ERROR", "BLOCKED", type(exc).__name__))
        return result
    result["status"] = "LOCAL_VERIFIED"
    result["findings"].append(_finding("ZIP_READ_ONLY_CHECK", "LOCAL_PASS", "SHA pin, CRC and path/size checks passed"))
    return result


def read_json(path):
    if not path or not Path(path).is_file():
        raise FileNotFoundError(str(path))
    if Path(path).is_symlink():
        raise ValueError("symbolic-link JSON input is not permitted")
    if Path(path).stat().st_size > 20_000_000:
        raise ValueError("JSON too large")
    # Prevent silent replacement of duplicate JSON keys.
    def no_duplicates(pairs):
        out = {}
        for key, value in pairs:
            if key in out:
                raise ValueError("duplicate JSON key: " + key)
            out[key] = value
        return out
    with open(path, "r", encoding="utf-8") as file:
        return json.load(file, object_pairs_hook=no_duplicates)


def _load_kind(path, expected, code):
    try:
        obj = read_json(path)
    except (OSError, ValueError, json.JSONDecodeError) as exc:
        return None, {"status": "BLOCKED", "findings": [_finding(code, "BLOCKED", f"Untrusted or missing input: {type(exc).__name__}")]}
    if not isinstance(obj, dict) or not isinstance(obj.get(expected), list):
        return None, {"status": "BLOCKED", "findings": [_finding(code, "BLOCKED", f"Root must contain list: {expected}")]}
    return obj, None


def verify_board(path):
    obj, error = _load_kind(path, "tasks", "BOARD_MISSING_OR_INVALID")
    if error:
        return error
    tasks = obj["tasks"]
    findings = []
    if len(tasks) != 180:
        findings.append(_finding("BOARD_COUNT", "BLOCKED", f"Expected 180, observed {len(tasks)}"))
    ids = set()
    teams = Counter()
    deps = defaultdict(list)
    edges = 0
    for i, item in enumerate(tasks):
        if not isinstance(item, dict):
            findings.append(_finding("BOARD_TASK_TYPE", "BLOCKED", f"task {i} is not an object"))
            continue
        ident = item.get("id")
        team = item.get("team")
        parents = item.get("parents", item.get("dependencies", item.get("depends_on")))
        if not isinstance(ident, str) or not ident.strip() or ident in ids:
            findings.append(_finding("BOARD_ID", "BLOCKED", f"missing/duplicate task id at index {i}"))
            continue
        ids.add(ident)
        if team not in TEAMS:
            findings.append(_finding("BOARD_TEAM", "BLOCKED", f"unknown team for {ident}: {team!r}"))
        else:
            teams[team] += 1
        if not isinstance(parents, list) or any(not isinstance(p, str) for p in parents) or len(set(parents)) != len(parents):
            findings.append(_finding("BOARD_DEPENDENCIES", "BLOCKED", f"missing, invalid or duplicate parents: {ident}"))
            continue
        deps[ident] = parents
        edges += len(parents)
    if len(ids) == len(tasks):
        for ident, parents in deps.items():
            for parent in parents:
                if parent not in ids:
                    findings.append(_finding("BOARD_UNKNOWN_PARENT", "BLOCKED", f"{ident} -> {parent}"))
                if parent == ident:
                    findings.append(_finding("BOARD_SELF_DEP", "BLOCKED", f"{ident} -> itself"))
        indegrees = {ident: 0 for ident in ids}
        downstream = defaultdict(list)
        for ident, parents in deps.items():
            for parent in parents:
                if parent in ids:
                    indegrees[ident] += 1
                    downstream[parent].append(ident)
        q = deque(ident for ident, degree in indegrees.items() if degree == 0)
        visited = 0
        while q:
            node = q.popleft()
            visited += 1
            for child in downstream[node]:
                indegrees[child] -= 1
                if indegrees[child] == 0:
                    q.append(child)
        if visited < len(ids):
            findings.append(_finding("BOARD_CYCLE", "BLOCKED", "dependencies contain at least one cycle"))
    if edges != 294:
        findings.append(_finding("BOARD_EDGE_COUNT", "BLOCKED", f"Expected 294, observed {edges}"))
    for team in TEAMS:
        if teams[team] != 30:
            findings.append(_finding("BOARD_TEAM_COUNT", "BLOCKED", f"{team}: expected 30, observed {teams[team]}"))
    if obj.get("source_authority") != "M181_ORIGINAL_VERIFIED":
        findings.append(_finding("BOARD_ORIGIN", "BLOCKED", "original M181 provenance not attached/verified"))
    return {"status": "BLOCKED" if findings else "LOCAL_STRUCTURE_PASS", "task_count": len(tasks),
            "edge_count": edges, "team_counts": dict(teams), "findings": findings}


def verify_conflicts(path):
    obj, error = _load_kind(path, "conflicts", "CONFLICTS_MISSING_OR_INVALID")
    if error:
        return error
    c = obj["conflicts"]
    findings = []
    sizes = Counter()
    ids = set()
    for i, item in enumerate(c):
        if not isinstance(item, dict):
            findings.append(_finding("CONFLICT_TYPE", "BLOCKED", f"record {i} is not object"))
            continue
        ident = item.get("id")
        if not isinstance(ident, str) or not ident or ident in ids:
            findings.append(_finding("CONFLICT_ID", "BLOCKED", f"duplicate/absent ID at {i}"))
        else:
            ids.add(ident)
        severity = item.get("severity")
        if not isinstance(severity, str) or severity not in SEVERITIES:
            findings.append(_finding("CONFLICT_SEVERITY", "BLOCKED", f"invalid severity: {ident}"))
        else:
            sizes[severity] += 1
        filepath = item.get("path")
        if not isinstance(filepath, str) or not safe_member_name(filepath)[0] or filepath.endswith("/"):
            findings.append(_finding("CONFLICT_PATH", "BLOCKED", f"missing/unsafe path: {ident}"))
        for side in ("left_sha256", "right_sha256"):
            if not isinstance(item.get(side), str) or not SHA64.fullmatch(item[side]):
                findings.append(_finding("CONFLICT_DIGEST", "BLOCKED", f"missing {side}: {ident}"))
        if item.get("resolution") not in ("KEEP_LEFT", "KEEP_RIGHT", "MANUAL_MERGE"):
            findings.append(_finding("CONFLICT_UNRESOLVED", "BLOCKED", f"unresolved: {ident}"))
        if not item.get("reviewer") or not item.get("author") or item.get("reviewer") == item.get("author"):
            findings.append(_finding("CONFLICT_INDEPENDENCE", "BLOCKED", f"no separate author and reviewer: {ident}"))
        if not isinstance(item.get("review_pr_url"), str) or not item["review_pr_url"].startswith("https://github.com/") or "/pull/" not in item["review_pr_url"] or not isinstance(item.get("review_commit_sha"), str) or not SHA40.fullmatch(item["review_commit_sha"]):
            findings.append(_finding("CONFLICT_EXTERNAL_PROOF", "BLOCKED", f"no well-formed PR/commit evidence: {ident}"))
    if len(c) != 28 or sizes.get("P0") != 17 or sizes.get("P1") != 11:
        findings.append(_finding("CONFLICT_CARDINALITY", "BLOCKED", f"expected 28 = 17 P0/11 P1, saw {len(c)}, {dict(sizes)}"))
    # Never elevate local strings into independent GitHub reviews.
    if not findings:
        findings.append(_finding("CONFLICT_ONLINE_REVIEW", "BLOCKED", "Independent PR reviews not verified via connected GitHub"))
    return {"status": "BLOCKED", "count": len(c), "severity_counts": dict(sizes), "findings": findings}


def verify_contracts(path):
    obj, error = _load_kind(path, "contracts", "CONTRACTS_MISSING_OR_INVALID")
    if error:
        return error
    records = obj["contracts"]
    findings = []
    ids = set()
    for i, row in enumerate(records):
        if not isinstance(row, dict) or not isinstance(row.get("id"), str) or row["id"] in ids:
            findings.append(_finding("CONTRACT_ID", "BLOCKED", f"invalid/duplicate ID: {i}"))
            continue
        ids.add(row["id"])
        if not row.get("producer") or not row.get("consumer") or not row.get("schema_sha256") or not row.get("test_run_url"):
            findings.append(_finding("CONTRACT_EVIDENCE", "BLOCKED", f"missing producer, consumer, pinned schema or test run: {row['id']}"))
        if not isinstance(row.get("schema_sha256"), str) or not SHA64.fullmatch(row["schema_sha256"]):
            findings.append(_finding("CONTRACT_SCHEMA_PIN", "BLOCKED", f"invalid schema sha: {row['id']}"))
    if len(records) != 9:
        findings.append(_finding("CONTRACT_COUNT", "BLOCKED", f"Expected 9, observed {len(records)}"))
    if not findings:
        findings.append(_finding("CONTRACT_EXTERNAL_E2E", "BLOCKED", "Nine real consumer/provider E2E runs not independently verified"))
    return {"status": "BLOCKED", "count": len(records), "findings": findings}


def verify_upstreams(path):
    obj, error = _load_kind(path, "teams", "UPSTREAMS_MISSING_OR_INVALID")
    if error:
        return error
    rows = obj["teams"]
    findings = []
    seen = set()
    for row in rows:
        if not isinstance(row, dict) or row.get("team") not in TEAMS:
            findings.append(_finding("UPSTREAM_TEAM", "BLOCKED", "unknown team row"))
            continue
        team = row["team"]
        if team in seen:
            findings.append(_finding("UPSTREAM_DUPLICATE", "BLOCKED", f"duplicate team {team}"))
        seen.add(team)
        repo = row.get("repository_url")
        if not isinstance(repo, str) or not GITHUB_REPO.fullmatch(repo):
            findings.append(_finding("UPSTREAM_UNRESOLVED", "BLOCKED", f"{team}: canonical repository not established"))
        sha = row.get("head_sha")
        if not isinstance(sha, str) or not SHA40.fullmatch(sha):
            findings.append(_finding("UPSTREAM_HEAD_UNVERIFIED", "BLOCKED", f"{team}: exact 40-char Git SHA not supplied"))
        if not row.get("owner") or not row.get("owner_approval_pr"):
            findings.append(_finding("UPSTREAM_OWNER", "BLOCKED", f"{team}: repository owner approval unavailable"))
    if seen != set(TEAMS) or len(rows) != 6:
        findings.append(_finding("UPSTREAM_TEAM_COUNT", "BLOCKED", f"six distinct teams required, observed {sorted(seen)}"))
    if not findings:
        findings.append(_finding("UPSTREAM_ONLINE_VERIFICATION", "BLOCKED", "Exact SHA/ownership/PR review must be confirmed live via GitHub"))
    return {"status": "BLOCKED", "count": len(rows), "findings": findings}


def audit(archive=None, board=None, conflicts=None, contracts=None, upstreams=None,
          expected_sha256=EXPECTED_M181_SHA256):
    checks = {
        "archive": inspect_zip(archive, expected_sha256),
        "task_board": verify_board(board),
        "conflicts": verify_conflicts(conflicts),
        "api_contracts": verify_contracts(contracts),
        "canonical_upstreams": verify_upstreams(upstreams),
    }
    blockers = []
    for name, item in checks.items():
        for finding in item.get("findings", []):
            if finding["status"] == "BLOCKED":
                blockers.append({"gate": name, **finding})
    blockers.append({"gate": "production", "code": "INDEPENDENT_HUMAN_AND_STAGING_GATE", "status": "BLOCKED",
                     "detail": "Local tool cannot independently authorize release, physical QA or production access"})
    return {"schema": "osgard.m182.audit/1", "generated_at_utc": timestamp(),
            "release_decision": "PRODUCTION_NO_GO", "independently_accepted_tasks": 0,
            "claims_policy": "Observed local inputs only; prior 176 tests are user-reported, not rerun",
            "reported_source": {"m180_commit": EXPECTED_M180_COMMIT, "m181_local_commit": REPORTED_M181_COMMIT,
                                "m181_zip_sha256": EXPECTED_M181_SHA256, "status": "USER_REPORTED_UNVERIFIED"},
            "checks": checks, "blockers": blockers}


def dump_json(path, obj):
    p = Path(path)
    p.parent.mkdir(parents=True, exist_ok=True)
    text = json.dumps(obj, ensure_ascii=False, sort_keys=True, indent=2) + "\n"
    # Immutable-by-default evidence: refuse to overwrite.
    with p.open("x", encoding="utf-8") as file:
        file.write(text)
    return p


def compare_archives(left, right, left_sha256, right_sha256):
    """Compare SHA-pinned, safe ZIPs without extracting, merging or trusting paths.

    A comparison is a *candidate diff*, not a license/conflict/production review.
    If either input fails admission, no raw member data from the other archive
    are represented as a trusted source comparison.
    """
    lhs = inspect_zip(left, left_sha256)
    rhs = inspect_zip(right, right_sha256)
    ret = {"schema": "osgard.m182.zip-diff/1", "generated_at_utc": timestamp(),
           "status": "BLOCKED", "left": {k: lhs[k] for k in ("status", "path", "sha256", "file_count")},
           "right": {k: rhs[k] for k in ("status", "path", "sha256", "file_count")},
           "added": [], "removed": [], "modified": [], "unchanged": 0,
           "findings": []}
    if lhs["status"] != "LOCAL_VERIFIED" or rhs["status"] != "LOCAL_VERIFIED":
        ret["findings"].append(_finding("DIFF_ADMISSION_FAILED", "BLOCKED",
                                        "Both exact ZIP pins and safe CRC/path checks are required"))
        ret["findings"] += lhs["findings"] if lhs["status"] != "LOCAL_VERIFIED" else []
        ret["findings"] += rhs["findings"] if rhs["status"] != "LOCAL_VERIFIED" else []
        return ret
    amap = {m["path"]: m for m in lhs["members"]}
    bmap = {m["path"]: m for m in rhs["members"]}
    for name in sorted(amap.keys() | bmap.keys()):
        a = amap.get(name)
        b = bmap.get(name)
        if a is None:
            ret["added"].append(b)
        elif b is None:
            ret["removed"].append(a)
        elif a["sha256"] != b["sha256"]:
            ret["modified"].append({"path": name, "before_sha256": a["sha256"],
                                    "after_sha256": b["sha256"],
                                    "before_size": a["size"], "after_size": b["size"]})
        else:
            ret["unchanged"] += 1
    ret["status"] = "LOCAL_DIFF_ONLY"
    ret["findings"].append(_finding("NO_AUTOMATIC_MERGE", "REVIEW_REQUIRED",
                                    "Candidate byte diff requires separate codeowner and independent review"))
    return ret
