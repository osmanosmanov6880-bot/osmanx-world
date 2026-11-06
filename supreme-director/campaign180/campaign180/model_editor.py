"""TITAN-X21/X24: reviewed, bounded, transaction-safe model schema migrations.

A model is a versioned JSON definition, not an executable SQL identifier.
Adding a field with a typed default migrates stored JSON records atomically
and bumps their optimistic row versions. Unknown/unsafe operations fail closed.
No cross-tenant data migration, destructive production DDL or external schema.
"""
from __future__ import annotations

import json
from typing import Any

from .builder import FIELD, SECRET_NAMES, SiteSpecDenied, validate_row, validate_site_spec
from .contracts import canonical, digest
from .app_runtime import LocalAppRuntime

MAX_ROWS_MIGRATED = 500

class ModelMigrationDenied(SiteSpecDenied):
    pass

class LocalModelEditor:
    """Only a trusted, authenticated LocalAppRuntime may call these functions."""

    def __init__(self, runtime: LocalAppRuntime):
        if type(runtime) is not LocalAppRuntime:
            raise ModelMigrationDenied("Trusted runtime required")
        self.runtime = runtime
        with runtime.drafts._db() as db:
            db.executescript("""CREATE TABLE IF NOT EXISTS builder_model_migrations(
                tenant TEXT NOT NULL,project_id TEXT NOT NULL,
                spec_revision INTEGER NOT NULL,operation TEXT NOT NULL,
                model_name TEXT NOT NULL,prior_sha256 TEXT NOT NULL,
                new_sha256 TEXT NOT NULL,rows_migrated INTEGER NOT NULL,
                PRIMARY KEY(tenant,project_id,spec_revision));
            CREATE TRIGGER IF NOT EXISTS builder_model_migrations_no_update
                BEFORE UPDATE ON builder_model_migrations BEGIN
                SELECT RAISE(ABORT,'model migration receipts immutable');END;
            CREATE TRIGGER IF NOT EXISTS builder_model_migrations_no_delete
                BEFORE DELETE ON builder_model_migrations BEGIN
                SELECT RAISE(ABORT,'model migration receipts immutable');END;""")

    def _context(self, db, tenant, project_id, actor, expected_revision,
                 *, write_records=False):
        if type(expected_revision) is not int or expected_revision<1:
            raise ModelMigrationDenied("Expected a positive exact project revision")
        self.runtime._guard(db,tenant,project_id,actor,"spec.write")
        if write_records:
            self.runtime._guard(db,tenant,project_id,actor,"record.write")
        document,head=self.runtime.drafts._head(db,tenant,project_id)
        if head["revision"]!=expected_revision:
            raise ModelMigrationDenied("Stale project schema revision")
        return document,head

    def _record(self,db,tenant,project_id,head,document,operation,model_name,rows):
        validated=validate_site_spec(document)
        after=digest(validated)
        before=head["content_digest"]
        if after==before:
            return {"changed":False,"revision":head["revision"],
                    "rows_migrated":0,"sha256":before,
                    "production_published":False}
        rev=head["revision"]+1
        changed=db.execute("""UPDATE draft_projects SET revision=?,
            content_digest=?,content_json=? WHERE tenant=? AND project_id=?
            AND revision=?""",(rev,after,canonical(validated).decode("utf-8"),
                               tenant,project_id,head["revision"])).rowcount
        if changed!=1:
            raise ModelMigrationDenied("Concurrent schema edit rejected")
        db.execute("""INSERT INTO draft_revisions
            (tenant,project_id,revision,content_digest,content_json)
            VALUES(?,?,?,?,?)""",(tenant,project_id,rev,after,
                                   canonical(validated).decode("utf-8")))
        db.execute("""INSERT INTO builder_model_migrations
            (tenant,project_id,spec_revision,operation,model_name,prior_sha256,
             new_sha256,rows_migrated) VALUES(?,?,?,?,?,?,?,?)""",
            (tenant,project_id,rev,operation,model_name,before,after,rows))
        return {"changed":True,"revision":rev,"rows_migrated":rows,
                "sha256":after,"production_published":False,
                "migration_receipt_local":True}

    def add_model(self,*,tenant:str,project_id:str,actor:str,
                  expected_revision:int,model:dict)->dict:
        if type(model) is not dict:
            raise ModelMigrationDenied("Model must be a structured declaration")
        with self.runtime.drafts._tx() as db:
            doc,head=self._context(db,tenant,project_id,actor,expected_revision)
            if len(doc["models"])>=8:
                raise ModelMigrationDenied("Maximum model count reached")
            name=model.get("name")
            if type(name) is not str or not FIELD.fullmatch(name):
                raise ModelMigrationDenied("Unsafe model name")
            doc["models"].append(model)
            return self._record(db,tenant,project_id,head,doc,"ADD_MODEL",name,0)

    def label_model(self,*,tenant:str,project_id:str,actor:str,
                    expected_revision:int,model:str,label:str)->dict:
        with self.runtime.drafts._tx() as db:
            doc,head=self._context(db,tenant,project_id,actor,expected_revision)
            definition=self.runtime.records._model(doc,model)
            definition["label"]=label
            return self._record(db,tenant,project_id,head,doc,"LABEL_MODEL",model,0)

    def label_field(self,*,tenant:str,project_id:str,actor:str,
                    expected_revision:int,model:str,field:str,label:str)->dict:
        with self.runtime.drafts._tx() as db:
            doc,head=self._context(db,tenant,project_id,actor,expected_revision)
            definition=self.runtime.records._model(doc,model)
            fields=[item for item in definition["fields"] if item["name"]==field]
            if len(fields)!=1:
                raise ModelMigrationDenied("Field not found in model")
            fields[0]["label"]=label
            return self._record(db,tenant,project_id,head,doc,"LABEL_FIELD",model,0)

    def add_field(self,*,tenant:str,project_id:str,actor:str,
                  expected_revision:int,model:str,field:dict,
                  default_provided:bool=False,default_value:Any=None)->dict:
        """Optional append is metadata-only; provided defaults rewrite <=500 rows.

        To add required fields to existing records a valid default is required.
        New references may be optional but can never be populated with a
        cross-model default by this operation.
        """
        if type(field) is not dict or type(default_provided) is not bool:
            raise ModelMigrationDenied("Invalid field definition or default marker")
        with self.runtime.drafts._tx() as db:
            doc,head=self._context(db,tenant,project_id,actor,expected_revision,
                                   write_records=True)
            definition=self.runtime.records._model(doc,model)
            if len(definition["fields"])>=12:
                raise ModelMigrationDenied("Maximum fields per model reached")
            name=field.get("name")
            if type(name) is not str or not FIELD.fullmatch(name):
                raise ModelMigrationDenied("Unsafe field name")
            definition["fields"].append(field)
            # Validate full site and new field BEFORE any record rewrite.
            new_spec=validate_site_spec(doc)
            new_model=self.runtime.records._model(new_spec,model)
            typed_field=next(f for f in new_model["fields"] if f["name"]==name)
            if default_provided:
                if typed_field["type"]=="reference" and default_value is not None:
                    raise ModelMigrationDenied("Reference defaults require explicit individual relation checks")
                validate_row({"fields":[typed_field]}, {name:default_value})
            rows=db.execute("""SELECT row_id FROM builder_rows WHERE tenant=?
                AND project_id=? AND model=? AND deleted=0 ORDER BY row_id LIMIT ?""",
                (tenant,project_id,model,MAX_ROWS_MIGRATED+1)).fetchall()
            if len(rows)>MAX_ROWS_MIGRATED:
                raise ModelMigrationDenied("Online migration exceeds local row budget")
            if rows and typed_field["required"] and not default_provided:
                raise ModelMigrationDenied("Required field migration needs a typed default")
            changed_rows=0
            if default_provided:
                for old in rows:
                    original,header=self.runtime.records._row(
                        db,tenant,project_id,model,old["row_id"])
                    migrated={**original,name:default_value}
                    verified=validate_row(new_model,migrated)
                    digest_after=digest(verified)
                    updated=db.execute("""UPDATE builder_rows SET data_json=?,
                        content_digest=?,version=version+1
                        WHERE tenant=? AND project_id=? AND model=? AND row_id=?
                        AND version=? AND deleted=0""",
                        (canonical(verified).decode("utf-8"),digest_after,
                         tenant,project_id,model,old["row_id"],header["version"])).rowcount
                    if updated!=1:
                        raise ModelMigrationDenied("Concurrent record migration rejected")
                    changed_rows+=1
            return self._record(db,tenant,project_id,head,new_spec,
                                "ADD_FIELD",model,changed_rows)

    def rename_field(self,*,tenant:str,project_id:str,actor:str,
                     expected_revision:int,model:str,old_name:str,new_name:str)->dict:
        """Bounded, atomic non-reference field rename over existing stored rows.

        Relationships are never rewritten implicitly. Workflow predicates/actions
        using this field require a reviewed workflow migration first. Deleted
        tombstones also receive the new key, keeping all persisted JSON parseable.
        """
        if (type(old_name) is not str or type(new_name) is not str
            or not FIELD.fullmatch(old_name) or not FIELD.fullmatch(new_name)
            or old_name==new_name or new_name in SECRET_NAMES or new_name=="id"):
            raise ModelMigrationDenied("Invalid or reserved target field name")
        with self.runtime.drafts._tx() as db:
            doc,head=self._context(db,tenant,project_id,actor,
                                    expected_revision,write_records=True)
            definition=self.runtime.records._model(doc,model)
            old_definition=json.loads(canonical(definition))
            matching=[f for f in definition["fields"] if f["name"]==old_name]
            if len(matching)!=1:
                raise ModelMigrationDenied("Field not found")
            if matching[0]["type"]=="reference":
                raise ModelMigrationDenied("Reference field renaming requires explicit link migration")
            if any(f["name"]==new_name for f in definition["fields"]):
                raise ModelMigrationDenied("Target field name already exists")
            # Existing workflows are immutable declarations with field paths;
            # fail closed until their owner explicitly reviews each dependency.
            workflows=db.execute("""SELECT * FROM app_workflows
                WHERE tenant=? AND project_id=?""",
                (tenant,project_id)).fetchall()
            for workflow in workflows:
                rule=self.runtime._read_rule(workflow)["rule"]
                if rule["model"]==model and (
                    rule["action"]["field"]==old_name or
                    (rule["condition"] is not None and
                     rule["condition"]["field"]==old_name)):
                    raise ModelMigrationDenied("Workflow depends on field: migrate rule first")
            matching[0]["name"]=new_name
            # Selected field order on model-driven static forms follows rename.
            for page in doc["pages"]:
                for section in page["sections"]:
                    if section["type"]=="form" and section["model"]==model and "fields" in section:
                        section["fields"]=[new_name if name==old_name else name
                                           for name in section["fields"]]
            verified=validate_site_spec(doc)
            new_definition=self.runtime.records._model(verified,model)
            rows=db.execute("""SELECT row_id,deleted FROM builder_rows
                WHERE tenant=? AND project_id=? AND model=? ORDER BY row_id
                LIMIT ?""",
                (tenant,project_id,model,MAX_ROWS_MIGRATED+1)).fetchall()
            if len(rows)>MAX_ROWS_MIGRATED:
                raise ModelMigrationDenied("Field rename exceeds reviewed migration budget")
            for record in rows:
                old,header=self.runtime.records._row(
                    db,tenant,project_id,model,record["row_id"],deleted_allowed=True)
                validate_row(old_definition,old)
                # Optional fields absent in old data remain absent after rename.
                renamed={new_name if key==old_name else key:value
                         for key,value in old.items()}
                validated=validate_row(new_definition,renamed)
                updated=db.execute("""UPDATE builder_rows
                    SET data_json=?,content_digest=?,version=version+1
                    WHERE tenant=? AND project_id=? AND model=? AND row_id=?
                      AND version=? AND deleted=?""",
                    (canonical(validated).decode("utf-8"),digest(validated),
                     tenant,project_id,model,record["row_id"],header["version"],
                     record["deleted"])).rowcount
                if updated!=1:
                    raise ModelMigrationDenied("Concurrent row mutation during rename")
            return self._record(db,tenant,project_id,head,verified,
                                "RENAME_FIELD",model,len(rows))

    def rename_reference_field(self,*,tenant:str,project_id:str,actor:str,
                               expected_revision:int,model:str,
                               old_name:str,new_name:str)->dict:
        """Atomically rename a relation field *without changing its target*.

        Both JSON keys and builder_links.field change in the same transaction.
        Active links must already match verified row data; unexpected/missing
        indexes, deleted-row edges, stale versions and workflow dependencies
        cause a complete rollback. No foreign tenant or project identifiers
        can be supplied by the caller.
        """
        if (type(old_name) is not str or type(new_name) is not str
            or not FIELD.fullmatch(old_name) or not FIELD.fullmatch(new_name)
            or old_name==new_name or new_name in SECRET_NAMES or new_name=="id"):
            raise ModelMigrationDenied("Invalid or sensitive relation field name")
        with self.runtime.drafts._tx() as db:
            doc,head=self._context(db,tenant,project_id,actor,
                                   expected_revision,write_records=True)
            definition=self.runtime.records._model(doc,model)
            old_definition=json.loads(canonical(definition))
            selected=[f for f in definition["fields"] if f["name"]==old_name]
            if len(selected)!=1 or selected[0]["type"]!="reference":
                raise ModelMigrationDenied("Existing reference field required")
            if any(f["name"]==new_name for f in definition["fields"]):
                raise ModelMigrationDenied("Duplicate relation field name")
            for wf in db.execute("""SELECT * FROM app_workflows WHERE tenant=?
                    AND project_id=?""",(tenant,project_id)).fetchall():
                rule=self.runtime._read_rule(wf)["rule"]
                if rule["model"]==model and (
                    rule["action"]["field"]==old_name or
                    (rule["condition"] is not None and rule["condition"]["field"]==old_name)):
                    raise ModelMigrationDenied("Workflow references this relation: migrate rule first")
            target_model=selected[0]["references"]
            selected[0]["name"]=new_name
            for page in doc["pages"]:
                for section in page["sections"]:
                    if section["type"]=="form" and section["model"]==model and "fields" in section:
                        section["fields"]=[new_name if f==old_name else f
                                           for f in section["fields"]]
            new_spec=validate_site_spec(doc)
            changed_def=self.runtime.records._model(new_spec,model)
            rows=db.execute("""SELECT row_id,deleted FROM builder_rows
                WHERE tenant=? AND project_id=? AND model=?
                ORDER BY row_id LIMIT ?""",
                (tenant,project_id,model,MAX_ROWS_MIGRATED+1)).fetchall()
            if len(rows)>MAX_ROWS_MIGRATED:
                raise ModelMigrationDenied("Relation rename exceeds 500 rows")
            linked=0
            for entry in rows:
                body,header=self.runtime.records._row(
                    db,tenant,project_id,model,entry["row_id"],deleted_allowed=True)
                validate_row(old_definition,body)
                old_value=body.get(old_name)
                indexes=db.execute("""SELECT field,target_model,target_row_id
                    FROM builder_links WHERE tenant=? AND project_id=?
                    AND model=? AND row_id=? AND field IN (?,?)""",
                    (tenant,project_id,model,entry["row_id"],old_name,new_name)).fetchall()
                if (len(indexes)!=int(old_value is not None and not entry["deleted"])
                    or (indexes and
                        (indexes[0]["field"]!=old_name or
                         indexes[0]["target_model"]!=target_model or
                         indexes[0]["target_row_id"]!=old_value))):
                    raise ModelMigrationDenied("Stored relation index differs from JSON value")
                if old_value is not None and not entry["deleted"]:
                    self.runtime.records._refs(db,tenant,project_id,old_definition,body)
                    linked+=1
                new_body={new_name if key==old_name else key:value
                          for key,value in body.items()}
                verified=validate_row(changed_def,new_body)
                rewritten=db.execute("""UPDATE builder_rows SET
                    data_json=?,content_digest=?,version=version+1
                    WHERE tenant=? AND project_id=? AND model=? AND row_id=?
                    AND version=? AND deleted=?""",
                    (canonical(verified).decode("utf-8"),digest(verified),tenant,
                     project_id,model,entry["row_id"],header["version"],entry["deleted"])).rowcount
                if rewritten!=1:
                    raise ModelMigrationDenied("Record changed during reference rename")
                if indexes:
                    changed=db.execute("""UPDATE builder_links SET field=?
                        WHERE tenant=? AND project_id=? AND model=?
                        AND row_id=? AND field=? AND target_model=? AND target_row_id=?""",
                        (new_name,tenant,project_id,model,entry["row_id"],old_name,
                         target_model,old_value)).rowcount
                    if changed!=1:
                        raise ModelMigrationDenied("Reference index changed during rename")
            orphan=db.execute("""SELECT 1 FROM builder_links WHERE tenant=?
                AND project_id=? AND model=? AND field=? LIMIT 1""",
                (tenant,project_id,model,old_name)).fetchone()
            if orphan:
                raise ModelMigrationDenied("Orphaned relation index prevents migration")
            output=self._record(db,tenant,project_id,head,new_spec,
                                "RENAME_REFERENCE_FIELD",model,len(rows))
            return {**output,"updated_links":linked,
                    "reference_target_unchanged":True}

    def retarget_unused_reference(self,*,tenant:str,project_id:str,actor:str,
                                  expected_revision:int,model:str,
                                  field:str,new_target_model:str)->dict:
        """Rebind only an unused reference, never move a live relation silently."""
        if (type(field) is not str or type(new_target_model) is not str
            or not FIELD.fullmatch(field) or not FIELD.fullmatch(new_target_model)):
            raise ModelMigrationDenied("Invalid relationship model names")
        with self.runtime.drafts._tx() as db:
            spec,head=self._context(db,tenant,project_id,actor,
                                    expected_revision,write_records=True)
            src=self.runtime.records._model(spec,model)
            selected=[f for f in src["fields"] if f["name"]==field]
            if len(selected)!=1 or selected[0]["type"]!="reference":
                raise ModelMigrationDenied("Reference field required")
            old_target=selected[0]["references"]
            if old_target==new_target_model:
                raise ModelMigrationDenied("No target change requested")
            self.runtime.records._model(spec,new_target_model)
            # All active or deleted rows with a value, plus *all* link rows,
            # block rebind. This prevents silent data loss and dangling edges.
            rows=db.execute("""SELECT row_id FROM builder_rows WHERE
                tenant=? AND project_id=? AND model=? ORDER BY row_id LIMIT ?""",
                (tenant,project_id,model,MAX_ROWS_MIGRATED+1)).fetchall()
            if len(rows)>MAX_ROWS_MIGRATED:
                raise ModelMigrationDenied("Reference retarget exceeds row budget")
            if db.execute("""SELECT 1 FROM builder_links WHERE tenant=?
                AND project_id=? AND model=? AND field=? LIMIT 1""",
                (tenant,project_id,model,field)).fetchone():
                raise ModelMigrationDenied("Existing relation edges require explicit mapped migration")
            for row in rows:
                data,_=self.runtime.records._row(db,tenant,project_id,
                    model,row["row_id"],deleted_allowed=True)
                if data.get(field) is not None:
                    raise ModelMigrationDenied("Existing relationship data prevents retarget")
            # Workflow references to a relation are not automatically rewritten.
            for wf in db.execute("""SELECT * FROM app_workflows WHERE tenant=?
                    AND project_id=?""",(tenant,project_id)).fetchall():
                rule=self.runtime._read_rule(wf)["rule"]
                if rule["model"]==model and rule["condition"] is not None and (
                    rule["condition"]["field"]==field):
                    raise ModelMigrationDenied("Workflow requires manual review")
            selected[0]["references"]=new_target_model
            return self._record(db,tenant,project_id,head,spec,
                                "RETARGET_EMPTY_REFERENCE",model,0)

    def list_migrations(self,*,tenant:str,project_id:str,actor:str,
                        limit:int=50)->list[dict]:
        if type(limit) is not int or not 1<=limit<=100:
            raise ModelMigrationDenied("Invalid migration history limit")
        with self.runtime.drafts._db() as db:
            self.runtime._guard(db,tenant,project_id,actor,"spec.read")
            rows=db.execute("""SELECT spec_revision,operation,model_name,
                prior_sha256,new_sha256,rows_migrated FROM builder_model_migrations
                WHERE tenant=? AND project_id=? ORDER BY spec_revision DESC LIMIT ?""",
                (tenant,project_id,limit)).fetchall()
            return [dict(row) for row in rows]
