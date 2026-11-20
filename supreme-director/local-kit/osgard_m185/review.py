"""M185 cryptographically verifiable LOCAL review cases; never product approval.

Trusted reviewers must be provided out-of-band. Public keys are pinned once at
initialization; no endpoint enrolls reviewers. Private keys never enter the app.
Ed25519 authenticates a public-key holder, NOT their actual human identity.
"""
from __future__ import annotations

import base64
import binascii
from contextlib import closing
import hashlib
import json
import os
from pathlib import Path
import re
import sqlite3
import stat
import uuid

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey

from osgard_m184.storage import DirectorDB, _validate_text, read_pinned_json, encode, sha, utcnow

TRUST_SCHEMA = "osgard.m185.trusted-reviewers/1"
VOTE_SCHEMA = "osgard.m185.local-evidence-vote/1"
CASE_SCHEMA = "osgard.m185.review-state/1"
REVIEWER_NAME = re.compile(r"[A-Za-z0-9][A-Za-z0-9_.-]{2,49}\Z")
ROLES = {"CODE_REVIEWER", "SECURITY_REVIEWER", "QA_REVIEWER"}
VERDICTS = {"PASS_LOCAL_EVIDENCE", "REQUEST_CHANGES", "REJECT_EVIDENCE"}
CASE_ID = re.compile(r"RVW-[0-9A-F]{24}\Z")
MAX_EVIDENCE = 32_000_000


def decode_public_key(value):
    if not isinstance(value, str) or len(value) > 100:
        raise ValueError("invalid Ed25519 key encoding")
    try:
        raw = base64.b64decode(value, validate=True)
        if len(raw) != 32:
            raise ValueError("public key must be 32 bytes")
        Ed25519PublicKey.from_public_bytes(raw)
        return raw
    except (ValueError, binascii.Error) as exc:
        raise ValueError("invalid Ed25519 public key") from exc


def decode_signature(value):
    if not isinstance(value, str) or len(value) > 120:
        raise ValueError("invalid signature")
    try:
        raw = base64.b64decode(value, validate=True)
        if len(raw) != 64:
            raise ValueError("wrong Ed25519 signature size")
        return raw
    except (ValueError, binascii.Error) as exc:
        raise ValueError("invalid Ed25519 signature") from exc


def validate_registry(obj):
    if not isinstance(obj, dict) or set(obj) != {"schema", "reviewers"} or obj["schema"] != TRUST_SCHEMA:
        raise ValueError("unrecognized reviewer registry")
    items = obj["reviewers"]
    if not isinstance(items, list) or len(items) > 25:
        raise ValueError("reviewer registry size")
    names, keys, output = set(), set(), []
    for row in items:
        if not isinstance(row, dict) or set(row) != {"id", "role", "ed25519_public_key_b64"}:
            raise ValueError("reviewer record invalid")
        name = row["id"]
        if not isinstance(name, str) or not REVIEWER_NAME.fullmatch(name) or name.casefold() in names:
            raise ValueError("reviewer identifier invalid or duplicate")
        if row["role"] not in ROLES:
            raise ValueError("reviewer role invalid")
        raw = decode_public_key(row["ed25519_public_key_b64"])
        fingerprint = sha(raw)
        if fingerprint in keys:
            raise ValueError("same public key cannot represent two reviewers")
        names.add(name.casefold()); keys.add(fingerprint)
        output.append({"id": name, "role": row["role"], "public_b64": row["ed25519_public_key_b64"],
                       "key_sha256": fingerprint})
    return output


def validate_local_vote(payload):
    keys = {"schema", "scope", "case_id", "case_created_at", "evidence_id", "evidence_sha256",
            "target", "proposer", "reviewer_id", "reviewer_role", "key_sha256", "verdict", "reason",
            "original_source_verified", "independent_product_acceptance", "production_authorized"}
    if not isinstance(payload, dict) or set(payload) != keys or payload.get("schema") != VOTE_SCHEMA:
        raise ValueError("invalid offline vote schema")
    if (payload.get("scope") != "LOCAL_EVIDENCE_ONLY" or payload.get("original_source_verified") is not False
        or payload.get("independent_product_acceptance") is not False or payload.get("production_authorized") is not False):
        raise ValueError("invalid vote authority")
    if not isinstance(payload.get("case_id"), str) or not CASE_ID.fullmatch(payload["case_id"]):
        raise ValueError("invalid case identifier")
    if payload.get("verdict") not in VERDICTS:
        raise ValueError("invalid vote verdict")
    return payload


def safe_evidence(root, relative_path, expected_sha):
    root = Path(root)
    if not root.is_dir() or root.is_symlink():
        raise ValueError("unsafe evidence root")
    if not isinstance(relative_path, str) or not relative_path or relative_path.startswith("/") or "\\" in relative_path:
        raise ValueError("unsafe evidence path")
    parts = relative_path.split("/")
    if any(p in {"", ".", ".."} for p in parts):
        raise ValueError("unsafe evidence path segments")
    resolved_root = root.resolve(strict=True)
    candidate = root
    for part in parts:
        candidate = candidate / part
        if candidate.is_symlink():
            raise ValueError("symlink in evidence path")
    real = candidate.resolve(strict=True)
    real.relative_to(resolved_root)
    st = real.stat()
    if not stat.S_ISREG(st.st_mode) or st.st_size < 1 or st.st_size > MAX_EVIDENCE:
        raise ValueError("unsafe evidence file")
    with real.open("rb") as handle:
        actual = hashlib.sha256(handle.read(MAX_EVIDENCE + 1)).hexdigest()
    if actual != expected_sha:
        raise ValueError("evidence content differs from registered SHA")
    return actual


class ReviewDB(DirectorDB):
    def __init__(self, path, evidence_root):
        super().__init__(path)
        self.evidence_root = Path(evidence_root)

    def review_bootstrap(self, registry_path):
        if super().doctor()["health"] != "LOCAL_INTEGRITY_PASS":
            raise ValueError("base M184 database not healthy")
        if not self.evidence_root.is_dir() or self.evidence_root.is_symlink():
            raise ValueError("review evidence root must exist as nonsymlink directory")
        registry, reg_hash = read_pinned_json(registry_path, max_bytes=50_000)
        trustees = validate_registry(registry)
        with closing(sqlite3.connect(str(self.path))) as con:
            con.executescript("""
              CREATE TABLE IF NOT EXISTS m185_reviewers (
                 id TEXT PRIMARY KEY, role TEXT NOT NULL, public_b64 TEXT NOT NULL,
                 key_sha256 TEXT NOT NULL UNIQUE);
              CREATE TABLE IF NOT EXISTS m185_cases (
                 id TEXT PRIMARY KEY, evidence_id INTEGER NOT NULL REFERENCES evidence(id),
                 target TEXT NOT NULL, evidence_sha256 TEXT NOT NULL,
                 proposer TEXT NOT NULL, description TEXT NOT NULL, at TEXT NOT NULL);
              CREATE TABLE IF NOT EXISTS m185_decisions (
                 case_id TEXT PRIMARY KEY REFERENCES m185_cases(id), reviewer_id TEXT NOT NULL REFERENCES m185_reviewers(id),
                 verdict TEXT NOT NULL, reason TEXT NOT NULL, signature_b64 TEXT NOT NULL, at TEXT NOT NULL);
              CREATE TRIGGER IF NOT EXISTS m185_evidence_no_update BEFORE UPDATE ON evidence BEGIN
                 SELECT RAISE(ABORT, 'registered evidence immutable'); END;
              CREATE TRIGGER IF NOT EXISTS m185_evidence_no_delete BEFORE DELETE ON evidence BEGIN
                 SELECT RAISE(ABORT, 'registered evidence immutable'); END;
              CREATE TRIGGER IF NOT EXISTS m185_cases_no_delete BEFORE DELETE ON m185_cases BEGIN
                 SELECT RAISE(ABORT, 'review cases immutable'); END;
              CREATE TRIGGER IF NOT EXISTS m185_cases_no_update BEFORE UPDATE ON m185_cases BEGIN
                 SELECT RAISE(ABORT, 'review cases immutable'); END;
              CREATE TRIGGER IF NOT EXISTS m185_decisions_no_delete BEFORE DELETE ON m185_decisions BEGIN
                 SELECT RAISE(ABORT, 'review decisions immutable'); END;
              CREATE TRIGGER IF NOT EXISTS m185_decisions_no_update BEFORE UPDATE ON m185_decisions BEGIN
                 SELECT RAISE(ABORT, 'review decisions immutable'); END;
              CREATE TRIGGER IF NOT EXISTS m185_reviewers_no_delete BEFORE DELETE ON m185_reviewers BEGIN
                 SELECT RAISE(ABORT, 'reviewers pinned'); END;
              CREATE TRIGGER IF NOT EXISTS m185_reviewers_no_update BEFORE UPDATE ON m185_reviewers BEGIN
                 SELECT RAISE(ABORT, 'reviewers pinned'); END;
            """)
        with self.connect(write=True) as con:
            self._require_ready(con)
            existing = con.execute("SELECT value FROM meta WHERE key='m185_schema'").fetchone()
            if existing:
                if (existing[0] != CASE_SCHEMA or
                    con.execute("SELECT value FROM meta WHERE key='m185_trust_sha'").fetchone()[0] != reg_hash or
                    con.execute("SELECT value FROM meta WHERE key='m185_evidence_root'").fetchone()[0] != str(self.evidence_root.resolve())):
                    raise ValueError("trust anchor or evidence root changed: fail closed")
                return {"status": "IDEMPOTENT", "trusted_reviewers": len(trustees), "trust_sha256": reg_hash}
            con.executemany("INSERT INTO m185_reviewers VALUES (?,?,?,?)",
                            [(t["id"], t["role"], t["public_b64"], t["key_sha256"]) for t in trustees])
            con.executemany("INSERT INTO meta VALUES (?,?)", [
                ("m185_schema", CASE_SCHEMA), ("m185_trust_sha", reg_hash),
                ("m185_evidence_root", str(self.evidence_root.resolve())),
                ("m185_production_approval", "false")])
            self._audit(con, "local-operator", "M185_REVIEW_INITIALIZED", "LOCAL_ONLY",
                        {"trust_sha256": reg_hash, "trusted_public_key_count": len(trustees), "production_approval": False})
        return {"status": "LOCAL_REVIEW_INITIALIZED", "trusted_reviewers": len(trustees), "trust_sha256": reg_hash}

    def provision_trust(self, registry_path, expected_current_sha):
        """Explicit offline-only one-time provisioning from empty initial registry.

        Never exposed over HTTP. Requires prior trusted-registry SHA to prevent
        accidental replacement. Cannot change an existing trusted reviewer set
        or trust after the first case is created.
        """
        if not isinstance(expected_current_sha, str) or not re.fullmatch(r"[0-9a-f]{64}", expected_current_sha):
            raise ValueError("expected previous trust SHA-256 required")
        registry, new_hash = read_pinned_json(registry_path, max_bytes=50_000)
        trustees = validate_registry(registry)
        if not trustees:
            raise ValueError("new trust registry must not be empty")
        with self.connect(write=True) as con:
            self._require_review(con)
            prior_hash = con.execute("SELECT value FROM meta WHERE key='m185_trust_sha'").fetchone()[0]
            if prior_hash != expected_current_sha or prior_hash == new_hash:
                raise ValueError("trust registry compare-and-swap failed")
            if any(con.execute(f"SELECT 1 FROM {table} LIMIT 1").fetchone() for table in
                   ("m185_reviewers", "m185_cases", "m185_decisions")):
                raise ValueError("existing reviewer or case prevents trust modification")
            con.executemany("INSERT INTO m185_reviewers VALUES (?,?,?,?)",
                            [(t["id"], t["role"], t["public_b64"], t["key_sha256"]) for t in trustees])
            con.execute("UPDATE meta SET value=? WHERE key='m185_trust_sha'", (new_hash,))
            self._audit(con, "offline-operator", "M185_TRUST_PROVISIONED_FROM_EMPTY", "LOCAL_ONLY",
                        {"previous_trust_sha256": prior_hash, "new_trust_sha256": new_hash,
                         "reviewers": len(trustees), "production_authorized": False})
        return {"status": "LOCAL_TRUST_PROVISIONED", "trusted_reviewers": len(trustees),
                "trust_sha256": new_hash, "production_authorized": False}

    def _require_review(self, con):
        self._require_ready(con)
        meta = dict(con.execute("SELECT key,value FROM meta WHERE key LIKE 'm185_%'"))
        if (meta.get("m185_schema") != CASE_SCHEMA or meta.get("m185_production_approval") != "false" or
            meta.get("m185_evidence_root") != str(self.evidence_root.resolve())):
            raise ValueError("M185 review trust or root not initialized")

    def evidence_items(self):
        with self.connect() as con:
            self._require_review(con)
            return [dict(r) for r in con.execute("SELECT * FROM evidence ORDER BY id DESC LIMIT 100")]

    def trustees(self):
        with self.connect() as con:
            self._require_review(con)
            return [dict(r) for r in con.execute("SELECT id,role,key_sha256 FROM m185_reviewers ORDER BY id")]

    def cases(self):
        with self.connect() as con:
            self._require_review(con)
            return [dict(r) for r in con.execute("""
                SELECT c.*, d.reviewer_id,d.verdict,d.reason,d.at AS reviewed_at,
                       CASE WHEN d.case_id IS NULL THEN 'AWAITING_LOCAL_REVIEW' ELSE 'SIGNED_LOCAL_REVIEW' END AS state
                FROM m185_cases c LEFT JOIN m185_decisions d ON d.case_id=c.id
                ORDER BY c.at DESC,c.id DESC LIMIT 200""")]

    def register_evidence(self, target, relative_path, sha256, actor):
        return self.register_local_evidence(target, relative_path, sha256, actor, self.evidence_root)

    def create_case(self, evidence_id, proposer, description):
        proposer = _validate_text(proposer, "proposer", 50)
        if not REVIEWER_NAME.fullmatch(proposer):
            raise ValueError("proposer must have stable ASCII identifier")
        description = _validate_text(description, "description", 1000)
        if type(evidence_id) is not int or evidence_id <= 0:
            raise ValueError("invalid evidence id")
        with self.connect(write=True) as con:
            self._require_review(con)
            item = con.execute("SELECT * FROM evidence WHERE id=?", (evidence_id,)).fetchone()
            if item is None or item["status"] != "LOCAL_SHA_ONLY":
                raise ValueError("unregistered evidence")
            safe_evidence(self.evidence_root, item["relative_path"], item["sha256"])
            identity = "RVW-" + uuid.uuid4().hex[:24].upper()
            at = utcnow()
            con.execute("INSERT INTO m185_cases VALUES (?,?,?,?,?,?,?)",
                        (identity, evidence_id, item["target"], item["sha256"], proposer, description, at))
            self._audit(con, proposer, "REVIEW_CASE_CREATED", identity,
                        {"evidence_id": evidence_id, "sha256": item["sha256"], "target": item["target"]})
            return {"case_id": identity, "state": "AWAITING_LOCAL_REVIEW", "product_acceptance": False}

    @staticmethod
    def _vote(con, case_id, reviewer_id, verdict, reason):
        if not isinstance(case_id, str) or not CASE_ID.fullmatch(case_id):
            raise ValueError("invalid case")
        if not isinstance(reviewer_id, str) or not REVIEWER_NAME.fullmatch(reviewer_id):
            raise ValueError("invalid reviewer id")
        if verdict not in VERDICTS:
            raise ValueError("unsupported verdict")
        reason = _validate_text(reason, "review reason", 1200)
        case = con.execute("SELECT * FROM m185_cases WHERE id=?", (case_id,)).fetchone()
        trust = con.execute("SELECT * FROM m185_reviewers WHERE id=?", (reviewer_id,)).fetchone()
        if case is None or trust is None or case["proposer"].casefold() == reviewer_id.casefold():
            raise ValueError("case missing, reviewer untrusted or self-review")
        vote = {"schema": VOTE_SCHEMA, "scope": "LOCAL_EVIDENCE_ONLY", "case_id": case_id,
                "case_created_at": case["at"], "evidence_id": case["evidence_id"],
                "evidence_sha256": case["evidence_sha256"], "target": case["target"],
                "proposer": case["proposer"], "reviewer_id": trust["id"],
                "reviewer_role": trust["role"], "key_sha256": trust["key_sha256"],
                "verdict": verdict, "reason": reason,
                "original_source_verified": False, "independent_product_acceptance": False,
                "production_authorized": False}
        return validate_local_vote(vote), trust

    def challenge(self, case_id, reviewer_id, verdict, reason):
        with self.connect() as con:
            self._require_review(con)
            vote, _ = self._vote(con, case_id, reviewer_id, verdict, reason)
            case = con.execute("SELECT evidence_id FROM m185_cases WHERE id=?", (case_id,)).fetchone()
            ev = con.execute("SELECT relative_path,sha256 FROM evidence WHERE id=?", (case["evidence_id"],)).fetchone()
            original = con.execute("SELECT target,evidence_sha256 FROM m185_cases WHERE id=?", (case_id,)).fetchone()
            if original["evidence_sha256"] != ev["sha256"]:
                raise ValueError("review-case evidence SHA reference changed")
            safe_evidence(self.evidence_root, ev["relative_path"], ev["sha256"])
            if con.execute("SELECT 1 FROM m185_decisions WHERE case_id=?", (case_id,)).fetchone():
                raise ValueError("case already reviewed")
            return vote

    def submit(self, case_id, reviewer_id, verdict, reason, signature_b64):
        sig = decode_signature(signature_b64)
        with self.connect(write=True) as con:
            self._require_review(con)
            vote, trust = self._vote(con, case_id, reviewer_id, verdict, reason)
            if con.execute("SELECT 1 FROM m185_decisions WHERE case_id=?", (case_id,)).fetchone():
                raise ValueError("review vote already committed")
            evidence = con.execute("SELECT e.relative_path,e.sha256 FROM m185_cases c JOIN evidence e ON e.id=c.evidence_id WHERE c.id=?", (case_id,)).fetchone()
            if evidence["sha256"] != vote["evidence_sha256"]:
                raise ValueError("review-case evidence SHA mismatch")
            safe_evidence(self.evidence_root, evidence["relative_path"], evidence["sha256"])
            try:
                Ed25519PublicKey.from_public_bytes(decode_public_key(trust["public_b64"])).verify(sig, encode(vote).encode("utf-8"))
            except InvalidSignature as exc:
                raise ValueError("untrusted or forged review signature") from exc
            con.execute("INSERT INTO m185_decisions VALUES (?,?,?,?,?,?)",
                        (case_id, reviewer_id, verdict, vote["reason"], signature_b64, utcnow()))
            self._audit(con, reviewer_id, "ED25519_LOCAL_REVIEW_RECORDED", case_id,
                        {"verdict": verdict, "key_sha256": trust["key_sha256"], "evidence_sha256": evidence["sha256"]})
            return {"case_id": case_id, "state": "SIGNED_LOCAL_REVIEW", "verdict": verdict,
                    "original_source_verified": False, "independent_product_acceptance": False,
                    "production_authorized": False}

    def summary(self):
        previous = super().summary()
        with self.connect() as con:
            self._require_review(con)
            cases = con.execute("SELECT count(*) FROM m185_cases").fetchone()[0]
            signed = con.execute("SELECT count(*) FROM m185_decisions").fetchone()[0]
            reviewers = con.execute("SELECT count(*) FROM m185_reviewers").fetchone()[0]
        previous.update(version="M185", state="LOCAL_SIGNED_REVIEW_STUDIO", review_cases=cases,
                        signed_local_reviews=signed, trusted_reviewers=reviewers, independent_acceptance=0,
                        release="PRODUCTION_NO_GO")
        return previous

    def doctor(self):
        parent = super().doctor()
        findings = list(parent["findings"])
        try:
            with self.connect() as con:
                self._require_review(con)
                reviews = list(con.execute("SELECT * FROM m185_decisions"))
                cases = list(con.execute("SELECT * FROM m185_cases"))
                trust = list(con.execute("SELECT * FROM m185_reviewers"))
                for t in trust:
                    if sha(decode_public_key(t["public_b64"])) != t["key_sha256"] or t["role"] not in ROLES:
                        findings.append("REVIEWER_PIN_INTEGRITY")
                for c in cases:
                    evidence = con.execute("SELECT * FROM evidence WHERE id=?", (c["evidence_id"],)).fetchone()
                    if evidence is None or evidence["sha256"] != c["evidence_sha256"] or evidence["target"] != c["target"]:
                        findings.append("REVIEW_CASE_EVIDENCE_REFERENCE")
                    else:
                        try: safe_evidence(self.evidence_root, evidence["relative_path"], evidence["sha256"])
                        except (OSError, ValueError): findings.append("REVIEW_CASE_EVIDENCE_CHANGED_OR_MISSING")
                for d in reviews:
                    try:
                        payload, key = self._vote(con, d["case_id"], d["reviewer_id"], d["verdict"], d["reason"])
                        raw = decode_signature(d["signature_b64"])
                        Ed25519PublicKey.from_public_bytes(decode_public_key(key["public_b64"])).verify(raw, encode(payload).encode("utf8"))
                    except (InvalidSignature, ValueError):
                        findings.append("REVIEW_SIGNATURE_INVALID")
        except (sqlite3.Error, ValueError, OSError):
            findings.append("REVIEW_SUBSYSTEM_INTEGRITY")
        findings = sorted(set(findings))
        parent.update(health="LOCAL_INTEGRITY_PASS" if not findings else "LOCAL_INTEGRITY_FAIL",
                      findings=findings, release="PRODUCTION_NO_GO", signed_review_count=len(reviews) if 'reviews' in locals() else 0)
        return parent
