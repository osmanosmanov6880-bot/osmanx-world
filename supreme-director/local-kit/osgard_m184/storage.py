"""Fail-closed local-only task control plane, not production acceptance.

SQLite audit hashes are integrity checks, NOT cryptographic attestation: anyone
with write access to the DB can rewrite its contents and recompute hashes.
"""
from __future__ import annotations

from collections import Counter, defaultdict, deque
from contextlib import contextmanager, closing
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import re
import sqlite3
import stat

from osgard_m183.core import validate_workplan
from osgard_m182.core import EXPECTED_M181_SHA256, TEAMS

SHA40 = re.compile(r"[0-9a-f]{40}\Z")
SHA64 = re.compile(r"[0-9a-f]{64}\Z")
REPOSITORY = re.compile(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+\Z")
BRANCH = re.compile(r"[A-Za-z0-9_.][A-Za-z0-9_./-]{0,127}\Z")
CONFLICT_STATES = {"UNRESOLVED", "TRIAGED", "REVIEW_PENDING", "QUARANTINED"}
CONFLICT_ALLOWED = {
    "UNRESOLVED": {"TRIAGED", "QUARANTINED"},
    "TRIAGED": {"REVIEW_PENDING", "QUARANTINED"},
    "REVIEW_PENDING": {"QUARANTINED"},
    "QUARANTINED": set(),
}
SCHEMA_VERSION = "osgard.m184.local-state/1"
GENESIS = "0" * 64


def utcnow():
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


def encode(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def sha(data):
    return hashlib.sha256(data).hexdigest()


def read_pinned_json(path, max_bytes=5_000_000):
    p = Path(path)
    if not p.is_file() or p.is_symlink():
        raise ValueError("input must be a regular nonsymlink file")
    s = p.stat()
    if not 0 < s.st_size <= max_bytes:
        raise ValueError("input byte count out of bounds")
    raw = p.read_bytes()
    try:
        return json.loads(raw), sha(raw)
    except (ValueError, UnicodeDecodeError) as exc:
        raise ValueError("invalid JSON input") from exc


def validate_conflicts(value):
    items = value.get("conflicts") if isinstance(value, dict) else None
    if not isinstance(items, list) or len(items) != 28:
        raise ValueError("28 conflict slots required")
    severities = Counter()
    for i, item in enumerate(items, 1):
        if not isinstance(item, dict) or item.get("id") != f"M181-CONFLICT-{i:02d}":
            raise ValueError("conflict id sequence invalid")
        if item.get("severity") not in {"P0", "P1"} or item.get("resolution") != "UNRESOLVED":
            raise ValueError("conflict severity or state invalid")
        if any(item.get(k) is not None for k in ("path", "author", "reviewer", "review_commit_sha", "review_pr_url", "left_sha256", "right_sha256")):
            raise ValueError("provisional conflicts must not claim source or approval")
        severities[item["severity"]] += 1
    if severities != {"P0": 17, "P1": 11}:
        raise ValueError("17 P0 and 11 P1 expected")
    return items


def validate_contracts(value):
    items = value.get("contracts") if isinstance(value, dict) else None
    if not isinstance(items, list) or len(items) != 9:
        raise ValueError("nine contract placeholders required")
    for i, item in enumerate(items, 1):
        if not isinstance(item, dict) or item.get("id") != f"CONTRACT-{i:02d}":
            raise ValueError("contract id sequence invalid")
        if any(item.get(k) is not None for k in ("producer", "consumer", "schema_sha256", "test_run_url")):
            raise ValueError("contract placeholder must remain unverified")
    return items


def audit_digest(sequence, at, actor, action, entity, payload, previous):
    return sha(encode([sequence, at, actor, action, entity, payload, previous]).encode("utf-8"))


def _validate_text(value, label, limit=2000):
    if not isinstance(value, str) or not value.strip() or len(value) > limit or "\x00" in value:
        raise ValueError(f"invalid {label}")
    return value.strip()


class DirectorDB:
    def __init__(self, path):
        self.path = Path(path)
        if self.path.is_symlink() or (self.path.exists() and not self.path.is_file()):
            raise ValueError("DB path must be regular and not a symlink")
        if not self.path.parent.exists() or self.path.parent.is_symlink():
            raise ValueError("DB parent must already exist and must not be a symlink")

    @contextmanager
    def connect(self, write=False):
        if not self.path.is_file() and not write:
            raise ValueError("database is not initialized")
        con = sqlite3.connect(str(self.path), timeout=10, isolation_level=None)
        con.row_factory = sqlite3.Row
        con.execute("PRAGMA busy_timeout=10000")
        con.execute("PRAGMA foreign_keys=ON")
        try:
            if write:
                con.execute("BEGIN IMMEDIATE")
            yield con
            if write:
                con.commit()
        except Exception:
            if write:
                con.rollback()
            raise
        finally:
            con.close()

    def _require_ready(self, con):
        row = con.execute("SELECT value FROM meta WHERE key='schema'").fetchone()
        if row is None or row[0] != SCHEMA_VERSION:
            raise ValueError("unrecognized or uninitialized schema")

    @staticmethod
    def _audit(con, actor, action, entity, payload):
        last = con.execute("SELECT sequence, event_sha FROM audit ORDER BY sequence DESC LIMIT 1").fetchone()
        seq = int(last["sequence"]) + 1 if last else 1
        previous = last["event_sha"] if last else GENESIS
        timestamp = utcnow()
        digest = audit_digest(seq, timestamp, actor, action, entity, payload, previous)
        con.execute("INSERT INTO audit VALUES (?,?,?,?,?,?,?,?)",
                    (seq, timestamp, actor, action, entity, encode(payload), previous, digest))

    def bootstrap(self, workplan, conflicts, contracts, observations=None):
        plan, plan_hash = read_pinned_json(workplan)
        c_obj, conflicts_hash = read_pinned_json(conflicts)
        x_obj, contracts_hash = read_pinned_json(contracts)
        v = validate_workplan(workplan)
        if v["status"] != "VALID_LOCAL_PROPOSAL_ONLY":
            raise ValueError("proposed board validation failed")
        ci, co = validate_conflicts(c_obj), validate_contracts(x_obj)
        obs = []
        obs_hash = None
        if observations is not None:
            o, obs_hash = read_pinned_json(observations)
            obs = o.get("observed_repositories") if isinstance(o, dict) else None
            if not isinstance(obs, list) or len(obs) > 50:
                raise ValueError("invalid observations list")
            for row in obs:
                if (not isinstance(row, dict) or not REPOSITORY.fullmatch(str(row.get("repo", "")))
                    or not SHA40.fullmatch(str(row.get("observed_head_sha", "")))
                    or not BRANCH.fullmatch(str(row.get("branch", "")))
                    or row.get("team_assignment") is not None):
                    raise ValueError("invalid/unverified repository observation")
        inputs = {"workplan_sha256": plan_hash, "conflicts_sha256": conflicts_hash,
                  "contracts_sha256": contracts_hash, "observations_sha256": obs_hash or "NONE"}
        with closing(sqlite3.connect(str(self.path))) as journal:
            journal.execute("PRAGMA journal_mode=WAL")
            journal.execute("PRAGMA synchronous=FULL")
        with self.connect(write=True) as con:
            con.executescript("""
              CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
              CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, team TEXT NOT NULL, phase TEXT NOT NULL,
                 title TEXT NOT NULL, dependencies TEXT NOT NULL, status TEXT NOT NULL CHECK(status='NOT_ACCEPTED'));
              CREATE TABLE IF NOT EXISTS conflicts (id TEXT PRIMARY KEY, severity TEXT NOT NULL, status TEXT NOT NULL,
                 updated_at TEXT, note_count INTEGER NOT NULL DEFAULT 0);
              CREATE TABLE IF NOT EXISTS contracts (id TEXT PRIMARY KEY, status TEXT NOT NULL CHECK(status='UNVERIFIED'));
              CREATE TABLE IF NOT EXISTS notes (id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL,
                 target TEXT NOT NULL, actor TEXT NOT NULL, note TEXT NOT NULL, at TEXT NOT NULL);
              CREATE TABLE IF NOT EXISTS observations (id INTEGER PRIMARY KEY AUTOINCREMENT, repo TEXT NOT NULL,
                 branch TEXT NOT NULL, sha TEXT NOT NULL, actor TEXT NOT NULL, at TEXT NOT NULL,
                 verification TEXT NOT NULL CHECK(verification='UNVERIFIED'), team TEXT DEFAULT NULL);
              CREATE TABLE IF NOT EXISTS evidence (id INTEGER PRIMARY KEY AUTOINCREMENT, target TEXT NOT NULL,
                 relative_path TEXT NOT NULL, sha256 TEXT NOT NULL, actor TEXT NOT NULL, at TEXT NOT NULL,
                 status TEXT NOT NULL CHECK(status='LOCAL_SHA_ONLY'));
              CREATE TABLE IF NOT EXISTS audit (sequence INTEGER PRIMARY KEY, at TEXT NOT NULL, actor TEXT NOT NULL,
                 action TEXT NOT NULL, entity TEXT NOT NULL, payload TEXT NOT NULL, previous_sha TEXT NOT NULL,
                 event_sha TEXT NOT NULL);
              CREATE TRIGGER IF NOT EXISTS audit_no_update BEFORE UPDATE ON audit BEGIN
                SELECT RAISE(ABORT, 'audit append only'); END;
              CREATE TRIGGER IF NOT EXISTS audit_no_delete BEFORE DELETE ON audit BEGIN
                SELECT RAISE(ABORT, 'audit append only'); END;
            """)
            # sqlite3 executescript commits the prior transaction; start an
            # IMMEDIATE one for the entire bootstrap data import.
            con.execute("BEGIN IMMEDIATE")
            row = con.execute("SELECT value FROM meta WHERE key='schema'").fetchone()
            if row:
                self._require_ready(con)
                existing = {r["key"]: r["value"] for r in con.execute("SELECT key,value FROM meta")}
                if any(existing.get(k) != v for k, v in inputs.items()):
                    raise ValueError("already initialized with different input hashes")
                return {"status": "IDEMPOTENT_NO_CHANGES", "input_hashes": inputs}
            if con.execute("SELECT count(*) FROM tasks").fetchone()[0]:
                raise ValueError("non-empty uninitialized database")
            for task in plan["tasks"]:
                con.execute("INSERT INTO tasks VALUES (?,?,?,?,?,?)",
                            (task["id"], task["team"], task["phase"], task["description"],
                             encode(task["local_dependencies"]), "NOT_ACCEPTED"))
            for conflict in ci:
                con.execute("INSERT INTO conflicts (id, severity,status) VALUES(?,?,?)",
                            (conflict["id"], conflict["severity"], "UNRESOLVED"))
            for contract in co:
                con.execute("INSERT INTO contracts VALUES (?,?)", (contract["id"], "UNVERIFIED"))
            for repo in obs:
                con.execute("INSERT INTO observations (repo,branch,sha,actor,at,verification) VALUES(?,?,?,?,?,?)",
                            (repo["repo"], repo["branch"], repo["observed_head_sha"],
                             "M183_OPERATOR_SNAPSHOT", utcnow(), "UNVERIFIED"))
            values = {"schema": SCHEMA_VERSION, "production_authorized": "false",
                      "product_integration_verified": "false", "original_m181_sha_expected": EXPECTED_M181_SHA256,
                      **inputs}
            con.executemany("INSERT INTO meta VALUES (?,?)", list(values.items()))
            self._audit(con, "system-bootstrap", "BOOTSTRAP", "LOCAL_PLAN_ONLY",
                        {"counts": {"tasks": 180, "conflicts": 28, "contracts": 9, "observations": len(obs)},
                         "input_hashes": inputs, "production_authorized": False})
            return {"status": "BOOTSTRAPPED_LOCAL_ONLY", "input_hashes": inputs}

    def tasks(self, team=None, q=None, limit=200):
        if team is not None and team not in TEAMS:
            raise ValueError("unknown team")
        if q is not None and (not isinstance(q, str) or len(q) > 100):
            raise ValueError("invalid search")
        if not isinstance(limit, int) or not 1 <= limit <= 200:
            raise ValueError("invalid limit")
        with self.connect() as con:
            self._require_ready(con)
            clauses, args = [], []
            if team:
                clauses.append("team = ?")
                args.append(team)
            if q:
                clauses.append("(id LIKE ? OR title LIKE ?)")
                args += ["%" + q + "%"] * 2
            where = " WHERE " + " AND ".join(clauses) if clauses else ""
            rows = con.execute("SELECT * FROM tasks" + where + " ORDER BY team, phase, id LIMIT ?", (*args, limit))
            return [{**dict(r), "dependencies": json.loads(r["dependencies"])} for r in rows]

    def conflicts(self):
        with self.connect() as con:
            self._require_ready(con)
            return [dict(r) for r in con.execute("SELECT * FROM conflicts ORDER BY id")]

    def contracts(self):
        with self.connect() as con:
            self._require_ready(con)
            return [dict(r) for r in con.execute("SELECT * FROM contracts ORDER BY id")]

    def observations(self):
        with self.connect() as con:
            self._require_ready(con)
            return [dict(r) for r in con.execute("SELECT * FROM observations ORDER BY id DESC LIMIT 100")]

    def notes(self, kind=None, target=None, limit=50):
        if kind not in {None, "task", "conflict", "contract"} or not isinstance(limit, int) or not 1 <= limit <= 200:
            raise ValueError("invalid notes query")
        with self.connect() as con:
            self._require_ready(con)
            where, args = [], []
            if kind:
                where.append("kind=?"); args.append(kind)
            if target:
                where.append("target=?"); args.append(target)
            rows = con.execute("SELECT * FROM notes" + (" WHERE " + " AND ".join(where) if where else "") +
                               " ORDER BY id DESC LIMIT ?", (*args, limit))
            return [dict(x) for x in rows]

    @staticmethod
    def _entity_table(kind):
        return {"task": "tasks", "conflict": "conflicts", "contract": "contracts"}.get(kind)

    def add_note(self, kind, target, actor, note):
        table = self._entity_table(kind)
        actor = _validate_text(actor, "actor", 60)
        note = _validate_text(note, "note", 2000)
        target = _validate_text(target, "target", 80)
        if table is None:
            raise ValueError("invalid note kind")
        with self.connect(write=True) as con:
            self._require_ready(con)
            if con.execute(f"SELECT 1 FROM {table} WHERE id=?", (target,)).fetchone() is None:
                raise ValueError("target does not exist")
            at = utcnow()
            cursor = con.execute("INSERT INTO notes(kind,target,actor,note,at) VALUES(?,?,?,?,?)",
                                 (kind, target, actor, note, at))
            if kind == "conflict":
                con.execute("UPDATE conflicts SET note_count=note_count+1 WHERE id=?", (target,))
            self._audit(con, actor, "NOTE_ADDED", f"{kind}:{target}", {"note_id": cursor.lastrowid})
            return {"id": cursor.lastrowid, "status": "RECORDED_NOT_APPROVED"}

    def triage_conflict(self, identifier, status, actor, note):
        identifier = _validate_text(identifier, "conflict id", 80)
        actor = _validate_text(actor, "actor", 60)
        note = _validate_text(note, "note", 2000)
        if status not in CONFLICT_STATES:
            raise ValueError("invalid status")
        with self.connect(write=True) as con:
            self._require_ready(con)
            old = con.execute("SELECT status FROM conflicts WHERE id=?", (identifier,)).fetchone()
            if old is None:
                raise ValueError("unknown conflict")
            if status not in CONFLICT_ALLOWED[old["status"]]:
                raise ValueError("transition not allowed")
            con.execute("UPDATE conflicts SET status=?, updated_at=?, note_count=note_count+1 WHERE id=?",
                        (status, utcnow(), identifier))
            cur = con.execute("INSERT INTO notes(kind,target,actor,note,at) VALUES(?,?,?,?,?)",
                              ("conflict", identifier, actor, note, utcnow()))
            self._audit(con, actor, "CONFLICT_TRIAGED", identifier,
                        {"from": old["status"], "to": status, "note_id": cur.lastrowid})
            return {"conflict_id": identifier, "status": status, "production_acceptance": False}

    def observe_source(self, repo, branch, commit_sha, actor):
        actor = _validate_text(actor, "actor", 60)
        if (not isinstance(repo, str) or not REPOSITORY.fullmatch(repo) or
            not isinstance(branch, str) or not BRANCH.fullmatch(branch) or ".." in branch or "//" in branch or
            not isinstance(commit_sha, str) or not SHA40.fullmatch(commit_sha)):
            raise ValueError("invalid repository observation")
        with self.connect(write=True) as con:
            self._require_ready(con)
            cursor = con.execute("INSERT INTO observations(repo,branch,sha,actor,at,verification) VALUES(?,?,?,?,?,?)",
                                 (repo, branch, commit_sha, actor, utcnow(), "UNVERIFIED"))
            self._audit(con, actor, "UNVERIFIED_SOURCE_OBSERVATION", repo,
                        {"observation_id": cursor.lastrowid, "sha": commit_sha})
            return {"id": cursor.lastrowid, "verification": "UNVERIFIED", "team_assignment": None}

    def register_local_evidence(self, target, relative_path, expected_sha, actor, evidence_root):
        actor = _validate_text(actor, "actor", 60)
        target = _validate_text(target, "target", 80)
        if not isinstance(expected_sha, str) or not SHA64.fullmatch(expected_sha):
            raise ValueError("invalid evidence sha")
        if not isinstance(relative_path, str) or not relative_path or "\\" in relative_path or "\x00" in relative_path:
            raise ValueError("invalid evidence path")
        relative = Path(relative_path)
        if relative.is_absolute() or ".." in relative.parts:
            raise ValueError("evidence path traversal")
        root = Path(evidence_root)
        if not root.is_dir() or root.is_symlink():
            raise ValueError("unsafe evidence root")
        root_resolved = root.resolve(strict=True)
        p = root / relative
        try:
            resolved = p.resolve(strict=True)
            resolved.relative_to(root_resolved)
            if any(part.is_symlink() for part in [p, *p.parents] if part != root_resolved and part != root):
                raise ValueError("evidence symlink")
            if not p.is_file() or not stat.S_ISREG(p.stat().st_mode) or p.stat().st_size > 32_000_000:
                raise ValueError("not bounded regular evidence")
            digest = hashlib.sha256(p.read_bytes()).hexdigest()
        except (OSError, ValueError):
            raise ValueError("invalid local evidence file") from None
        if digest != expected_sha:
            raise ValueError("evidence SHA mismatch")
        with self.connect(write=True) as con:
            self._require_ready(con)
            if target not in {"platform", "m181"} and all(con.execute(f"SELECT 1 FROM {table} WHERE id=?", (target,)).fetchone() is None
                                                         for table in ("tasks", "conflicts", "contracts")):
                raise ValueError("invalid evidence target")
            cur = con.execute("INSERT INTO evidence(target,relative_path,sha256,actor,at,status) VALUES(?,?,?,?,?,?)",
                              (target, relative.as_posix(), expected_sha, actor, utcnow(), "LOCAL_SHA_ONLY"))
            self._audit(con, actor, "LOCAL_EVIDENCE_REGISTERED", target,
                        {"evidence_id": cur.lastrowid, "sha": expected_sha})
            return {"id": cur.lastrowid, "status": "LOCAL_SHA_ONLY", "production_acceptance": False}

    def audit(self, limit=80):
        if not isinstance(limit, int) or not 1 <= limit <= 500:
            raise ValueError("invalid audit limit")
        with self.connect() as con:
            self._require_ready(con)
            rows = con.execute("SELECT * FROM audit ORDER BY sequence DESC LIMIT ?", (limit,))
            return [{**dict(x), "payload": json.loads(x["payload"])} for x in rows]

    def summary(self):
        with self.connect() as con:
            self._require_ready(con)
            counts = {t: con.execute(f"SELECT count(*) FROM {t}").fetchone()[0]
                      for t in ("tasks", "conflicts", "contracts", "notes", "observations", "evidence", "audit")}
            team_counts = dict(con.execute("SELECT team,count(*) FROM tasks GROUP BY team").fetchall())
            phase_counts = dict(con.execute("SELECT phase,count(*) FROM tasks GROUP BY phase").fetchall())
            status_counts = dict(con.execute("SELECT status,count(*) FROM conflicts GROUP BY status").fetchall())
            frontier = [x[0] for x in con.execute("SELECT id FROM tasks WHERE dependencies='[]' ORDER BY team")]
            return {"version": "M184", "state": "LOCAL_DIRECTOR_STUDIO", "release": "PRODUCTION_NO_GO",
                    "real_product_integrations": 0, "independent_acceptance": 0,
                    "original_m181_available": False, "canonical_team_upstreams_verified": 0,
                    "counts": counts, "task_team_counts": team_counts, "phase_counts": phase_counts,
                    "conflict_status_counts": status_counts, "read_only_discovery_frontier": frontier,
                    "caution": "180 proposed planning tasks, 28 placeholder conflicts, nine unverified contracts"}

    def doctor(self):
        findings = []
        try:
            with self.connect() as con:
                self._require_ready(con)
                integrity = con.execute("PRAGMA integrity_check").fetchone()[0]
                if integrity != "ok":
                    findings.append("SQLITE_INTEGRITY")
                foreign = con.execute("PRAGMA foreign_key_check").fetchall()
                if foreign:
                    findings.append("SQLITE_FOREIGN_KEYS")
                meta = dict(con.execute("SELECT key,value FROM meta"))
                if meta.get("production_authorized") != "false" or meta.get("product_integration_verified") != "false":
                    findings.append("FALSE_PRODUCTION_AUTHORIZATION")
                tasks = con.execute("SELECT id,team,phase,dependencies,status FROM tasks").fetchall()
                if len(tasks) != 180 or any(t["status"] != "NOT_ACCEPTED" for t in tasks):
                    findings.append("TASK_ACCEPTANCE_INVALID")
                if dict(Counter(t["team"] for t in tasks)) != {team: 30 for team in TEAMS}:
                    findings.append("TEAM_COUNTS")
                if dict(Counter(t["phase"] for t in tasks)) != {"A": 12, "B": 48, "C": 90, "D": 30}:
                    findings.append("PHASE_COUNTS")
                dependencies = {r["id"]: json.loads(r["dependencies"]) for r in tasks}
                if sum(map(len, dependencies.values())) != 174:
                    findings.append("DEPENDENCY_COUNT")
                indeg, children = {t: 0 for t in dependencies}, defaultdict(list)
                for child, parents in dependencies.items():
                    for parent in parents:
                        if parent not in dependencies or parent == child:
                            findings.append("DEPENDENCY_REFERENCE")
                        else:
                            indeg[child] += 1; children[parent].append(child)
                q = deque(k for k,v in indeg.items() if v == 0); seen=0
                while q:
                    x=q.popleft(); seen+=1
                    for nxt in children[x]:
                        indeg[nxt]-=1
                        if indeg[nxt]==0:q.append(nxt)
                if seen != len(dependencies): findings.append("DEPENDENCY_CYCLE")
                cs = con.execute("SELECT id,severity,status,note_count FROM conflicts").fetchall()
                if len(cs) != 28 or dict(Counter(x["severity"] for x in cs)) != {"P0": 17,"P1": 11} or any(x["status"] not in CONFLICT_STATES for x in cs):
                    findings.append("CONFLICTS_INVALID")
                if con.execute("SELECT count(*) FROM contracts WHERE status='UNVERIFIED'").fetchone()[0] != 9:
                    findings.append("CONTRACT_ACCEPTANCE_INVALID")
                if con.execute("SELECT count(*) FROM observations WHERE team IS NOT NULL OR verification!='UNVERIFIED'").fetchone()[0]:
                    findings.append("FALSE_CANONICAL_MAPPING")
                events = con.execute("SELECT * FROM audit ORDER BY sequence").fetchall()
                prev = GENESIS
                for i, r in enumerate(events, 1):
                    try: payload = json.loads(r["payload"])
                    except ValueError:
                        findings.append("AUDIT_INVALID_PAYLOAD");break
                    h = audit_digest(i, r["at"], r["actor"], r["action"], r["entity"], payload, prev)
                    if r["sequence"] != i or r["previous_sha"] != prev or r["event_sha"] != h:
                        findings.append("AUDIT_CHAIN_INVALID");break
                    prev = r["event_sha"]
                if not events or events[0]["action"] != "BOOTSTRAP":
                    findings.append("AUDIT_MISSING_GENESIS")
                expected_notes = sum(r["action"] in {"NOTE_ADDED", "CONFLICT_TRIAGED"} for r in events)
                if con.execute("SELECT count(*) FROM notes").fetchone()[0] != expected_notes:
                    findings.append("NOTE_AUDIT_COUNT_MISMATCH")
                expected_obs = (json.loads(events[0]["payload"])["counts"]["observations"] if events else 0) + sum(r["action"] == "UNVERIFIED_SOURCE_OBSERVATION" for r in events)
                if con.execute("SELECT count(*) FROM observations").fetchone()[0] != expected_obs:
                    findings.append("SOURCE_AUDIT_COUNT_MISMATCH")
                if con.execute("SELECT count(*) FROM evidence").fetchone()[0] != sum(r["action"] == "LOCAL_EVIDENCE_REGISTERED" for r in events):
                    findings.append("EVIDENCE_AUDIT_COUNT_MISMATCH")
        except (sqlite3.DatabaseError, ValueError, KeyError, TypeError, IndexError) as exc:
            findings.append("DB_INVALID_" + type(exc).__name__)
        return {"health": "LOCAL_INTEGRITY_PASS" if not findings else "BLOCKED",
                "findings": sorted(set(findings)), "release": "PRODUCTION_NO_GO", "audit_is_external_attestation": False}
