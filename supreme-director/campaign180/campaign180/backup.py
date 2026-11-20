"""TITAN-X28: consistent SQLite snapshot + checksum-verified restore drill.

For isolated local data only. No offsite storage, encryption, retention rules,
replica failover, production backup scheduling, or authenticity signatures.
Restore uses exclusive creation; existing targets are never overwritten.
"""
from __future__ import annotations

from hashlib import sha256
import json
import os
from pathlib import Path
import shutil
import sqlite3
import tempfile
import uuid

from .contracts import canonical

_SCHEMA="osgard.original180.sqlite-backup/1"
_CHUNK=1024*1024
_MAX=128*1024*1024


class BackupDenied(ValueError):
    pass


def _sha_file(path: Path) -> str:
    h=sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda:stream.read(_CHUNK),b""):
            h.update(chunk)
    return h.hexdigest()


def _readonly_db(path: Path):
    return sqlite3.connect(path.resolve().as_uri()+"?mode=ro",uri=True,timeout=10)


def _checks(path: Path) -> None:
    try:
        with _readonly_db(path) as db:
            if db.execute("PRAGMA integrity_check").fetchone()[0]!="ok":
                raise BackupDenied("SQLite integrity check failed")
            if db.execute("PRAGMA foreign_key_check").fetchone() is not None:
                raise BackupDenied("SQLite foreign-key check failed")
    except sqlite3.DatabaseError as exc:
        raise BackupDenied("Not a consistent SQLite database") from exc


def _safe_directory(path: Path) -> None:
    if path.is_symlink() or not path.is_dir():
        raise BackupDenied("Directory missing or symlinked")


def snapshot_sqlite(source: Path, destination_parent: Path, *,
                    created_epoch: int, backup_id: str | None = None) -> dict:
    source,destination_parent=Path(source),Path(destination_parent)
    _safe_directory(destination_parent)
    if source.is_symlink() or not source.is_file():
        raise BackupDenied("Source must be a regular SQLite file")
    if type(created_epoch) is not int or created_epoch<0:
        raise BackupDenied("Invalid snapshot timestamp")
    identifier=backup_id or uuid.uuid4().hex
    if (type(identifier) is not str or len(identifier)!=32
            or any(x not in "0123456789abcdef" for x in identifier)):
        raise BackupDenied("Backup ID must be lowercase 32-char hexadecimal")
    destination=destination_parent/identifier
    if destination.exists() or destination.is_symlink():
        raise BackupDenied("Refusing to overwrite snapshot")
    destination.mkdir(mode=0o700)
    db_path=destination/"snapshot.sqlite3"
    try:
        source_connection=sqlite3.connect(
            source.resolve().as_uri()+"?mode=ro",uri=True,timeout=15)
        target_connection=sqlite3.connect(str(db_path),timeout=15)
        try:
            source_connection.backup(target_connection,pages=128,sleep=0.05)
        finally:
            target_connection.close()
            source_connection.close()
        if db_path.stat().st_size>_MAX:
            raise BackupDenied("Snapshot exceeds safety cap")
        _checks(db_path)
        manifest={"schema":_SCHEMA,"backup_id":identifier,"created_epoch":created_epoch,
                  "bytes":db_path.stat().st_size,"sha256":_sha_file(db_path)}
        blob=canonical(manifest)+b"\n"
        manifest_path=destination/"manifest.json"
        with manifest_path.open("xb") as stream:
            stream.write(blob)
            stream.flush()
            os.fsync(stream.fileno())
        with db_path.open("rb") as stream:
            os.fsync(stream.fileno())
        return {"backup_dir":str(destination),"backup_id":identifier,
                "sha256":manifest["sha256"],"bytes":manifest["bytes"],
                "consistent":True,"signed":False,"offsite":False}
    except BaseException:
        # Only cleanup our just-created, known isolated snapshot directory.
        shutil.rmtree(destination,ignore_errors=True)
        raise


def verify_snapshot(snapshot_dir: Path) -> dict:
    snapshot_dir=Path(snapshot_dir)
    _safe_directory(snapshot_dir)
    manifest_path=snapshot_dir/"manifest.json"
    source=snapshot_dir/"snapshot.sqlite3"
    if manifest_path.is_symlink() or source.is_symlink() or not source.is_file() or not manifest_path.is_file():
        raise BackupDenied("Backup files missing or symlinked")
    if manifest_path.stat().st_size>4096 or source.stat().st_size>_MAX:
        raise BackupDenied("Snapshot metadata or bytes exceed limits")
    try:
        raw=manifest_path.read_bytes()
        record=json.loads(raw.decode("utf-8"))
    except (OSError,UnicodeError,ValueError) as exc:
        raise BackupDenied("Invalid backup manifest JSON") from exc
    if (type(record) is not dict
            or set(record)!={"schema","backup_id","created_epoch","bytes","sha256"}
            or record["schema"]!=_SCHEMA
            or type(record["backup_id"]) is not str or len(record["backup_id"])!=32
            or any(x not in "0123456789abcdef" for x in record["backup_id"])
            or snapshot_dir.name!=record["backup_id"]
            or type(record["created_epoch"]) is not int or record["created_epoch"]<0
            or type(record["bytes"]) is not int or record["bytes"]!=source.stat().st_size
            or type(record["sha256"]) is not str or len(record["sha256"])!=64
            or canonical(record)+b"\n"!=raw
            or _sha_file(source)!=record["sha256"]):
        raise BackupDenied("Manifest or snapshot checksum mismatch")
    _checks(source)
    return {**record,"integrity_verified":True,"signature_verified":False,
            "independent_acceptance":False}


def restore_snapshot(snapshot_dir: Path, destination: Path, *,
                     expected_sha256: str | None = None) -> dict:
    """Never overwrites. Exclusive hard-link installs a fully verified temp file."""
    snapshot_dir,destination=Path(snapshot_dir),Path(destination)
    report=verify_snapshot(snapshot_dir)
    if expected_sha256 is not None and report["sha256"]!=expected_sha256:
        raise BackupDenied("Independent expected digest differs")
    _safe_directory(destination.parent)
    if destination.exists() or destination.is_symlink():
        raise BackupDenied("Existing target must never be overwritten")
    if not destination.name.endswith(".sqlite3"):
        raise BackupDenied("Restore target must be a new .sqlite3 file")
    fd,tmp=tempfile.mkstemp(prefix=".osgard-restore-",dir=str(destination.parent))
    os.close(fd)
    temp=Path(tmp)
    try:
        shutil.copyfile(snapshot_dir/"snapshot.sqlite3",temp)
        if _sha_file(temp)!=report["sha256"]:
            raise BackupDenied("Copy integrity check failed")
        _checks(temp)
        try:
            os.link(temp,destination)
        except FileExistsError as exc:
            raise BackupDenied("Another process created restore target") from exc
        return {"target":str(destination),"sha256":report["sha256"],
                "restored":True,"source_unchanged":True}
    finally:
        temp.unlink(missing_ok=True)


def restore_drill(snapshot_dir: Path, target_parent: Path) -> dict:
    """Rehearse into a temporary directory, then discard only that scratch data."""
    _safe_directory(Path(target_parent))
    with tempfile.TemporaryDirectory(prefix="osgard-drill-",dir=str(target_parent)) as tmp:
        target=Path(tmp)/"restored.sqlite3"
        result=restore_snapshot(snapshot_dir,target)
        result["drill_only"]=True
        result["production_restored"]=False
        return result
