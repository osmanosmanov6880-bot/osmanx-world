"""Wave 16: tenant-scoped search, safe CSV export, and transactional CSV import.

Local-only application operations. No external submissions, file uploads,
arbitrary SQL, cross-project writes, or release authorization.
"""
from __future__ import annotations

import csv
from hashlib import sha256
from io import StringIO
import re
from typing import TYPE_CHECKING

from .automatic import apply_record_event
from .builder import validate_row
from .contracts import canonical, digest

if TYPE_CHECKING:
    from .app_runtime import LocalAppRuntime

MAX_SCAN_ROWS = 10000
MAX_IMPORT_ROWS = 50
MAX_EXPORT_ROWS = 100
MAX_CSV_BYTES = 60000
MAX_QUERY_CHARS = 80
SHA_RE = re.compile(r"^[0-9a-f]{64}$")
NUMBER_RE = re.compile(r"^-?[0-9]+$")


class RecordBulkDenied(ValueError):
    """Invalid, unauthorized or stale local records operation."""


def _bound_page(limit: int, offset: int, search: str, field: str | None) -> None:
    if (type(limit) is not int or not 1 <= limit <= 100
            or type(offset) is not int or not 0 <= offset <= MAX_SCAN_ROWS
            or type(search) is not str or len(search) > MAX_QUERY_CHARS
            or "\x00" in search or any(ord(c) < 32 for c in search)
            or (field is not None and type(field) is not str)):
        raise RecordBulkDenied("Invalid bounded record query")


def _query_in_db(runtime: "LocalAppRuntime", db, tenant: str, project_id: str,
                 model: str, *, limit: int, offset: int, search: str,
                 field: str | None) -> dict:
    spec, _ = runtime.drafts._head(db, tenant, project_id)
    definition = runtime.records._model(spec, model)
    search_fields = [f["name"] for f in definition["fields"]
                     if f["type"] in ("text", "email", "date", "reference", "integer")]
    if field is not None and field not in search_fields:
        raise RecordBulkDenied("Search field not allowed for this model")
    if search and not search_fields:
        raise RecordBulkDenied("No searchable fields in this model")
    candidates = [field] if field else search_fields
    items = db.execute(
        """SELECT row_id FROM builder_rows WHERE tenant=? AND project_id=?
           AND model=? AND deleted=0 ORDER BY rowid ASC LIMIT ?""",
        (tenant, project_id, model, MAX_SCAN_ROWS + 1),
    ).fetchall()
    if len(items) > MAX_SCAN_ROWS:
        raise RecordBulkDenied("Search exceeds bounded local record scan")
    found = []
    needle = search.casefold()
    for item in items:
        value, stored = runtime.records._row(
            db, tenant, project_id, model, item["row_id"]
        )
        checked = validate_row(definition, value)
        if needle and not any(needle in str(checked[name]).casefold()
                              for name in candidates
                              if checked.get(name) is not None):
            continue
        found.append({
            "row_id": stored["row_id"], "version": stored["version"],
            "fields": checked, "sha256": stored["content_digest"],
        })
    total = len(found)
    return {
        "rows": found[offset:offset + limit],
        "total": total,
        "offset": offset,
        "limit": limit,
        "has_more": offset + limit < total,
        "searched_fields": candidates,
        "local_only": True,
    }


def query_rows(runtime: "LocalAppRuntime", *, tenant: str, project_id: str,
               actor: str, model: str, limit: int = 25, offset: int = 0,
               search: str = "", field: str | None = None) -> dict:
    """Casefold-aware bounded search (including Cyrillic), sorted by SQLite rowid."""
    _bound_page(limit, offset, search, field)
    with runtime.drafts._db() as db:
        runtime._guard(db, tenant, project_id, actor, "record.read")
        return _query_in_db(runtime, db, tenant, project_id, model,
                            limit=limit, offset=offset, search=search, field=field)


def _csv_cell(value) -> str:
    if value is None:
        return ""
    if type(value) is bool:
        return "true" if value else "false"
    if type(value) is int:
        return str(value)
    text = str(value)
    # Quoted CSV is not enough to block spreadsheet formula injection.
    # Prefix dangerous cell contents with a literal apostrophe.
    if text.lstrip(" \t\r\n\u200b\ufeff").startswith(("=", "+", "-", "@")):
        return "'" + text
    return text


def export_csv(runtime: "LocalAppRuntime", *, tenant: str, project_id: str,
               actor: str, model: str, limit: int = 100,
               search: str = "", field: str | None = None) -> dict:
    """Return at most 100 CSV rows, not an unbounded network file stream."""
    _bound_page(limit, 0, search, field)
    if limit > MAX_EXPORT_ROWS:
        raise RecordBulkDenied("CSV export page too large")
    with runtime.drafts._db() as db:
        runtime._guard(db, tenant, project_id, actor, "record.read")
        spec, _ = runtime.drafts._head(db, tenant, project_id)
        definition = runtime.records._model(spec, model)
        selection = _query_in_db(runtime, db, tenant, project_id, model,
                                 limit=limit, offset=0, search=search, field=field)
        columns = [f["name"] for f in definition["fields"]]
        output = StringIO(newline="")
        writer = csv.writer(output, lineterminator="\r\n")
        writer.writerow(columns)
        for row in selection["rows"]:
            writer.writerow([_csv_cell(row["fields"].get(col)) for col in columns])
        text = output.getvalue()
        if len(text.encode("utf-8")) > MAX_CSV_BYTES:
            raise RecordBulkDenied("CSV export size limit exceeded")
        return {
            "model": model,
            "csv_text": text,
            "exported": len(selection["rows"]),
            "total_filtered": selection["total"],
            "truncated": selection["has_more"],
            "sha256": sha256(text.encode("utf-8")).hexdigest(),
            "spreadsheet_formula_escaped": True,
            "local_only": True,
        }


def _parse_csv(csv_text: str, definition: dict) -> tuple[list[str], list[dict]]:
    if type(csv_text) is not str or not csv_text:
        raise RecordBulkDenied("Nonempty CSV text required")
    if len(csv_text.encode("utf-8")) > MAX_CSV_BYTES or "\x00" in csv_text:
        raise RecordBulkDenied("Invalid bounded CSV payload")
    try:
        reader = csv.reader(StringIO(csv_text.lstrip("\ufeff"), newline=""),
                            strict=True)
        headers = next(reader)
        if not headers or len(headers) > 12 or len(set(headers)) != len(headers):
            raise RecordBulkDenied("Duplicate or missing CSV header")
        declared = {f["name"]: f for f in definition["fields"]}
        if any(name not in declared for name in headers):
            raise RecordBulkDenied("Unknown CSV field")
        required = {f["name"] for f in definition["fields"] if f["required"]}
        if not required.issubset(headers):
            raise RecordBulkDenied("CSV omits a required model field")
        result = []
        for values in reader:
            if len(values) != len(headers):
                raise RecordBulkDenied("Malformed CSV row length")
            if len(result) == MAX_IMPORT_ROWS:
                raise RecordBulkDenied("CSV exceeds 50 row import limit")
            data = {}
            for name, raw in zip(headers, values):
                definition_field = declared[name]
                if not raw and not definition_field["required"]:
                    continue
                kind = definition_field["type"]
                if kind == "integer":
                    if not NUMBER_RE.fullmatch(raw):
                        raise RecordBulkDenied("Expected integer in CSV")
                    value = int(raw)
                elif kind == "boolean":
                    if raw.lower() not in ("true", "false", "1", "0"):
                        raise RecordBulkDenied("Expected boolean true/false in CSV")
                    value = raw.lower() in ("true", "1")
                else:
                    value = raw
                data[name] = value
            result.append(validate_row(definition, data))
    except (csv.Error, StopIteration, UnicodeError) as exc:
        raise RecordBulkDenied("Malformed CSV data") from exc
    if not result:
        raise RecordBulkDenied("CSV has no records")
    return headers, result


def _inspect_in_db(runtime: "LocalAppRuntime", db, tenant: str,
                   project_id: str, actor: str, model: str,
                   expected_revision: int, csv_text: str):
    if type(expected_revision) is not int or expected_revision < 1:
        raise RecordBulkDenied("Exact positive schema revision required")
    spec, head = runtime.drafts._head(db, tenant, project_id)
    if head["revision"] != expected_revision:
        raise RecordBulkDenied("Stale schema revision for CSV import")
    definition = runtime.records._model(spec, model)
    headers, rows = _parse_csv(csv_text, definition)
    current = db.execute(
        "SELECT COUNT(*) FROM builder_rows WHERE tenant=? AND project_id=? AND model=?",
        (tenant, project_id, model),
    ).fetchone()[0]
    if current + len(rows) > MAX_SCAN_ROWS:
        raise RecordBulkDenied("Model record capacity exceeded")
    for row in rows:
        runtime.records._refs(db, tenant, project_id, definition, row)
    plan = {
        "schema": "osgard.original180.csv-import-plan/1",
        "tenant": tenant, "project_id": project_id, "actor": actor,
        "model": model, "revision": expected_revision,
        "source_spec_sha256": head["content_digest"],
        "headers": headers, "rows": rows,
    }
    return definition, rows, {
        "schema": plan["schema"],
        "model": model,
        "revision": expected_revision,
        "columns": headers,
        "count": len(rows),
        "expected_plan_sha256": digest(plan),
        "preview_only": True,
        "production_authorized": False,
    }


def inspect_import(runtime: "LocalAppRuntime", *, tenant: str, project_id: str,
                   actor: str, model: str, expected_revision: int,
                   csv_text: str) -> dict:
    """Validate the full CSV and all relation targets without writing anything."""
    with runtime.drafts._db() as db:
        runtime._guard(db, tenant, project_id, actor, "record.write")
        _, _, overview = _inspect_in_db(
            runtime, db, tenant, project_id, actor, model,
            expected_revision, csv_text,
        )
        return overview


def apply_import(runtime: "LocalAppRuntime", *, tenant: str, project_id: str,
                 actor: str, model: str, expected_revision: int, csv_text: str,
                 expected_plan_sha256: str, idempotency_key: str) -> dict:
    """Insert an inspected CSV batch atomically with workflow effects and receipt."""
    runtime.records._key(idempotency_key)
    if type(expected_plan_sha256) is not str or not SHA_RE.fullmatch(expected_plan_sha256):
        raise RecordBulkDenied("Expected checked SHA-256 import plan")
    if type(csv_text) is not str or len(csv_text.encode("utf-8")) > MAX_CSV_BYTES:
        raise RecordBulkDenied("Invalid CSV import input")
    req = digest({
        "op": "record.import.csv", "tenant": tenant, "project_id": project_id,
        "actor": actor, "model": model, "revision": expected_revision,
        "csv_sha256": sha256(csv_text.encode("utf-8")).hexdigest(),
        "plan_sha256": expected_plan_sha256,
    })
    with runtime.drafts._tx() as db:
        runtime._guard(db, tenant, project_id, actor, "record.write")
        prior = runtime.records._seen(db, tenant, project_id, idempotency_key, req)
        if prior is not None:
            return prior
        definition, rows, overview = _inspect_in_db(
            runtime, db, tenant, project_id, actor, model,
            expected_revision, csv_text,
        )
        if overview["expected_plan_sha256"] != expected_plan_sha256:
            raise RecordBulkDenied("CSV import plan digest changed")
        from uuid import uuid4
        receipts = []
        workflow_count = 0
        for index, fields in enumerate(rows):
            row_id = str(uuid4())
            checksum = digest(fields)
            db.execute(
                """INSERT INTO builder_rows
                   (tenant,project_id,model,row_id,version,content_digest,data_json,deleted)
                   VALUES (?,?,?,?,1,?,?,0)""",
                (tenant, project_id, model, row_id, checksum,
                 canonical(fields).decode("utf-8")),
            )
            runtime.records._replace_links(db, tenant, project_id, model,
                                           row_id, definition, fields)
            # Derive short deterministic event identities from the batch key.
            event_key = "csv-" + sha256(
                (idempotency_key + ":" + str(index)).encode("utf-8")
            ).hexdigest()[:48]
            triggered = apply_record_event(
                runtime, db, tenant=tenant, project_id=project_id,
                model=model, row_id=row_id, trigger="record.created",
                mutation_key=event_key,
            )
            _, saved = runtime.records._row(db, tenant, project_id, model, row_id)
            workflow_count += triggered["dispatched"]
            receipts.append({"row_id": row_id, "version": saved["version"]})
        receipt = {
            "imported": len(rows), "model": model, "rows": receipts,
            "workflow_runs": workflow_count,
            "plan_sha256": expected_plan_sha256,
            "production_published": False,
            "persisted_locally": True,
        }
        runtime.records._remember(db, tenant, project_id, idempotency_key, req, receipt)
        return receipt
