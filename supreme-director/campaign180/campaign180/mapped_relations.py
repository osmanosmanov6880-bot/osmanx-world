"""TITAN-X21/X24 partial: inspect/approve atomic retarget of LIVE references.

An owner supplies an explicit old-ID -> new-ID mapping for every referenced
value. No automatic matching, target guessing, cross-tenant links or network I/O.
Inspection and apply recompute hashes of the spec, all source records,
link indexes, and candidate targets. Stale/missing/extra mappings fail closed.
This remains local SQLite code, NOT a production migration service.
"""
from __future__ import annotations

import json

from .builder import validate_row,validate_site_spec
from .contracts import canonical,digest
from .model_editor import LocalModelEditor,ModelMigrationDenied,MAX_ROWS_MIGRATED

PLAN_SCHEMA="osgard.original180.mapped-reference-migration/1"


class MappedReferenceDenied(ModelMigrationDenied):
    pass


class LocalMappedReferenceMigration:
    def __init__(self,runtime):
        from .app_runtime import LocalAppRuntime
        if type(runtime) is not LocalAppRuntime:
            raise MappedReferenceDenied("Trusted local runtime required")
        self.runtime=runtime
        self.schema=LocalModelEditor(runtime)
        with runtime.drafts._db() as db:
            db.executescript("""CREATE TABLE IF NOT EXISTS builder_reference_remaps(
                tenant TEXT NOT NULL,project_id TEXT NOT NULL,
                spec_revision INTEGER NOT NULL,model TEXT NOT NULL,
                field TEXT NOT NULL,old_target TEXT NOT NULL,new_target TEXT NOT NULL,
                mapping_sha256 TEXT NOT NULL,approved_plan_sha256 TEXT NOT NULL,
                changed_rows INTEGER NOT NULL,changed_links INTEGER NOT NULL,
                PRIMARY KEY(tenant,project_id,spec_revision));
            CREATE TRIGGER IF NOT EXISTS builder_reference_remaps_no_update
                BEFORE UPDATE ON builder_reference_remaps BEGIN
                SELECT RAISE(ABORT,'reference remap receipt immutable');END;
            CREATE TRIGGER IF NOT EXISTS builder_reference_remaps_no_delete
                BEFORE DELETE ON builder_reference_remaps BEGIN
                SELECT RAISE(ABORT,'reference remap receipt immutable');END;""")

    def _mapping(self,mapping):
        if type(mapping) is not list or not 1<=len(mapping)<=MAX_ROWS_MIGRATED:
            raise MappedReferenceDenied("Expected a bounded nonempty explicit mapping")
        by_old={}
        by_new=set()
        for entry in mapping:
            if type(entry) is not dict or set(entry)!={"from_id","to_id"}:
                raise MappedReferenceDenied("Mapping entry must have from_id and to_id")
            old,new=entry["from_id"],entry["to_id"]
            self.runtime.records._rowid(old)
            self.runtime.records._rowid(new)
            if old in by_old or new in by_new:
                raise MappedReferenceDenied("Duplicate source/target mapping denied")
            by_old[old]=new
            by_new.add(new)
        return by_old

    def _plan(self,db,*,tenant,project_id,actor,expected_revision,
              model,field,new_target_model,mapping):
        if type(expected_revision) is not int or expected_revision<1:
            raise MappedReferenceDenied("Expected exact positive schema revision")
        self.runtime._guard(db,tenant,project_id,actor,"spec.write")
        self.runtime._guard(db,tenant,project_id,actor,"record.write")
        current,head=self.runtime.drafts._head(db,tenant,project_id)
        if head["revision"]!=expected_revision:
            raise MappedReferenceDenied("Project schema changed: inspect again")
        source=self.runtime.records._model(current,model)
        self.runtime.records._model(current,new_target_model)
        matches=[f for f in source["fields"] if f["name"]==field]
        if len(matches)!=1 or matches[0]["type"]!="reference":
            raise MappedReferenceDenied("A reference field must exist in source model")
        old_target=matches[0]["references"]
        if new_target_model==old_target:
            raise MappedReferenceDenied("New model must differ from old target")
        for wf in db.execute("""SELECT * FROM app_workflows WHERE tenant=? AND
            project_id=?""",(tenant,project_id)).fetchall():
            rule=self.runtime._read_rule(wf)["rule"]
            if rule["model"]==model and (
                rule["action"]["field"]==field or
                (rule["condition"] is not None and rule["condition"]["field"]==field)):
                raise MappedReferenceDenied("Dependent workflows require separate review")
        mapped=self._mapping(mapping)
        records=db.execute("""SELECT row_id,deleted FROM builder_rows
            WHERE tenant=? AND project_id=? AND model=?
            ORDER BY row_id LIMIT ?""",
            (tenant,project_id,model,MAX_ROWS_MIGRATED+1)).fetchall()
        if len(records)>MAX_ROWS_MIGRATED:
            raise MappedReferenceDenied("Local migration limited to 500 records")
        before_definition=json.loads(canonical(source))
        row_snapshot=[]
        pending=[]
        referenced=set()
        total_links=0
        for rec in records:
            data,header=self.runtime.records._row(db,tenant,project_id,
                 model,rec["row_id"],deleted_allowed=True)
            validate_row(before_definition,data)
            old_id=data.get(field)
            entries=db.execute("""SELECT field,target_model,target_row_id FROM builder_links
                WHERE tenant=? AND project_id=? AND model=? AND row_id=? AND field=?""",
                (tenant,project_id,model,rec["row_id"],field)).fetchall()
            expected_links=int(old_id is not None and not rec["deleted"])
            if len(entries)!=expected_links:
                raise MappedReferenceDenied("Relation index disagrees with source JSON")
            if entries and (entries[0]["target_model"]!=old_target or
                            entries[0]["target_row_id"]!=old_id):
                raise MappedReferenceDenied("Unexpected relation target in index")
            if not rec["deleted"]:
                self.runtime.records._refs(db,tenant,project_id,before_definition,data)
            if old_id is not None:
                referenced.add(old_id)
                pending.append((header,data,old_id))
                total_links+=expected_links
            row_snapshot.append({"row_id":header["row_id"],"version":header["version"],
                                 "sha256":header["content_digest"],
                                 "deleted":header["deleted"],"old_value":old_id})
        indexes=db.execute("""SELECT COUNT(*) FROM builder_links WHERE tenant=?
            AND project_id=? AND model=? AND field=?""",
            (tenant,project_id,model,field)).fetchone()[0]
        if indexes!=total_links:
            raise MappedReferenceDenied("Unexpected/orphaned source relation indexes")
        if not referenced:
            raise MappedReferenceDenied("Nothing to migrate; use unused-reference retarget")
        if set(mapped)!=referenced:
            raise MappedReferenceDenied("Mapping must cover EXACTLY every referenced source ID")
        target_snapshot=[]
        for old_id,new_id in sorted(mapped.items()):
            body,target=self.runtime.records._row(db,tenant,project_id,
                new_target_model,new_id)
            target_definition=self.runtime.records._model(current,new_target_model)
            validate_row(target_definition,body)
            target_snapshot.append({"from_id":old_id,"to_id":new_id,
                                    "target_version":target["version"],
                                    "target_sha256":target["content_digest"]})
        new_spec=json.loads(canonical(current))
        new_model=self.runtime.records._model(new_spec,model)
        next(f for f in new_model["fields"] if f["name"]==field)["references"]=new_target_model
        validate_site_spec(new_spec)
        state_sha=digest({"source_rows":row_snapshot,
                          "mapped_targets":target_snapshot,
                          "active_links":total_links})
        mapping_sha=digest([{"from_id":old,"to_id":mapped[old]}
                            for old in sorted(mapped)])
        plan={"schema":PLAN_SCHEMA,"tenant":tenant,"project_id":project_id,
              "expected_revision":expected_revision,
              "current_sha256":head["content_digest"],
              "model":model,"field":field,
              "old_target_model":old_target,
              "new_target_model":new_target_model,
              "mapping_sha256":mapping_sha,
              "data_state_sha256":state_sha,
              "mapped_values":len(mapped),
              "changed_rows":len(pending),
              "changed_links":total_links,
              "deleted_rows_with_values":sum(1 for h,_,_ in pending if h["deleted"]),
              "tenant_scope_verified":True,
              "production_published":False,
              "external_actions":0}
        return plan,new_spec,pending,mapped

    def inspect(self,*,tenant:str,project_id:str,actor:str,
                expected_revision:int,model:str,field:str,new_target_model:str,
                mapping:list[dict])->dict:
        with self.runtime.drafts._db() as db:
            plan,*_=self._plan(db,tenant=tenant,project_id=project_id,
                actor=actor,expected_revision=expected_revision,
                model=model,field=field,new_target_model=new_target_model,
                mapping=mapping)
            return {"plan":plan,"plan_sha256":digest(plan),
                    "ready":True,"applied":False,"production_published":False}

    def apply(self,*,tenant:str,project_id:str,actor:str,
              expected_revision:int,model:str,field:str,new_target_model:str,
              mapping:list[dict],expected_plan_sha256:str)->dict:
        if (type(expected_plan_sha256) is not str or len(expected_plan_sha256)!=64
                or any(ch not in "0123456789abcdef" for ch in expected_plan_sha256)):
            raise MappedReferenceDenied("Exact reviewed plan SHA-256 required")
        with self.runtime.drafts._tx() as db:
            plan,new_spec,pending,mapped=self._plan(db,tenant=tenant,
                project_id=project_id,actor=actor,expected_revision=expected_revision,
                model=model,field=field,new_target_model=new_target_model,mapping=mapping)
            if digest(plan)!=expected_plan_sha256:
                raise MappedReferenceDenied("Mapped relation data changed; inspect again")
            new_model=self.runtime.records._model(new_spec,model)
            changed_links=0
            for head,body,old_id in pending:
                updated={**body,field:mapped[old_id]}
                verified=validate_row(new_model,updated)
                if not head["deleted"]:
                    self.runtime.records._refs(db,tenant,project_id,new_model,verified)
                count=db.execute("""UPDATE builder_rows SET version=version+1,
                    content_digest=?,data_json=? WHERE tenant=? AND project_id=?
                    AND model=? AND row_id=? AND version=? AND deleted=?""",
                    (digest(verified),canonical(verified).decode("utf-8"),
                     tenant,project_id,model,head["row_id"],head["version"],head["deleted"])).rowcount
                if count!=1:
                    raise MappedReferenceDenied("Concurrent record edit rejected")
                if not head["deleted"]:
                    change=db.execute("""UPDATE builder_links SET
                        target_model=?,target_row_id=? WHERE tenant=? AND project_id=?
                        AND model=? AND row_id=? AND field=?
                        AND target_model=? AND target_row_id=?""",
                        (new_target_model,mapped[old_id],tenant,project_id,model,
                         head["row_id"],field,plan["old_target_model"],old_id)).rowcount
                    if change!=1:
                        raise MappedReferenceDenied("Concurrent link mutation rejected")
                    changed_links+=1
            revision=self.schema._record(db,tenant,project_id,
                {"revision":expected_revision,"content_digest":plan["current_sha256"]},
                new_spec,"MAP_REFERENCE_TARGETS",model,len(pending))
            db.execute("""INSERT INTO builder_reference_remaps
                (tenant,project_id,spec_revision,model,field,old_target,new_target,
                 mapping_sha256,approved_plan_sha256,changed_rows,changed_links)
                VALUES(?,?,?,?,?,?,?,?,?,?,?)""",
                (tenant,project_id,revision["revision"],model,field,
                 plan["old_target_model"],new_target_model,
                 plan["mapping_sha256"],expected_plan_sha256,len(pending),changed_links))
            return {**revision,"changed_links":changed_links,
                    "mapped_values":len(mapped),
                    "approved_plan_sha256":expected_plan_sha256,
                    "production_published":False}
