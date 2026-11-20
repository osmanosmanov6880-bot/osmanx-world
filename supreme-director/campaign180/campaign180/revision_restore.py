"""TITAN-X24: inspect-first, non-destructive restoration of page revisions.

Restores an older *site specification* as a new revision, never overwrites
history or user records. Model schemas must exactly match. All checks and
writes are in one BEGIN IMMEDIATE transaction, and caller confirms an exact
SHA-256 plan for a specific current and target revision.
"""
from __future__ import annotations
from typing import Any

from .app_runtime import LocalAppRuntime
from .builder import validate_site_spec
from .contracts import canonical,digest

PLAN_SCHEMA="osgard.original180.safe-page-restore/1"

class RevisionRestoreDenied(ValueError):
    pass

class LocalRevisionRestorer:
    def __init__(self,runtime:LocalAppRuntime):
        if type(runtime) is not LocalAppRuntime:
            raise RevisionRestoreDenied("Trusted local runtime required")
        self.runtime=runtime
        with runtime.drafts._db() as db:
            db.executescript("""CREATE TABLE IF NOT EXISTS builder_page_restores(
                tenant TEXT NOT NULL,project_id TEXT NOT NULL,from_revision INTEGER NOT NULL,
                target_revision INTEGER NOT NULL,new_revision INTEGER NOT NULL,
                preview_sha256 TEXT NOT NULL,restored_sha256 TEXT NOT NULL,
                PRIMARY KEY(tenant,project_id,new_revision));
            CREATE TRIGGER IF NOT EXISTS builder_page_restores_no_update
                BEFORE UPDATE ON builder_page_restores BEGIN
                SELECT RAISE(ABORT,'immutable restore receipt');END;
            CREATE TRIGGER IF NOT EXISTS builder_page_restores_no_delete
                BEFORE DELETE ON builder_page_restores BEGIN
                SELECT RAISE(ABORT,'immutable restore receipt');END;""")

    def list_revisions(self,*,tenant:str,project_id:str,actor:str,limit:int=30)->list[dict]:
        if type(limit) is not int or not 1<=limit<=50:
            raise RevisionRestoreDenied("Revision list limit out of bounds")
        with self.runtime.drafts._db() as db:
            self.runtime._guard(db,tenant,project_id,actor,"spec.read")
            rows=db.execute("""SELECT * FROM draft_revisions WHERE tenant=?
                AND project_id=? ORDER BY revision DESC LIMIT ?""",
                (tenant,project_id,limit)).fetchall()
            output=[]
            for row in rows:
                spec=self.runtime.drafts._checked(row)
                output.append({"revision":row["revision"],
                    "sha256":row["content_digest"],
                    "pages":len(spec["pages"]),
                    "models":len(spec["models"])})
            return output

    def _plan(self,db,*,tenant,project_id,actor,
              expected_revision,target_revision)->tuple[dict,dict]:
        if (type(expected_revision) is not int or expected_revision<1
            or type(target_revision) is not int or target_revision<1):
            raise RevisionRestoreDenied("Exact current and target revisions required")
        self.runtime._guard(db,tenant,project_id,actor,"spec.write")
        current,head=self.runtime.drafts._head(db,tenant,project_id)
        if head["revision"]!=expected_revision:
            raise RevisionRestoreDenied("Stale current revision; inspect again")
        if target_revision>expected_revision:
            raise RevisionRestoreDenied("Cannot restore a future revision")
        target_row=db.execute("""SELECT * FROM draft_revisions
            WHERE tenant=? AND project_id=? AND revision=?""",
            (tenant,project_id,target_revision)).fetchone()
        if target_row is None:
            raise RevisionRestoreDenied("Restore target not found")
        target=self.runtime.drafts._checked(target_row)
        if target["tenant_id"]!=tenant or target["project_id"]!=project_id:
            raise RevisionRestoreDenied("Restored spec crosses project boundary")
        if target["models"]!=current["models"]:
            raise RevisionRestoreDenied("Schema differs; data migration required, page restore blocked")
        current_pages={p["slug"]:p for p in current["pages"]}
        target_pages={p["slug"]:p for p in target["pages"]}
        changed_slugs=sorted(k for k in set(current_pages)|set(target_pages)
                             if current_pages.get(k)!=target_pages.get(k))
        plan={"schema":PLAN_SCHEMA,"tenant":tenant,"project_id":project_id,
              "current_revision":expected_revision,
              "current_sha256":head["content_digest"],
              "target_revision":target_revision,
              "target_sha256":target_row["content_digest"],
              "changed_page_slugs":changed_slugs,
              "pages_before":len(current["pages"]),
              "pages_after":len(target["pages"]),
              "site_metadata_changed":any(current.get(k)!=target.get(k)
                                            for k in ("title","description","locale")),
              "models_unchanged":True,
              "record_rows_untouched":True,
              "external_effects":0}
        return plan,target

    def inspect(self,*,tenant:str,project_id:str,actor:str,
                expected_revision:int,target_revision:int)->dict:
        with self.runtime.drafts._db() as db:
            plan,_=self._plan(db,tenant=tenant,project_id=project_id,actor=actor,
                              expected_revision=expected_revision,
                              target_revision=target_revision)
            return {"plan":plan,"plan_sha256":digest(plan),
                    "ready":True,"applied":False,"production_published":False}

    def restore(self,*,tenant:str,project_id:str,actor:str,
                expected_revision:int,target_revision:int,
                expected_plan_sha256:str)->dict:
        if (type(expected_plan_sha256) is not str
            or len(expected_plan_sha256)!=64
            or any(c not in "0123456789abcdef" for c in expected_plan_sha256)):
            raise RevisionRestoreDenied("Exact approved SHA-256 plan required")
        with self.runtime.drafts._tx() as db:
            plan,target=self._plan(db,tenant=tenant,project_id=project_id,actor=actor,
                                   expected_revision=expected_revision,
                                   target_revision=target_revision)
            if digest(plan)!=expected_plan_sha256:
                raise RevisionRestoreDenied("Plan changed; inspect again")
            target=validate_site_spec(target)
            target_sha=digest(target)
            if target_sha==plan["current_sha256"]:
                return {"changed":False,"revision":expected_revision,
                        "restored_from":target_revision,"sha256":target_sha,
                        "production_published":False}
            rev=expected_revision+1
            doc=canonical(target).decode("utf-8")
            changed=db.execute("""UPDATE draft_projects SET revision=?,
                content_digest=?,content_json=? WHERE tenant=? AND project_id=?
                AND revision=? AND content_digest=?""",
                (rev,target_sha,doc,tenant,project_id,
                 expected_revision,plan["current_sha256"])).rowcount
            if changed!=1:
                raise RevisionRestoreDenied("Current project changed during restore")
            db.execute("""INSERT INTO draft_revisions
                (tenant,project_id,revision,content_digest,content_json)
                VALUES(?,?,?,?,?)""",(tenant,project_id,rev,target_sha,doc))
            db.execute("""INSERT INTO builder_page_restores
                (tenant,project_id,from_revision,target_revision,new_revision,
                 preview_sha256,restored_sha256) VALUES(?,?,?,?,?,?,?)""",
                (tenant,project_id,expected_revision,target_revision,rev,
                 expected_plan_sha256,target_sha))
            return {"changed":True,"revision":rev,
                    "restored_from":target_revision,"sha256":target_sha,
                    "record_rows_untouched":True,
                    "production_published":False}
