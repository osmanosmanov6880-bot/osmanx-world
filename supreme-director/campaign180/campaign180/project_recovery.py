"""TITAN-X24 partial: verified, project-scoped local recovery bundle.

Export covers current spec + bounded rows + relationship indexes, NOT
workflow history, roles, secrets, or other tenant projects. Restore can ONLY
create a separate project under the same verified tenant, with the current
owner as the sole principal. It cannot overwrite or deploy an existing app.

Recovery bundles contain potentially sensitive business data: keep offline,
encrypted, access-controlled. SHA-256 detects changes, not authenticity.
"""
from __future__ import annotations

from hashlib import sha256
import json
from typing import Any

from .app_runtime import LocalAppRuntime
from .app_policy import AppAccessDenied
from .builder import validate_site_spec,validate_row
from .contracts import canonical,digest
from .drafts import _identity

BUNDLE_SCHEMA="osgard.original180.project-data-recovery/1"
MAX_ROWS=2000
MAX_LINKS=5000
MAX_BUNDLE_BYTES=3*1024*1024


class RecoveryDenied(ValueError):
    pass


class LocalProjectRecovery:
    def __init__(self,runtime:LocalAppRuntime):
        if type(runtime) is not LocalAppRuntime:
            raise RecoveryDenied("Trusted runtime required")
        self.runtime=runtime

    def _assemble(self,db,*,tenant,project_id,actor):
        self.runtime._guard(db,tenant,project_id,actor,"members.manage")
        spec,head=self.runtime.drafts._head(db,tenant,project_id)
        raw_rows=db.execute("""SELECT * FROM builder_rows WHERE tenant=? AND project_id=?
            ORDER BY model,row_id LIMIT ?""",(tenant,project_id,MAX_ROWS+1)).fetchall()
        raw_links=db.execute("""SELECT * FROM builder_links WHERE tenant=? AND project_id=?
            ORDER BY model,row_id,field LIMIT ?""",(tenant,project_id,MAX_LINKS+1)).fetchall()
        if len(raw_rows)>MAX_ROWS or len(raw_links)>MAX_LINKS:
            raise RecoveryDenied("Local recovery snapshot budget exceeded")
        rows=[]
        for row in raw_rows:
            model=self.runtime.records._model(spec,row["model"])
            value,header=self.runtime.records._row(db,tenant,project_id,
                row["model"],row["row_id"],deleted_allowed=True)
            validate_row(model,value)
            rows.append({"model":row["model"],"row_id":row["row_id"],
                "version":row["version"],"deleted":bool(row["deleted"]),
                "fields":value,"sha256":row["content_digest"]})
        links=[{"model":r["model"],"row_id":r["row_id"],"field":r["field"],
                "target_model":r["target_model"],"target_row_id":r["target_row_id"]}
               for r in raw_links]
        bundle={"schema":BUNDLE_SCHEMA,"source_tenant":tenant,
                "source_project_id":project_id,"source_revision":head["revision"],
                "source_spec_sha256":head["content_digest"],
                "spec":spec,"rows":rows,"links":links,
                "includes_roles":False,"includes_workflows":False,
                "production_authorized":False}
        # Validate even the locally generated material before exporting.
        self._verified(bundle)
        return bundle

    def _verified(self,blob:Any):
        if type(blob) is not dict or set(blob)!={
            "schema","source_tenant","source_project_id","source_revision",
            "source_spec_sha256","spec","rows","links","includes_roles",
            "includes_workflows","production_authorized"}:
            raise RecoveryDenied("Unknown recovery bundle structure")
        if blob["schema"]!=BUNDLE_SCHEMA or any(blob[k] is not False for k in
            ("includes_roles","includes_workflows","production_authorized")):
            raise RecoveryDenied("Untrusted recovery export flags")
        _identity(blob["source_tenant"],blob["source_project_id"])
        if type(blob["source_revision"]) is not int or blob["source_revision"]<1:
            raise RecoveryDenied("Invalid source revision")
        spec=validate_site_spec(blob["spec"])
        if spec["tenant_id"]!=blob["source_tenant"] or spec["project_id"]!=blob["source_project_id"]:
            raise RecoveryDenied("Recovery document crosses source project")
        if digest(spec)!=blob["source_spec_sha256"]:
            raise RecoveryDenied("Recovery specification SHA-256 mismatch")
        rows,links=blob["rows"],blob["links"]
        if (type(rows) is not list or type(links) is not list or
            len(rows)>MAX_ROWS or len(links)>MAX_LINKS):
            raise RecoveryDenied("Recovery records exceed local resource bounds")
        indexed={}
        observed=set()
        ordered_rows=[]
        for row in rows:
            if type(row) is not dict or set(row)!={
                "model","row_id","version","deleted","fields","sha256"}:
                raise RecoveryDenied("Unknown recovery row structure")
            self.runtime.records._rowid(row["row_id"])
            if type(row["version"]) is not int or row["version"]<1 or type(row["deleted"]) is not bool:
                raise RecoveryDenied("Invalid record revision or deletion flag")
            model=self.runtime.records._model(spec,row["model"])
            body=validate_row(model,row["fields"])
            if digest(body)!=row["sha256"]:
                raise RecoveryDenied("Recovery row checksum mismatch")
            key=(row["model"],row["row_id"])
            if key in indexed:raise RecoveryDenied("Duplicate record in recovery bundle")
            indexed[key]=row
            ordered_rows.append(key)
        if ordered_rows!=sorted(ordered_rows):
            raise RecoveryDenied("Noncanonical recovery record ordering")
        expected=set()
        for row in rows:
            if row["deleted"]:continue
            model=self.runtime.records._model(spec,row["model"])
            for field in model["fields"]:
                if field["type"]!="reference":continue
                target=row["fields"].get(field["name"])
                if target is None:continue
                found=indexed.get((field["references"],target))
                if found is None or found["deleted"]:
                    raise RecoveryDenied("Recovery relation points to absent/deleted record")
                expected.add((row["model"],row["row_id"],field["name"],
                              field["references"],target))
        observed_links=[]
        for link in links:
            if type(link) is not dict or set(link)!={
                "model","row_id","field","target_model","target_row_id"}:
                raise RecoveryDenied("Unknown recovery link structure")
            self.runtime.records._rowid(link["row_id"])
            self.runtime.records._rowid(link["target_row_id"])
            observed_links.append((link["model"],link["row_id"],link["field"],
                                   link["target_model"],link["target_row_id"]))
        if observed_links!=sorted(observed_links) or len(observed_links)!=len(set(observed_links)):
            raise RecoveryDenied("Unordered or duplicate recovery relationship index")
        if set(observed_links)!=expected:
            raise RecoveryDenied("Recovery relationship index does not match active JSON records")
        return spec

    def _pack(self,bundle):
        payload=canonical(bundle)
        if len(payload)>MAX_BUNDLE_BYTES:
            raise RecoveryDenied("Recovery bundle is larger than local cap")
        return payload

    def inspect(self,*,tenant:str,project_id:str,actor:str)->dict:
        """Owner-only, metadata-only report. Does not expose customer payloads."""
        with self.runtime.drafts._tx() as db:
            bundle=self._assemble(db,tenant=tenant,project_id=project_id,actor=actor)
            blob=self._pack(bundle)
            check=db.execute("PRAGMA quick_check").fetchone()[0]
            if check!="ok":
                raise RecoveryDenied("SQLite integrity check failed")
            return {"revision":bundle["source_revision"],
                    "spec_sha256":bundle["source_spec_sha256"],
                    "bundle_sha256":sha256(blob).hexdigest(),
                    "records":len(bundle["rows"]),"links":len(bundle["links"]),
                    "sqlite_quick_check":"ok",
                    "includes_roles":False,"includes_workflows":False,
                    "production_published":False,
                    "plaintext_exported":False}

    def export_bytes(self,*,tenant:str,project_id:str,actor:str)->bytes:
        """Trusted local library only. DO NOT expose on the HTTP console."""
        with self.runtime.drafts._tx() as db:
            return self._pack(self._assemble(db,tenant=tenant,project_id=project_id,
                                             actor=actor))

    def verify_bytes(self,content:bytes,*,expected_sha256:str)->dict:
        if (type(content) is not bytes or len(content)>MAX_BUNDLE_BYTES or
            type(expected_sha256) is not str or len(expected_sha256)!=64 or
            any(c not in "0123456789abcdef" for c in expected_sha256)):
            raise RecoveryDenied("Missing exact recovery bundle and expected digest")
        actual=sha256(content).hexdigest()
        if actual!=expected_sha256:
            raise RecoveryDenied("Recovery bundle SHA-256 differs")
        try:
            obj=json.loads(content,parse_constant=lambda _: (_ for _ in ()).throw(ValueError()))
        except (UnicodeDecodeError,ValueError,TypeError) as exc:
            raise RecoveryDenied("Recovery bundle is not valid JSON") from exc
        if canonical(obj)!=content:
            raise RecoveryDenied("Recovery bundle is not canonically encoded")
        self._verified(obj)
        return obj

    def restore_to_new_project(self,content:bytes,*,tenant:str,actor:str,
                               new_project_id:str,expected_sha256:str,
                               now:int)->dict:
        """Explicit local clone, no overwrite. Creates only one trusted owner.

        No workflows, user role delegations, webhook registrations, or
        previously-used idempotency keys are copied.
        """
        bundle=self.verify_bytes(content,expected_sha256=expected_sha256)
        _identity(tenant,new_project_id)
        self.runtime.policy._actor(actor)
        self.runtime.policy._epoch(now)
        if tenant!=bundle["source_tenant"] or new_project_id==bundle["source_project_id"]:
            raise RecoveryDenied("Recovery must clone into distinct project of same tenant")
        spec=json.loads(canonical(bundle["spec"]))
        spec["project_id"]=new_project_id
        normalized=validate_site_spec(spec)
        spec_sha=digest(normalized)
        doc=canonical(normalized).decode("utf-8")
        with self.runtime.drafts._tx() as db:
            self.runtime._guard(db,tenant,bundle["source_project_id"],actor,
                                "members.manage")
            found=db.execute("""SELECT 1 FROM draft_projects WHERE tenant=? AND project_id=?""",
                             (tenant,new_project_id)).fetchone()
            if found:
                raise RecoveryDenied("Target project exists and can never be overwritten")
            db.execute("""INSERT INTO draft_projects
                (tenant,project_id,revision,content_digest,content_json)
                VALUES(?,?,1,?,?)""",(tenant,new_project_id,spec_sha,doc))
            db.execute("""INSERT INTO draft_revisions
                (tenant,project_id,revision,content_digest,content_json)
                VALUES(?,?,1,?,?)""",(tenant,new_project_id,spec_sha,doc))
            for row in bundle["rows"]:
                db.execute("""INSERT INTO builder_rows
                    (tenant,project_id,model,row_id,version,content_digest,data_json,deleted)
                    VALUES(?,?,?,?,?,?,?,?)""",
                    (tenant,new_project_id,row["model"],row["row_id"],row["version"],
                     row["sha256"],canonical(row["fields"]).decode("utf-8"),int(row["deleted"])))
            for link in bundle["links"]:
                db.execute("""INSERT INTO builder_links
                    (tenant,project_id,model,row_id,field,target_model,target_row_id)
                    VALUES(?,?,?,?,?,?,?)""",
                    (tenant,new_project_id,link["model"],link["row_id"],link["field"],
                     link["target_model"],link["target_row_id"]))
            db.execute("""INSERT INTO app_memberships
                (tenant,project_id,actor,role,active,revision)
                VALUES(?,?,?,'owner',1,1)""",(tenant,new_project_id,actor))
            db.execute("""INSERT INTO app_membership_events
                (tenant,project_id,actor,operation,at_epoch)
                VALUES(?,?,?,'RECOVERY_NEW_PROJECT_OWNER',?)""",
                (tenant,new_project_id,actor,now))
            return {"new_project_id":new_project_id,
                    "source_project_id":bundle["source_project_id"],
                    "spec_revision":1,
                    "source_revision":bundle["source_revision"],
                    "restored_records":len(bundle["rows"]),
                    "restored_links":len(bundle["links"]),
                    "restored_workflows":0,"only_owner_bootstrapped":True,
                    "source_project_unchanged":True,
                    "production_published":False}
