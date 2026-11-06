"""M191: crash-consistent backup/verify/restore of a locally anchored M190 ledger.

This module does not approve original tasks, write to upstream products, or deploy.
A trusted M190 head anchor MUST be stored independently of both SQLite databases
and backup bundles. Backups retain evidence, not production permission.
"""
from __future__ import annotations

from contextlib import closing
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import shutil
import sqlite3
import tempfile
from urllib.parse import quote

from m190 import ledger

SCHEMA = "osgard.m191.backup-bundle/1"
CONTENTS = frozenset({"ledger.sqlite", "manifest.json"})


class RecoveryError(ValueError):
    """Invalid source, bundle, operation, or external anchor."""


def require(condition: bool, explanation: str) -> None:
    if not condition:
        raise RecoveryError(explanation)


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with Path(path).open("rb") as f:
        for block in iter(lambda: f.read(1024 * 1024), b""):
            h.update(block)
    return h.hexdigest()


def timestamp() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="microseconds")


def fsync_directory(path: Path) -> None:
    if hasattr(os, "O_DIRECTORY"):
        fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(fd)
        finally:
            os.close(fd)


def external_anchor(anchor: Path, container: Path | None = None) -> Path:
    anchor = Path(anchor)
    require(anchor.is_file() and not anchor.is_symlink(), "external anchor missing or symlinked")
    resolved = anchor.resolve(strict=True)
    if container is not None:
        require(not resolved.is_relative_to(Path(container).resolve()),
                "external anchor must be stored OUTSIDE the recovery bundle")
    return resolved


def safe_directory(path: Path) -> Path:
    path = Path(path)
    require(path.is_dir() and not path.is_symlink(), "directory missing or symlinked")
    return path.resolve(strict=True)


def validate_summary(summary: dict) -> None:
    require(summary.get("schema") == ledger.FORMAT and
            summary.get("original_task_acceptance") == 0 and
            summary.get("production_authorized") is False and
            summary.get("release_gate") == "NO_GO" and
            summary.get("external_anchor_checked") is True,
            "M190 verification must fail closed; release/anchor status invalid")
    require(isinstance(summary.get("events"), int) and summary["events"] >= 0,
            "invalid event count")


def bundle_report(summary: dict, bundle: Path, manifest: dict) -> dict:
    return {"schema": "osgard.m191.recovery-result/1", "result": "PASS_LOCAL_ONLY",
            "bundle": str(bundle), "events": summary["events"], "head": summary["head"],
            "plan_sha256": summary["plan_sha256"],
            "original_task_acceptance": 0, "production_authorized": False,
            "release_gate": "NO_GO", "externally_anchored": True,
            "backup_sha256": manifest["db_sha256"],
            "warning": "Backup+manifest do not authenticate the external anchor; pin and store it independently."}


def verify_bundle(bundle: Path, anchor: Path) -> dict:
    """Check exact layout, byte hashes, full SQLite consistency and M190 anchored head."""
    folder = safe_directory(bundle)
    trusted = external_anchor(anchor, folder)
    require({p.name for p in folder.iterdir()} == CONTENTS,
            "backup layout invalid: expected exactly ledger.sqlite and manifest.json")
    db, manifest_file = folder / "ledger.sqlite", folder / "manifest.json"
    require(db.is_file() and not db.is_symlink() and manifest_file.is_file() and
            not manifest_file.is_symlink(), "invalid file or symlink in bundle")
    manifest = json.loads(manifest_file.read_text(encoding="utf-8"))
    require(isinstance(manifest, dict) and set(manifest) == {
        "schema", "created_utc", "db_sha256", "anchor_sha256", "head",
        "events", "plan_sha256", "backup_mode", "production_authorized", "release_gate"
    }, "backup manifest schema/fields invalid")
    require(manifest["schema"] == SCHEMA and manifest["backup_mode"] == "sqlite-online-backup",
            "backup manifest identity invalid")
    require(manifest["production_authorized"] is False and manifest["release_gate"] == "NO_GO",
            "backup unexpectedly authorizes production")
    require(sha256_file(trusted) == manifest["anchor_sha256"],
            "external anchor bytes changed since backup")
    require(sha256_file(db) == manifest["db_sha256"], "backup SQLite byte SHA-256 mismatch")
    # This verifies the *full* chained history relative to an external anchor.
    summary = ledger.verify_anchor(db, trusted)
    validate_summary(summary)
    require(all(manifest[k] == summary[k if k != "events" else "events"]
                for k in ("head", "events", "plan_sha256")),
            "backup differs from anchored history")
    with closing(sqlite3.connect(f"file:{quote(str(db), safe='/')}?mode=ro", uri=True)) as c:
        require(c.execute("PRAGMA integrity_check").fetchone()[0] == "ok",
                "SQLite full integrity_check failed")
    return bundle_report(summary, folder, manifest)


def create_backup(db: Path, anchor: Path, bundle: Path, *, inject_failure: str | None = None) -> dict:
    """Create an online SQLite snapshot in a staging dir, then atomically publish it.

    Source is read using sqlite3.Connection.backup (never shutil.copy on active WAL).
    Refuses to overwrite any destination. Internal injection only for crash tests.
    """
    db, bundle = Path(db), Path(bundle)
    require(db.is_file() and not db.is_symlink(), "source SQLite file missing or symlinked")
    trusted = external_anchor(anchor)
    parent = safe_directory(bundle.parent)
    require(not bundle.exists() and not bundle.is_symlink(), "backup destination already exists")
    before = ledger.verify_anchor(db, trusted)
    validate_summary(before)
    folder = Path(tempfile.mkdtemp(prefix=".m191-staging-", dir=parent))
    try:
        dest_file = folder / "ledger.sqlite"
        uri = f"file:{quote(str(db.resolve()), safe='/')}?mode=ro"
        with closing(sqlite3.connect(uri, uri=True, timeout=10)) as source:
            with closing(sqlite3.connect(dest_file, timeout=10)) as target:
                source.backup(target)
        # The source is in WAL mode. Normalize the *copy* to a self-contained
        # SQLite file before the strict two-file bundle layout check.
        with closing(sqlite3.connect(dest_file, timeout=10)) as target:
            target.execute("PRAGMA wal_checkpoint(TRUNCATE)")
            mode = target.execute("PRAGMA journal_mode=DELETE").fetchone()[0]
            require(mode == "delete", "snapshot could not leave WAL mode")
        if inject_failure == "after_snapshot":
            raise RecoveryError("INJECTED_FAILURE_AFTER_SNAPSHOT")
        copied = ledger.verify_anchor(dest_file, trusted)
        validate_summary(copied)
        require(copied["head"] == before["head"] and copied["events"] == before["events"],
                "backup snapshot differs from verified source head")
        after = ledger.verify_anchor(db, trusted)
        require(after["head"] == before["head"] and after["events"] == before["events"],
                "source ledger changed during backup")
        manifest = {"schema": SCHEMA, "created_utc": timestamp(),
                    "db_sha256": sha256_file(dest_file),
                    "anchor_sha256": sha256_file(trusted),
                    "head": copied["head"], "events": copied["events"],
                    "plan_sha256": copied["plan_sha256"],
                    "backup_mode": "sqlite-online-backup", "production_authorized": False,
                    "release_gate": "NO_GO"}
        ledger.write_json_atomic(folder / "manifest.json", manifest)
        verify_bundle(folder, trusted)
        if inject_failure == "before_publish":
            raise RecoveryError("INJECTED_FAILURE_BEFORE_PUBLISH")
        require(not bundle.exists() and not bundle.is_symlink(),
                "backup destination created concurrently")
        # Atomic visibility of both manifest and db on same filesystem.
        os.rename(folder, bundle)
        fsync_directory(parent)
        return verify_bundle(bundle, trusted)
    finally:
        if folder.exists():
            shutil.rmtree(folder)


def restore_backup(bundle: Path, anchor: Path, destination: Path,
                   *, inject_failure: str | None = None) -> dict:
    """Restore as a NEW database, refusing to overwrite or follow target symlinks."""
    destination = Path(destination)
    parent = safe_directory(destination.parent)
    require(not destination.exists() and not destination.is_symlink(),
            "restore destination already exists")
    checked = verify_bundle(bundle, anchor)
    source = Path(bundle) / "ledger.sqlite"
    fd, tmp = tempfile.mkstemp(prefix=".m191-restore-", suffix=".sqlite", dir=parent)
    temp = Path(tmp)
    published = False
    try:
        with os.fdopen(fd, "wb") as output, source.open("rb") as input_file:
            shutil.copyfileobj(input_file, output, 1024 * 1024)
            output.flush()
            os.fsync(output.fileno())
        if inject_failure == "after_copy":
            raise RecoveryError("INJECTED_FAILURE_AFTER_COPY")
        require(sha256_file(temp) == checked["backup_sha256"],
                "temporary restore SHA-256 mismatch")
        confirmed = ledger.verify_anchor(temp, anchor)
        validate_summary(confirmed)
        require(confirmed["head"] == checked["head"] and
                confirmed["events"] == checked["events"],
                "recovered events/head changed")
        if inject_failure == "before_publish":
            raise RecoveryError("INJECTED_FAILURE_BEFORE_PUBLISH")
        # Atomic create-if-absent on local POSIX filesystems: hard-link then unlink temp.
        os.link(temp, destination, follow_symlinks=False)
        published = True
        fsync_directory(parent)
        final = ledger.verify_anchor(destination, anchor)
        validate_summary(final)
        return {**bundle_report(final, Path(bundle), {"db_sha256": checked["backup_sha256"]}),
                "restored_to": str(destination), "new_database_created": True}
    finally:
        if temp.exists():
            temp.unlink()
        # If final integrity failed, do not present a broken restored artifact.
        if published and "final" not in locals() and destination.exists():
            destination.unlink()
