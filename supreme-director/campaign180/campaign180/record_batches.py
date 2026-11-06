"""Wave 17: transactional bulk record editing, immutable journal and safe undo.

This local-only service operates on existing builder_rows and builder_links.
No public endpoint, arbitrary SQL, loss of CAS versions or production mutations.
Undo is a NEW forward revision (never a destructive version rollback).
"""
from __future__ import annotations

import json
import re
import time
import uuid
from hashlib import sha256
from typing import TYPE_CHECKING, Any

from .automatic import apply_record_event
from .builder import validate_row
from .contracts import canonical, digest

if TYPE_CHECKING:
    from .app_runtime import LocalAppRuntime

MAX_BATCH_ROWS = 25
MAX_JOURNAL_PAGE = 30
JOURNAL_SCHEMA = "osgard.original180.record-batch-journal/1"
PLAN_SCHEMA = "osgard.original180.record-batch-plan/1"
HEX_SHA = re.compile(r"^[a-f0-9]{64}$")


class RecordBatchDenied(ValueError):
    """Invalid or stale batch, or failed local journal integrity validation."""


def init_journal(runtime: "LocalAppRuntime") -> None:
    """Create append-only local journal with a one-time restore constraint."""
    with runtime.drafts._db() as db:
        db.executescript("""
            CREATE TABLE IF NOT EXISTS record_batch_journal(
                tenant TEXT NOT NULL,
                project_id TEXT NOT NULL,
                batch_id TEXT NOT NULL,
                model TEXT NOT NULL,
                actor TEXT NOT NULL,
                operation TEXT NOT NULL CHECK(operation IN ('UPDATE','RESTORE')),
                parent_batch_id TEXT,
                created_epoch INTEGER NOT NULL,
                spec_digest TEXT NOT NULL,
                entry_digest TEXT NOT NULL,
                entries_json TEXT NOT NULL,
                PRIMARY KEY(tenant,project_id,batch_id)
            );
            CREATE INDEX IF NOT EXISTS record_batch_journal_scope
                ON record_batch_journal(tenant,project_id,model,created_epoch,batch_id);
            CREATE UNIQUE INDEX IF NOT EXISTS record_batch_only_one_restore
                ON record_batch_journal(tenant,project_id,parent_batch_id)
                WHERE operation='RESTORE';
            CREATE TRIGGER IF NOT EXISTS record_batch_journal_immutable_update
                BEFORE UPDATE ON record_batch_journal BEGIN
                SELECT RAISE(ABORT,'batch journal is append-only');END;
            CREATE TRIGGER IF NOT EXISTS record_batch_journal_immutable_delete
                BEFORE DELETE ON record_batch_journal BEGIN
                SELECT RAISE(ABORT,'batch journal is append-only');END;
        """)


def _require_sha(value: str) -> None:
    if type(value) is not str or not HEX_SHA.fullmatch(value):
        raise RecordBatchDenied("Expected 64-char SHA-256 plan digest")


def _check_revision(value: int) -> None:
    if type(value) is not int or value < 1:
        raise RecordBatchDenied("Positive exact specification revision required")


def _check_batch_items(runtime: "LocalAppRuntime", patches: Any) -> list[dict]:
    if type(patches) is not list or not 1 <= len(patches) <= MAX_BATCH_ROWS:
        raise RecordBatchDenied("Expected 1-25 explicit row patches")
    normalized = []
    seen = set()
    for raw in patches:
        if type(raw) is not dict or set(raw) != {
            "row_id", "expected_version", "changes"
        }:
            raise RecordBatchDenied("Exact batch patch fields required")
        rid = raw["row_id"]
        runtime.records._rowid(rid)
        if rid in seen:
            raise RecordBatchDenied("Duplicate row ID in batch")
        seen.add(rid)
        ver, changes = raw["expected_version"], raw["changes"]
        if type(ver) is not int or ver < 1:
            raise RecordBatchDenied("Invalid expected row version")
        if (type(changes) is not dict or not 1 <= len(changes) <= 12
                or any(type(k) is not str for k in changes)):
            raise RecordBatchDenied("Invalid bounded field patch")
        normalized.append({
            "row_id": rid, "expected_version": ver, "changes": changes
        })
    return sorted(normalized, key=lambda p: p["row_id"])


def _snapshot(data: dict, header) -> dict:
    return {
        "version": header["version"],
        "sha256": header["content_digest"],
        "fields": data,
    }


def _inspect_update_db(runtime: "LocalAppRuntime", db, tenant: str,
                       project_id: str, actor: str, model: str,
                       expected_revision: int, patches: list[dict]) -> tuple[dict, dict, list[dict]]:
    _check_revision(expected_revision)
    items = _check_batch_items(runtime, patches)
    spec, head = runtime.drafts._head(db, tenant, project_id)
    if head["revision"] != expected_revision:
        raise RecordBatchDenied("Stale model specification")
    definition = runtime.records._model(spec, model)
    entries = []
    for item in items:
        before, stored = runtime.records._row(
            db, tenant, project_id, model, item["row_id"]
        )
        if stored["version"] != item["expected_version"]:
            raise RecordBatchDenied("Stale row version; batch not applied")
        replacement = validate_row(definition, {**before, **item["changes"]})
        if replacement == before:
            raise RecordBatchDenied("Batch contains unchanged row")
        runtime.records._refs(db, tenant, project_id, definition, replacement)
        entries.append({
            "row_id": item["row_id"],
            "before": _snapshot(before, stored),
            "proposed_sha256": digest(replacement),
            "proposed_fields": replacement,
            "changed_fields": sorted(item["changes"]),
        })
    plan = {
        "schema": PLAN_SCHEMA,
        "operation": "UPDATE",
        "tenant": tenant, "project_id": project_id, "actor": actor,
        "model": model, "revision": expected_revision,
        "spec_digest": head["content_digest"],
        "rows": entries,
    }
    return definition, plan, entries


def inspect_batch_update(runtime: "LocalAppRuntime", *, tenant: str, project_id: str,
                         actor: str, model: str, expected_revision: int,
                         patches: list[dict]) -> dict:
    with runtime.drafts._db() as db:
        runtime._guard(db, tenant, project_id, actor, "record.write")
        _, plan, entries = _inspect_update_db(
            runtime, db, tenant, project_id, actor, model,
            expected_revision, patches,
        )
    return {
        "schema": PLAN_SCHEMA, "operation": "UPDATE",
        "model": model, "revision": expected_revision,
        "count": len(entries),
        "rows": [
            {"row_id": item["row_id"], "before_version": item["before"]["version"],
             "changed_fields": item["changed_fields"]}
            for item in entries
        ],
        "expected_plan_sha256": digest(plan),
        "preview_only": True, "production_authorized": False,
    }


def _payload(*, tenant: str, project_id: str, batch_id: str, model: str,
             actor: str, operation: str, parent_batch_id: str | None,
             created_epoch: int, spec_digest: str, entries: list[dict]) -> dict:
    return {
        "schema": JOURNAL_SCHEMA,
        "tenant": tenant, "project_id": project_id, "batch_id": batch_id,
        "model": model, "actor": actor, "operation": operation,
        "parent_batch_id": parent_batch_id, "created_epoch": created_epoch,
        "spec_digest": spec_digest, "entries": entries,
    }


def _append(runtime: "LocalAppRuntime", db, payload: dict) -> None:
    db.execute(
        """INSERT INTO record_batch_journal
           (tenant,project_id,batch_id,model,actor,operation,parent_batch_id,
            created_epoch,spec_digest,entry_digest,entries_json)
           VALUES(?,?,?,?,?,?,?,?,?,?,?)""",
        (
            payload["tenant"], payload["project_id"], payload["batch_id"],
            payload["model"], payload["actor"], payload["operation"],
            payload["parent_batch_id"], payload["created_epoch"],
            payload["spec_digest"], digest(payload),
            canonical(payload).decode("utf-8"),
        ),
    )


def apply_batch_update(runtime: "LocalAppRuntime", *, tenant: str, project_id: str,
                       actor: str, model: str, expected_revision: int,
                       patches: list[dict], expected_plan_sha256: str,
                       idempotency_key: str) -> dict:
    runtime.records._key(idempotency_key)
    _require_sha(expected_plan_sha256)
    ordered = _check_batch_items(runtime, patches)
    req_digest = digest({
        "op": "batch.update", "tenant": tenant, "project": project_id,
        "actor": actor, "model": model, "revision": expected_revision,
        "patches": ordered, "plan_sha256": expected_plan_sha256,
    })
    with runtime.drafts._tx() as db:
        runtime._guard(db, tenant, project_id, actor, "record.write")
        previous = runtime.records._seen(
            db, tenant, project_id, idempotency_key, req_digest
        )
        if previous is not None:
            return previous
        definition, plan, entries = _inspect_update_db(
            runtime, db, tenant, project_id, actor, model,
            expected_revision, ordered,
        )
        if digest(plan) != expected_plan_sha256:
            raise RecordBatchDenied("Batch edit plan changed")
        saved = []
        dispatched = 0
        for index, item in enumerate(entries):
            before = item["before"]
            version = before["version"] + 1
            changed = db.execute(
                """UPDATE builder_rows SET version=?,content_digest=?,data_json=?
                   WHERE tenant=? AND project_id=? AND model=? AND row_id=?
                   AND version=? AND content_digest=? AND deleted=0""",
                (
                    version, item["proposed_sha256"],
                    canonical(item["proposed_fields"]).decode("utf-8"),
                    tenant, project_id, model, item["row_id"],
                    before["version"], before["sha256"],
                ),
            ).rowcount
            if changed != 1:
                raise RecordBatchDenied("Concurrent row update; batch rolled back")
            runtime.records._replace_links(
                db, tenant, project_id, model, item["row_id"],
                definition, item["proposed_fields"],
            )
            event_key = "batch-" + sha256(
                (idempotency_key + ":" + str(index)).encode("utf-8")
            ).hexdigest()[:48]
            applied = apply_record_event(
                runtime, db, tenant=tenant, project_id=project_id,
                model=model, row_id=item["row_id"], trigger="record.updated",
                mutation_key=event_key,
            )
            dispatched += applied["dispatched"]
            after, stored = runtime.records._row(
                db, tenant, project_id, model, item["row_id"]
            )
            saved.append({
                "row_id": item["row_id"], "before": before,
                "after": _snapshot(after, stored),
                "changed_fields": item["changed_fields"],
            })
        batch_id = str(uuid.uuid4())
        journal = _payload(
            tenant=tenant, project_id=project_id, batch_id=batch_id,
            model=model, actor=actor, operation="UPDATE", parent_batch_id=None,
            created_epoch=int(time.time()), spec_digest=plan["spec_digest"],
            entries=saved,
        )
        _append(runtime, db, journal)
        receipt = {
            "batch_id": batch_id, "model": model, "updated": len(saved),
            "automatic_workflows": dispatched,
            "entry_digest": digest(journal),
            "production_published": False, "persisted_locally": True,
        }
        runtime.records._remember(
            db, tenant, project_id, idempotency_key, req_digest, receipt
        )
        return receipt


def _checked_journal(row) -> dict:
    try:
        content = json.loads(row["entries_json"])
    except (TypeError, ValueError) as exc:
        raise RecordBatchDenied("Corrupted batch journal") from exc
    if type(content) is not dict or canonical(content).decode("utf-8") != row["entries_json"]:
        raise RecordBatchDenied("Noncanonical batch journal")
    if digest(content) != row["entry_digest"]:
        raise RecordBatchDenied("Batch journal digest mismatch")
    for name in (
        "tenant", "project_id", "batch_id", "model", "actor", "operation",
        "parent_batch_id", "created_epoch", "spec_digest",
    ):
        if content.get(name) != row[name]:
            raise RecordBatchDenied("Batch journal metadata mismatch")
    if (content.get("schema") != JOURNAL_SCHEMA
            or type(content.get("entries")) is not list
            or not 1 <= len(content["entries"]) <= MAX_BATCH_ROWS):
        raise RecordBatchDenied("Unsupported or damaged batch journal")
    return content


def _load_journal(db, tenant: str, project_id: str, batch_id: str) -> dict:
    if type(batch_id) is not str:
        raise RecordBatchDenied("Invalid batch id")
    try:
        if str(uuid.UUID(batch_id)) != batch_id:
            raise ValueError()
    except ValueError as exc:
        raise RecordBatchDenied("Canonical batch UUID required") from exc
    row = db.execute(
        """SELECT * FROM record_batch_journal
           WHERE tenant=? AND project_id=? AND batch_id=?""",
        (tenant, project_id, batch_id),
    ).fetchone()
    if row is None:
        raise RecordBatchDenied("Batch journal not found")
    return _checked_journal(row)


def list_batch_history(runtime: "LocalAppRuntime", *, tenant: str, project_id: str,
                       actor: str, model: str, limit: int = 20) -> dict:
    if type(limit) is not int or not 1 <= limit <= MAX_JOURNAL_PAGE:
        raise RecordBatchDenied("Invalid journal page limit")
    with runtime.drafts._db() as db:
        runtime._guard(db, tenant, project_id, actor, "record.read")
        spec, _ = runtime.drafts._head(db, tenant, project_id)
        runtime.records._model(spec, model)
        rows = db.execute(
            """SELECT * FROM record_batch_journal
               WHERE tenant=? AND project_id=? AND model=?
               ORDER BY created_epoch DESC,batch_id DESC LIMIT ?""",
            (tenant, project_id, model, limit),
        ).fetchall()
        # No customer data is ever returned by this endpoint.
        history = []
        for row in rows:
            item = _checked_journal(row)
            history.append({
                "batch_id": item["batch_id"], "model": item["model"],
                "operation": item["operation"], "actor": item["actor"],
                "created_epoch": item["created_epoch"],
                "count": len(item["entries"]),
                "parent_batch_id": item["parent_batch_id"],
                "entry_digest": row["entry_digest"],
            })
        return {"history": history, "local_only": True,
                "values_exposed": False, "immutable": True}


def _restore_inspection_db(runtime: "LocalAppRuntime", db, tenant: str,
                           project_id: str, actor: str, model: str,
                           batch_id: str, expected_revision: int):
    _check_revision(expected_revision)
    spec, head = runtime.drafts._head(db, tenant, project_id)
    definition = runtime.records._model(spec, model)
    source = _load_journal(db, tenant, project_id, batch_id)
    if source["operation"] != "UPDATE" or source["model"] != model:
        raise RecordBatchDenied("Only original update batches can be restored")
    if (head["revision"] != expected_revision
            or head["content_digest"] != source["spec_digest"]):
        raise RecordBatchDenied("Schema changed since recorded batch")
    prior_restore = db.execute(
        """SELECT 1 FROM record_batch_journal WHERE tenant=? AND project_id=?
           AND parent_batch_id=? AND operation='RESTORE' LIMIT 1""",
        (tenant, project_id, batch_id),
    ).fetchone()
    if prior_restore:
        raise RecordBatchDenied("This batch has already been restored")
    current = []
    for item in source["entries"]:
        original = item["before"]
        expected = item["after"]
        data, row = runtime.records._row(
            db, tenant, project_id, model, item["row_id"]
        )
        if (row["version"] != expected["version"]
                or row["content_digest"] != expected["sha256"]
                or data != expected["fields"]):
            raise RecordBatchDenied("A row changed after batch; restore denied")
        if validate_row(definition, original["fields"]) != original["fields"]:
            raise RecordBatchDenied("Original values no longer match current schema")
        runtime.records._refs(
            db, tenant, project_id, definition, original["fields"]
        )
        current.append({
            "row_id": item["row_id"], "current_version": row["version"],
            "current_sha256": row["content_digest"],
            "restore_sha256": digest(original["fields"]),
        })
    plan = {
        "schema": PLAN_SCHEMA, "operation": "RESTORE",
        "tenant": tenant, "project_id": project_id, "actor": actor,
        "model": model, "batch_id": batch_id, "revision": expected_revision,
        "source_journal_sha256": digest(source),
        "current": current,
    }
    return definition, source, plan


def inspect_batch_restore(runtime: "LocalAppRuntime", *, tenant: str, project_id: str,
                          actor: str, model: str, batch_id: str,
                          expected_revision: int) -> dict:
    with runtime.drafts._db() as db:
        runtime._guard(db, tenant, project_id, actor, "spec.write")
        runtime._guard(db, tenant, project_id, actor, "record.write")
        _, source, plan = _restore_inspection_db(
            runtime, db, tenant, project_id, actor, model,
            batch_id, expected_revision,
        )
    return {
        "schema": PLAN_SCHEMA, "operation": "RESTORE",
        "batch_id": batch_id, "model": model, "count": len(source["entries"]),
        "expected_plan_sha256": digest(plan),
        "preview_only": True, "values_exposed": False,
        "automatic_workflows_will_not_replay": True,
    }


def apply_batch_restore(runtime: "LocalAppRuntime", *, tenant: str, project_id: str,
                        actor: str, model: str, batch_id: str,
                        expected_revision: int, expected_plan_sha256: str,
                        idempotency_key: str) -> dict:
    runtime.records._key(idempotency_key)
    _require_sha(expected_plan_sha256)
    req_digest = digest({
        "op": "batch.restore", "tenant": tenant, "project": project_id,
        "actor": actor, "model": model, "batch_id": batch_id,
        "revision": expected_revision, "plan_sha256": expected_plan_sha256,
    })
    with runtime.drafts._tx() as db:
        runtime._guard(db, tenant, project_id, actor, "spec.write")
        runtime._guard(db, tenant, project_id, actor, "record.write")
        repeated = runtime.records._seen(
            db, tenant, project_id, idempotency_key, req_digest
        )
        if repeated is not None:
            return repeated
        definition, source, plan = _restore_inspection_db(
            runtime, db, tenant, project_id, actor, model,
            batch_id, expected_revision,
        )
        if digest(plan) != expected_plan_sha256:
            raise RecordBatchDenied("Restore approval plan changed")
        entries = []
        for item in source["entries"]:
            before, after = item["before"], item["after"]
            next_version = after["version"] + 1
            count = db.execute(
                """UPDATE builder_rows SET version=?,content_digest=?,data_json=?
                   WHERE tenant=? AND project_id=? AND model=? AND row_id=?
                   AND version=? AND content_digest=? AND deleted=0""",
                (
                    next_version, before["sha256"],
                    canonical(before["fields"]).decode("utf-8"),
                    tenant, project_id, model, item["row_id"],
                    after["version"], after["sha256"],
                ),
            ).rowcount
            if count != 1:
                raise RecordBatchDenied("Restore CAS conflict; all changes rolled back")
            runtime.records._replace_links(
                db, tenant, project_id, model, item["row_id"],
                definition, before["fields"],
            )
            entries.append({
                "row_id": item["row_id"], "before": after,
                "after": {"version": next_version,
                          "sha256": before["sha256"],
                          "fields": before["fields"]},
                "changed_fields": item["changed_fields"],
            })
        restore_id = str(uuid.uuid4())
        journal = _payload(
            tenant=tenant, project_id=project_id, batch_id=restore_id,
            model=model, actor=actor, operation="RESTORE",
            parent_batch_id=batch_id, created_epoch=int(time.time()),
            spec_digest=source["spec_digest"], entries=entries,
        )
        _append(runtime, db, journal)
        receipt = {
            "batch_id": restore_id, "restored_batch_id": batch_id,
            "restored": len(entries), "model": model,
            "automatic_workflows_skipped": True,
            "entry_digest": digest(journal),
            "production_published": False, "persisted_locally": True,
        }
        runtime.records._remember(
            db, tenant, project_id, idempotency_key, req_digest, receipt
        )
        return receipt
