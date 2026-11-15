"""TITAN-X21-X25: integrated local visual application extensions.

HTTP alone binds the authenticated principal. No production deployments,
public forms, arbitrary code execution or identity claims originate here.
"""
from __future__ import annotations

import uuid

from .app_runtime import AppOperationDenied, LocalAppRuntime, _uuid
from .automatic import apply_record_event
from .builder import compile_verified_site, validate_row, verify_compiled_site
from .contracts import canonical, digest


class VisualDenied(AppOperationDenied):
    pass


class LocalVisualBuilder:
    def __init__(self, runtime: LocalAppRuntime):
        self.runtime = runtime
        with runtime.drafts._db() as db:
            db.executescript("""CREATE TABLE IF NOT EXISTS app_workflow_rule_changes (
                tenant TEXT NOT NULL, project_id TEXT NOT NULL,
                workflow_id TEXT NOT NULL, revision INTEGER NOT NULL,
                actor TEXT NOT NULL, old_sha256 TEXT NOT NULL,
                new_sha256 TEXT NOT NULL, new_rule_json TEXT NOT NULL,
                PRIMARY KEY (tenant,project_id,workflow_id,revision));
            CREATE TRIGGER IF NOT EXISTS workflow_change_no_update
                BEFORE UPDATE ON app_workflow_rule_changes BEGIN
                SELECT RAISE(ABORT,'workflow history immutable'); END;
            CREATE TRIGGER IF NOT EXISTS workflow_change_no_delete
                BEFORE DELETE ON app_workflow_rule_changes BEGIN
                SELECT RAISE(ABORT,'workflow history immutable'); END;""")

    def submit_form(self, *, tenant: str, project_id: str, actor: str,
                    slug: str, section_index: int, expected_revision: int,
                    data: dict, idempotency_key: str) -> dict:
        """X21: bounded model-backed form write in one authorized transaction."""
        self.runtime.records._key(idempotency_key)
        if (type(slug) is not str or type(section_index) is not int
                or section_index < 0 or type(expected_revision) is not int
                or expected_revision < 1 or type(data) is not dict):
            raise VisualDenied("Invalid form submission contract")
        with self.runtime.drafts._tx() as db:
            self.runtime._guard(db, tenant, project_id, actor, "record.write")
            spec, head = self.runtime.drafts._head(db, tenant, project_id)
            if head["revision"] != expected_revision:
                raise VisualDenied("Stale form source revision")
            page = next((p for p in spec["pages"] if p["slug"] == slug), None)
            if page is None or section_index >= len(page["sections"]):
                raise VisualDenied("Form section missing")
            form = page["sections"][section_index]
            if form["type"] != "form":
                raise VisualDenied("Form section required")
            model = form["model"]
            definition = self.runtime.records._model(spec, model)
            selected = form.get("fields", [f["name"] for f in definition["fields"]])
            if not set(data) <= set(selected):
                raise VisualDenied("Attempt to write hidden form fields")
            body = validate_row(definition, data)
            request_hash = digest({
                "op": "form.submit/1", "tenant": tenant, "project": project_id,
                "slug": slug, "index": section_index,
                "spec_sha256": head["content_digest"], "model": model, "body": body
            })
            seen = self.runtime.records._seen(db, tenant, project_id,
                                              idempotency_key, request_hash)
            if seen is not None:
                return seen
            self.runtime.records._refs(db, tenant, project_id, definition, body)
            row_id = str(uuid.uuid4())
            db.execute("""INSERT INTO builder_rows
                (tenant,project_id,model,row_id,version,content_digest,data_json,deleted)
                VALUES(?,?,?,?,1,?,?,0)""",
                (tenant, project_id, model, row_id, digest(body),
                 canonical(body).decode("utf-8")))
            self.runtime.records._replace_links(db, tenant, project_id, model,
                                                 row_id, definition, body)
            automatic = apply_record_event(self.runtime, db, tenant=tenant,
                project_id=project_id, model=model, row_id=row_id,
                trigger="record.created", mutation_key=idempotency_key)
            _, row = self.runtime.records._row(db, tenant, project_id, model, row_id)
            receipt = {"row_id": row_id, "version": row["version"],
                "sha256": row["content_digest"], "form_slug": slug,
                "form_index": section_index, "form_revision": expected_revision,
                "automatic_workflows": automatic, "production_visible": False}
            self.runtime.records._remember(db, tenant, project_id, idempotency_key,
                                           request_hash, receipt)
            return receipt

    def inspect_workflow(self, *, tenant: str, project_id: str, actor: str,
                         workflow_id: str, row_id: str) -> dict:
        """X22: no-write, no-network workflow simulation."""
        _uuid(workflow_id)
        self.runtime.records._rowid(row_id)
        with self.runtime.drafts._db() as db:
            self.runtime._guard(db, tenant, project_id, actor, "workflow.read")
            self.runtime._guard(db, tenant, project_id, actor, "record.read")
            spec, _ = self.runtime.drafts._head(db, tenant, project_id)
            found = db.execute("""SELECT * FROM app_workflows WHERE tenant=?
                AND project_id=? AND workflow_id=?""",
                (tenant, project_id, workflow_id)).fetchone()
            if found is None:
                raise VisualDenied("Unknown workflow")
            rule = self.runtime._read_rule(found)["rule"]
            self.runtime._rule(spec, rule)
            definition = self.runtime.records._model(spec, rule["model"])
            raw, row = self.runtime.records._row(db, tenant, project_id,
                                                 rule["model"], row_id)
            original = validate_row(definition, raw)
            cond = rule["condition"]
            matched = cond is None or original.get(cond["field"]) == cond["equals"]
            proposed = original if not matched else validate_row(definition, {
                **original, rule["action"]["field"]: rule["action"]["value"]})
            return {
                "workflow_id": workflow_id,
                "workflow_revision": found["revision"],
                "row_id": row_id, "row_version": row["version"],
                "enabled": bool(found["enabled"]), "matched": matched,
                "would_change": proposed != original,
                "inspection_sha256": digest({
                    "workflow_sha256": found["spec_digest"],
                    "row_sha256": row["content_digest"],
                    "row_version": row["version"], "result_sha256": digest(proposed)
                }), "writes": 0, "network_calls": 0, "production_executed": False
            }

    def replace_workflow(self, *, tenant: str, project_id: str, actor: str,
                         workflow_id: str, expected_revision: int,
                         rule: dict) -> dict:
        """X22: compare-and-swap rule edit with immutable audit entry."""
        _uuid(workflow_id)
        if type(expected_revision) is not int or expected_revision < 1:
            raise VisualDenied("Exact workflow version required")
        with self.runtime.drafts._tx() as db:
            self.runtime._guard(db, tenant, project_id, actor, "workflow.manage")
            spec, _ = self.runtime.drafts._head(db, tenant, project_id)
            found = db.execute("""SELECT * FROM app_workflows WHERE tenant=?
                AND project_id=? AND workflow_id=?""",
                (tenant, project_id, workflow_id)).fetchone()
            if found is None or found["revision"] != expected_revision:
                raise VisualDenied("Workflow version changed")
            self.runtime._read_rule(found)
            checked = self.runtime._rule(spec, rule)
            sha = digest(checked)
            if sha == found["spec_digest"]:
                return {"workflow_id": workflow_id, "revision": expected_revision,
                        "sha256": sha, "enabled": bool(found["enabled"]),
                        "changed": False}
            count = db.execute("""SELECT COUNT(*) FROM app_workflow_rule_changes
                WHERE tenant=? AND project_id=? AND workflow_id=?""",
                (tenant, project_id, workflow_id)).fetchone()[0]
            if count >= 500:
                raise VisualDenied("Workflow audit quota exceeded")
            revision = expected_revision + 1
            body = canonical(checked).decode("utf-8")
            updated = db.execute("""UPDATE app_workflows
                SET spec_json=?,spec_digest=?,revision=?
                WHERE tenant=? AND project_id=? AND workflow_id=? AND revision=?""",
                (body, sha, revision, tenant, project_id, workflow_id,
                 expected_revision)).rowcount
            if updated != 1:
                raise VisualDenied("Concurrent workflow update")
            db.execute("""INSERT INTO app_workflow_rule_changes
                (tenant,project_id,workflow_id,revision,actor,old_sha256,
                 new_sha256,new_rule_json) VALUES(?,?,?,?,?,?,?,?)""",
                (tenant, project_id, workflow_id, revision, actor,
                 found["spec_digest"], sha, body))
            return {"workflow_id": workflow_id, "revision": revision,
                    "sha256": sha, "changed": True,
                    "enabled": bool(found["enabled"]), "production_executed": False}

    def list_members(self, *, tenant: str, project_id: str, actor: str) -> dict:
        """X23: project-owner-only role and revocation inspection."""
        with self.runtime.drafts._db() as db:
            self.runtime._guard(db, tenant, project_id, actor, "members.manage")
            rows = db.execute("""SELECT actor,role,active,revision
                FROM app_memberships WHERE tenant=? AND project_id=?
                ORDER BY actor LIMIT 101""", (tenant, project_id)).fetchall()
            if len(rows) > 100:
                raise VisualDenied("Too many identities for bounded inventory")
            return {"members": [
                {"actor": r["actor"], "role": r["role"],
                 "active": bool(r["active"]), "revision": r["revision"]}
                for r in rows
            ], "tenant_bound": True, "external_identity_verified": False}

    def compare_revisions(self, *, tenant: str, project_id: str, actor: str,
                          expected_revision: int, target_revision: int) -> dict:
        """X24: read-only project diff; no client record contents exported."""
        if (type(expected_revision) is not int or expected_revision < 1
                or type(target_revision) is not int or target_revision < 1):
            raise VisualDenied("Exact positive revisions required")
        with self.runtime.drafts._db() as db:
            self.runtime._guard(db, tenant, project_id, actor, "spec.read")
            current, head = self.runtime.drafts._head(db, tenant, project_id)
            if head["revision"] != expected_revision:
                raise VisualDenied("Stale project revision")
            target = db.execute("""SELECT * FROM draft_revisions WHERE tenant=?
                AND project_id=? AND revision=?""",
                (tenant, project_id, target_revision)).fetchone()
            if target is None or target_revision > expected_revision:
                raise VisualDenied("No such prior revision")
            previous = self.runtime.drafts._checked(target)
            old = {p["slug"]: p for p in previous["pages"]}
            new = {p["slug"]: p for p in current["pages"]}
            summary = {
                "added_pages": sorted(new.keys() - old.keys()),
                "removed_pages": sorted(old.keys() - new.keys()),
                "modified_pages": sorted(k for k in old.keys() & new.keys()
                                         if old[k] != new[k]),
                "models_changed": previous["models"] != current["models"],
                "metadata_changed": any(previous.get(k) != current.get(k)
                    for k in ("locale", "title", "description"))
            }
            return {
                "current_revision": expected_revision,
                "target_revision": target_revision,
                "current_sha256": head["content_digest"],
                "target_sha256": target["content_digest"],
                "summary": summary,
                "diff_sha256": digest({"current": head["content_digest"],
                    "target": target["content_digest"], "changes": summary}),
                "records_included": False
            }

    def inspect_staging(self, *, tenant: str, project_id: str, actor: str,
                        expected_revision: int) -> dict:
        """X25: offline release candidate generation and integrity verification."""
        if type(expected_revision) is not int or expected_revision < 1:
            raise VisualDenied("Exact source version required")
        with self.runtime.drafts._db() as db:
            self.runtime._guard(db, tenant, project_id, actor, "preview.read")
            spec, head = self.runtime.drafts._head(db, tenant, project_id)
            if head["revision"] != expected_revision:
                raise VisualDenied("Stale staging source")
            candidate = compile_verified_site(spec,
                expected_spec_sha256=head["content_digest"])
            verified = verify_compiled_site(candidate["bundle"],
                expected_bundle_sha256=candidate["bundle_sha256"],
                expected_spec_sha256=head["content_digest"])
            return {
                "source_revision": expected_revision,
                "source_sha256": head["content_digest"],
                "archive_sha256": candidate["bundle_sha256"],
                "manifest_sha256": candidate["manifest_sha256"],
                "files_verified": verified["files_verified"],
                "integrity_verified": verified["reproducible_source_verified"],
                "staging_candidate_only": True,
                "independent_approval": False,
                "network_calls": 0, "production_published": False
            }
