"""TITAN-X20/X24 local no-AI editing, optimistic revisions, import/export.

All calls are privileged local library operations, never HTTP endpoints.
No external identity verification, publication, shared-product migration or
independent ownership approval is implied by the local revision history.
"""
from __future__ import annotations
from contextlib import contextmanager
from hashlib import sha256
import json
from pathlib import Path
import sqlite3
from typing import Any
import uuid

from .builder import SCHEMA, SiteSpecDenied, validate_site_spec
from .contracts import TENANT_RE, canonical, digest

BUNDLE="osgard.original180.local-site-bundle/1"
MAX_BUNDLE=100*1024

class DraftDenied(SiteSpecDenied):
    pass

def _identity(tenant:str,project_id:str)->None:
    if type(tenant) is not str or not TENANT_RE.fullmatch(tenant):
        raise DraftDenied("Invalid or missing explicit tenant")
    try:
        if type(project_id) is not str or str(uuid.UUID(project_id))!=project_id:
            raise ValueError()
    except ValueError as exc:
        raise DraftDenied("Project ID must be canonical UUID") from exc

class LocalDraftStore:
    """Every revision is durable and content-addressed; writes use BEGIN IMMEDIATE."""

    def __init__(self,path:Path|str):
        self.path=str(path)
        with self._db() as db:
            db.executescript("""CREATE TABLE IF NOT EXISTS draft_projects (
                tenant TEXT NOT NULL,project_id TEXT NOT NULL,
                revision INTEGER NOT NULL,content_digest TEXT NOT NULL,
                content_json TEXT NOT NULL,PRIMARY KEY(tenant,project_id));
            CREATE TABLE IF NOT EXISTS draft_revisions (
                tenant TEXT NOT NULL,project_id TEXT NOT NULL,
                revision INTEGER NOT NULL,content_digest TEXT NOT NULL,
                content_json TEXT NOT NULL,PRIMARY KEY(tenant,project_id,revision));
            CREATE TRIGGER IF NOT EXISTS draft_revision_no_update
                BEFORE UPDATE ON draft_revisions BEGIN
                SELECT RAISE(ABORT,'revision history immutable');END;
            CREATE TRIGGER IF NOT EXISTS draft_revision_no_delete
                BEFORE DELETE ON draft_revisions BEGIN
                SELECT RAISE(ABORT,'revision history immutable');END;""")

    def _db(self)->sqlite3.Connection:
        db=sqlite3.connect(self.path,isolation_level=None,timeout=15)
        db.row_factory=sqlite3.Row
        db.execute("PRAGMA busy_timeout=15000")
        return db

    @contextmanager
    def _tx(self):
        db=self._db()
        try:
            db.execute("BEGIN IMMEDIATE")
            yield db
            db.commit()
        except BaseException:
            db.rollback()
            raise
        finally:
            db.close()

    @staticmethod
    def _checked(row:sqlite3.Row)->dict:
        try:
            raw=json.loads(row["content_json"])
            normal=validate_site_spec(raw)
        except (ValueError,TypeError) as exc:
            raise DraftDenied("Persisted specification invalid") from exc
        if canonical(normal).decode("utf-8")!=row["content_json"]:
            raise DraftDenied("Persisted specification is not canonical")
        if digest(normal)!=row["content_digest"]:
            raise DraftDenied("Persisted specification digest differs")
        return normal

    def _head(self,db,tenant,project)->tuple[dict,sqlite3.Row]:
        row=db.execute("""SELECT * FROM draft_projects
            WHERE tenant=? AND project_id=?""",(tenant,project)).fetchone()
        if row is None:
            raise DraftDenied("Tenant project not found")
        last=db.execute("""SELECT * FROM draft_revisions WHERE
            tenant=? AND project_id=? AND revision=?""",
            (tenant,project,row["revision"])).fetchone()
        if last is None or last["content_digest"]!=row["content_digest"]:
            raise DraftDenied("Project head has no consistent immutable revision")
        body=self._checked(row)
        if self._checked(last)!=body:
            raise DraftDenied("Current revision differs from history")
        return body,row

    def create(self,spec:dict,*,tenant:str)->dict:
        normal=validate_site_spec(spec)
        _identity(tenant,normal["project_id"])
        if tenant!=normal["tenant_id"]:
            raise DraftDenied("Server tenant differs from supplied specification")
        body=canonical(normal).decode("utf-8")
        sha=digest(normal)
        with self._tx() as db:
            if db.execute("""SELECT 1 FROM draft_projects WHERE tenant=?
                AND project_id=?""",(tenant,normal["project_id"])).fetchone():
                raise DraftDenied("Cannot overwrite existing tenant project")
            db.execute("""INSERT INTO draft_projects
                (tenant,project_id,revision,content_digest,content_json)
                VALUES(?,?,1,?,?)""",(tenant,normal["project_id"],sha,body))
            db.execute("""INSERT INTO draft_revisions
                (tenant,project_id,revision,content_digest,content_json)
                VALUES(?,?,1,?,?)""",(tenant,normal["project_id"],sha,body))
        return {"tenant":tenant,"project_id":normal["project_id"],
                "revision":1,"sha256":sha,"production_published":False}

    def load(self,*,tenant:str,project_id:str,revision:int|None=None)->dict:
        _identity(tenant,project_id)
        if revision is not None and (type(revision) is not int or revision<1):
            raise DraftDenied("Invalid revision number")
        with self._db() as db:
            if revision is None:
                raw,_=self._head(db,tenant,project_id)
                return raw
            head,header=self._head(db,tenant,project_id)
            if revision>header["revision"]:
                raise DraftDenied("Requested revision does not exist")
            row=db.execute("""SELECT * FROM draft_revisions WHERE
                tenant=? AND project_id=? AND revision=?""",
                (tenant,project_id,revision)).fetchone()
            if row is None:
                raise DraftDenied("Requested revision missing")
            return self._checked(row)

    def current_revision(self,*,tenant:str,project_id:str)->dict:
        _identity(tenant,project_id)
        with self._db() as db:
            _,row=self._head(db,tenant,project_id)
            return {"revision":row["revision"],"sha256":row["content_digest"],
                    "tenant":tenant,"project_id":project_id}

    def save(self,*,tenant:str,project_id:str,expected_revision:int,spec:dict)->dict:
        _identity(tenant,project_id)
        if type(expected_revision) is not int or expected_revision<1:
            raise DraftDenied("Expected exact revision")
        normal=validate_site_spec(spec)
        if normal["tenant_id"]!=tenant or normal["project_id"]!=project_id:
            raise DraftDenied("Cannot silently rebind a project between tenants")
        body=canonical(normal).decode("utf-8")
        sha=digest(normal)
        with self._tx() as db:
            old,header=self._head(db,tenant,project_id)
            if header["revision"]!=expected_revision:
                raise DraftDenied("Stale edit: compare-and-swap failed")
            if old["models"]!=normal["models"]:
                exists=db.execute("""SELECT 1 FROM sqlite_master WHERE
                    type='table' AND name='builder_rows'""").fetchone()
                if exists and db.execute("""SELECT 1 FROM builder_rows WHERE
                    tenant=? AND project_id=? LIMIT 1""",
                    (tenant,project_id)).fetchone():
                    raise DraftDenied("Schema changes require an explicit row migration")
            if sha==header["content_digest"]:
                return {"tenant":tenant,"project_id":project_id,"revision":expected_revision,
                        "sha256":sha,"changed":False,"production_published":False}
            next_version=expected_revision+1
            updated=db.execute("""UPDATE draft_projects SET revision=?,
                content_digest=?,content_json=? WHERE tenant=? AND project_id=?
                AND revision=?""",(next_version,sha,body,tenant,project_id,
                                    expected_revision)).rowcount
            if updated!=1:
                raise DraftDenied("Concurrent edit rejected")
            db.execute("""INSERT INTO draft_revisions
                (tenant,project_id,revision,content_digest,content_json)
                VALUES(?,?,?,?,?)""",(tenant,project_id,next_version,sha,body))
            return {"tenant":tenant,"project_id":project_id,
                    "revision":next_version,"sha256":sha,"changed":True,
                    "production_published":False}

    def edit_page(self,*,tenant:str,project_id:str,slug:str,
                  expected_revision:int,title:str|None=None,
                  section_index:int|None=None,changes:dict|None=None)->dict:
        """A bounded no-AI editor operation, not arbitrary JSON patching."""
        _identity(tenant,project_id)
        if type(slug) is not str:
            raise DraftDenied("Expected page slug")
        current=self.load(tenant=tenant,project_id=project_id)
        matching=[p for p in current["pages"] if p["slug"]==slug]
        if len(matching)!=1:
            raise DraftDenied("Page not found")
        page=matching[0]
        if title is None and changes is None:
            raise DraftDenied("Empty page update")
        if title is not None:
            page["title"]=title
        if changes is not None:
            if type(section_index) is not int or not 0<=section_index<len(page["sections"]):
                raise DraftDenied("Invalid section index")
            section=page["sections"][section_index]
            if type(changes) is not dict or not changes or "type" in changes or (
                set(changes)-set(section)):
                raise DraftDenied("Cannot alter section type or add unsupported fields")
            section.update(changes)
        return self.save(tenant=tenant,project_id=project_id,
                         expected_revision=expected_revision,spec=current)

    def revert(self,*,tenant:str,project_id:str,target_revision:int,
               expected_revision:int)->dict:
        """Revert means a NEW revision; history is never rewritten."""
        source=self.load(tenant=tenant,project_id=project_id,revision=target_revision)
        return self.save(tenant=tenant,project_id=project_id,
                         expected_revision=expected_revision,spec=source)

    def export_bundle(self,*,tenant:str,project_id:str,revision:int|None=None)->bytes:
        spec=self.load(tenant=tenant,project_id=project_id,revision=revision)
        current=self.current_revision(tenant=tenant,project_id=project_id)
        version=current["revision"] if revision is None else revision
        data={"schema":BUNDLE,"source_tenant":tenant,"source_project_id":project_id,
              "revision":version,"source_spec_sha256":digest(spec),"spec":spec,
              "includes_live_records":False,"production_authorized":False}
        blob=canonical(data)
        if len(blob)>MAX_BUNDLE:
            raise DraftDenied("Export exceeds local bundle limit")
        return blob

    def import_bundle(self,content:bytes,*,target_tenant:str,
                      new_project_id:str,expected_sha256:str)->dict:
        """Creates a new project only. Never overwrites or imports live records."""
        _identity(target_tenant,new_project_id)
        if type(content) is not bytes or not 0<len(content)<=MAX_BUNDLE:
            raise DraftDenied("Invalid bundle length")
        if type(expected_sha256) is not str or sha256(content).hexdigest()!=expected_sha256:
            raise DraftDenied("Bundle digest differs from separately supplied SHA256")
        try:
            raw=json.loads(content.decode("utf-8"))
        except (ValueError,UnicodeError) as exc:
            raise DraftDenied("Bundle JSON invalid") from exc
        if (type(raw) is not dict or set(raw)!={"schema","source_tenant","source_project_id",
                "revision","source_spec_sha256","spec","includes_live_records",
                "production_authorized"} or raw["schema"]!=BUNDLE or raw["includes_live_records"] is not False
                or raw["production_authorized"] is not False
                or type(raw["revision"]) is not int or raw["revision"]<1
                or canonical(raw)!=content):
            raise DraftDenied("Unknown, mutated or noncanonical bundle")
        if raw["source_tenant"]!=target_tenant or raw["spec"].get("tenant_id")!=target_tenant:
            raise DraftDenied("Cross-tenant imports require a separate verified migration")
        if raw["source_project_id"]!=raw["spec"].get("project_id"):
            raise DraftDenied("Source project identity mismatch")
        original=validate_site_spec(raw["spec"])
        if digest(original)!=raw["source_spec_sha256"]:
            raise DraftDenied("Source specification hash mismatch")
        recreated={**original,"project_id":new_project_id}
        return self.create(recreated,tenant=target_tenant)
