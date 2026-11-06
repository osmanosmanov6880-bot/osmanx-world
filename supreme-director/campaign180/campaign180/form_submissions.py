"""TITAN-X21/X22: transactional local form submissions to the existing model store.

Only the authenticated, loopback-bound console can call this through HTTP.
A form is part of the versioned page specification. Data never goes to an
external endpoint or to the isolated static HTML preview.
"""
from __future__ import annotations

import uuid
from typing import TYPE_CHECKING, Any

from .automatic import apply_record_event
from .builder import SLUG, validate_row
from .contracts import canonical, digest

if TYPE_CHECKING:
    from .app_runtime import LocalAppRuntime

MAX_ROWS_PER_MODEL = 10000


class FormSubmissionDenied(ValueError):
    """Invalid form, stale configuration or disallowed submission."""


def submit_form(runtime: "LocalAppRuntime", *, tenant: str, project_id: str,
                actor: str, slug: str, section_index: int, expected_revision: int,
                data: dict[str, Any], idempotency_key: str) -> dict:
    """Create a row via an explicitly selected form with one atomic transaction.

    Authorization, form revision check, row insertion, relation indexes,
    automatic workflows, and the idempotency receipt share BEGIN IMMEDIATE.
    This is not an unauthenticated public-facing endpoint.
    """
    if type(slug) is not str or not SLUG.fullmatch(slug):
        raise FormSubmissionDenied("Invalid form page")
    if type(section_index) is not int or not 0 <= section_index < 24:
        raise FormSubmissionDenied("Invalid form section index")
    if type(expected_revision) is not int or expected_revision < 1:
        raise FormSubmissionDenied("Expected positive specification revision")
    if type(data) is not dict or len(data) > 12 or any(type(k) is not str for k in data):
        raise FormSubmissionDenied("Invalid bounded form data")
    runtime.records._key(idempotency_key)
    request_hash = digest({
        "op": "form.submit", "tenant": tenant, "project": project_id,
        "actor": actor, "slug": slug, "section": section_index,
        "revision": expected_revision, "data": data,
    })

    with runtime.drafts._tx() as db:
        runtime._guard(db, tenant, project_id, actor, "record.write")
        # A previously committed operation can be retried after schema edits,
        # but never after revocation or with a changed payload.
        prior = runtime.records._seen(
            db, tenant, project_id, idempotency_key, request_hash
        )
        if prior is not None:
            return prior
        spec, head = runtime.drafts._head(db, tenant, project_id)
        if head["revision"] != expected_revision:
            raise FormSubmissionDenied("Form configuration changed; refresh required")
        page = next((p for p in spec["pages"] if p["slug"] == slug), None)
        if page is None or section_index >= len(page["sections"]):
            raise FormSubmissionDenied("Form page or section not found")
        section = page["sections"][section_index]
        if section["type"] != "form":
            raise FormSubmissionDenied("Selected section is not a form")
        definition = runtime.records._model(spec, section["model"])
        allowed = section.get("fields", [f["name"] for f in definition["fields"]])
        if not set(data).issubset(allowed):
            raise FormSubmissionDenied("Form input includes a hidden or unknown field")
        required = {f["name"] for f in definition["fields"] if f["required"]}
        if not required.issubset(allowed):
            raise FormSubmissionDenied("Form does not expose required model fields")
        normalized = validate_row(definition, data)
        runtime.records._refs(db, tenant, project_id, definition, normalized)
        count = db.execute(
            """SELECT COUNT(*) FROM builder_rows
               WHERE tenant=? AND project_id=? AND model=?""",
            (tenant, project_id, section["model"]),
        ).fetchone()[0]
        if count >= MAX_ROWS_PER_MODEL:
            raise FormSubmissionDenied("Local form row limit reached")
        row_id = str(uuid.uuid4())
        row_digest = digest(normalized)
        db.execute(
            """INSERT INTO builder_rows
               (tenant,project_id,model,row_id,version,content_digest,data_json,deleted)
               VALUES(?,?,?,?,1,?,?,0)""",
            (tenant, project_id, section["model"], row_id, row_digest,
             canonical(normalized).decode("utf-8")),
        )
        runtime.records._replace_links(
            db, tenant, project_id, section["model"], row_id,
            definition, normalized,
        )
        automatic = apply_record_event(
            runtime, db, tenant=tenant, project_id=project_id,
            model=section["model"], row_id=row_id, trigger="record.created",
            mutation_key=idempotency_key,
        )
        _, stored = runtime.records._row(
            db, tenant, project_id, section["model"], row_id
        )
        receipt = {
            "row_id": row_id,
            "model": section["model"],
            "version": stored["version"],
            "sha256": stored["content_digest"],
            "automatic_workflows": automatic,
            "persisted_locally": True,
            "production_published": False,
        }
        runtime.records._remember(
            db, tenant, project_id, idempotency_key, request_hash, receipt
        )
        return receipt
