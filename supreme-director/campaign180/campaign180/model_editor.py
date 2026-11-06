"""TITAN-X21/X24: reviewed, bounded, transaction-safe model schema migrations.

A model is a versioned JSON definition, not an executable SQL identifier.
Adding a field with a typed default migrates stored JSON records atomically
and bumps their optimistic row versions. Unknown/unsafe operations fail closed.
No cross-tenant data migration, destructive production DDL or external schema.
"""
from __future__ import annotations

import json
from typing import Any

from .builder import FIELD, SiteSpecDenied, validate_row, validate_site_spec
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
