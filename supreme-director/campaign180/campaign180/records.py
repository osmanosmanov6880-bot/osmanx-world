"""TITAN-X21 partial: tenant-isolated SQLite records with typed relation checks.

This is a local data-model engine, not an authenticated production API or
published form backend. External credentials/tenant must be verified upstream.
"""
from __future__ import annotations
from hashlib import sha256
import json
import re
import sqlite3
from typing import Any
import uuid

from .builder import SiteSpecDenied,validate_row
from .contracts import canonical,digest
from .drafts import DraftDenied,LocalDraftStore,_identity

_IDEM=re.compile(r"^[a-zA-Z0-9][a-zA-Z0-9-]{7,95}$")

class RecordDenied(DraftDenied):
    pass

class LocalRecordStore:
    """Atomic CRUD with tenant+project+model boundaries and reference indexes."""

    def __init__(self,drafts:LocalDraftStore):
        if type(drafts) is not LocalDraftStore:
            raise RecordDenied("A local revisioned project store is required")
        self.drafts=drafts
        with drafts._db() as db:
            db.executescript("""CREATE TABLE IF NOT EXISTS builder_rows (
                tenant TEXT NOT NULL,project_id TEXT NOT NULL,
                model TEXT NOT NULL,row_id TEXT NOT NULL,
                version INTEGER NOT NULL,content_digest TEXT NOT NULL,
                data_json TEXT NOT NULL,deleted INTEGER NOT NULL DEFAULT 0,
                PRIMARY KEY(tenant,project_id,model,row_id));
            CREATE TABLE IF NOT EXISTS builder_links (
                tenant TEXT NOT NULL,project_id TEXT NOT NULL,
                model TEXT NOT NULL,row_id TEXT NOT NULL,field TEXT NOT NULL,
                target_model TEXT NOT NULL,target_row_id TEXT NOT NULL,
                PRIMARY KEY(tenant,project_id,model,row_id,field));
            CREATE INDEX IF NOT EXISTS builder_links_target
                ON builder_links(tenant,project_id,target_model,target_row_id);
            CREATE TABLE IF NOT EXISTS builder_idempotency (
                tenant TEXT NOT NULL,project_id TEXT NOT NULL,op_key TEXT NOT NULL,
                request_digest TEXT NOT NULL,response_json TEXT NOT NULL,
                PRIMARY KEY(tenant,project_id,op_key));""")

    @staticmethod
    def _model(spec:dict,name:str)->dict:
        if type(name) is not str:
            raise RecordDenied("Model name required")
        for model in spec["models"]:
            if model["name"]==name:return model
        raise RecordDenied("Unknown model in this tenant project")

    @staticmethod
    def _row(db,tenant,project,model,row_id,*,deleted_allowed=False)->tuple[dict,sqlite3.Row]:
        raw=db.execute("""SELECT * FROM builder_rows WHERE tenant=?
            AND project_id=? AND model=? AND row_id=?""",
            (tenant,project,model,row_id)).fetchone()
        if raw is None or (raw["deleted"] and not deleted_allowed):
            raise RecordDenied("Record not found for tenant/project/model")
        try:
            body=json.loads(raw["data_json"])
        except (TypeError,ValueError) as exc:
            raise RecordDenied("Stored record is corrupted") from exc
        if (type(body) is not dict or canonical(body).decode("utf-8")!=raw["data_json"]
                or digest(body)!=raw["content_digest"]):
            raise RecordDenied("Stored record hash mismatch")
        return body,raw

    @staticmethod
    def _key(value:str):
        if type(value) is not str or not _IDEM.fullmatch(value):
            raise RecordDenied("Invalid local mutation idempotency key")

    @staticmethod
    def _rowid(value:str):
        try:
            if type(value) is not str or str(uuid.UUID(value))!=value:
                raise ValueError()
        except ValueError as exc:
            raise RecordDenied("Record ID must be a canonical UUID") from exc

    @staticmethod
    def _refs(db,tenant,project,model,body):
        for field in model["fields"]:
            if field["type"]!="reference":
                continue
            target=body.get(field["name"])
            if target is None:continue
            found=db.execute("""SELECT 1 FROM builder_rows WHERE tenant=?
                AND project_id=? AND model=? AND row_id=? AND deleted=0""",
                (tenant,project,field["references"],target)).fetchone()
            if not found:
                raise RecordDenied("Reference points outside active project records")

    @staticmethod
    def _replace_links(db,tenant,project,model,record_id,definition,body):
        db.execute("""DELETE FROM builder_links WHERE tenant=? AND project_id=?
            AND model=? AND row_id=?""",(tenant,project,model,record_id))
        for field in definition["fields"]:
            target=body.get(field["name"])
            if field["type"]=="reference" and target is not None:
                db.execute("""INSERT INTO builder_links
                    (tenant,project_id,model,row_id,field,target_model,target_row_id)
                    VALUES(?,?,?,?,?,?,?)""",
                    (tenant,project,model,record_id,field["name"],
                     field["references"],target))

    @staticmethod
    def _seen(db,tenant,project,key,req_hash):
        existing=db.execute("""SELECT request_digest,response_json FROM
            builder_idempotency WHERE tenant=? AND project_id=? AND op_key=?""",
            (tenant,project,key)).fetchone()
        if existing is None:return None
        if existing["request_digest"]!=req_hash:
            raise RecordDenied("Idempotency key reused for a different mutation")
        return json.loads(existing["response_json"])

    @staticmethod
    def _remember(db,tenant,project,key,req_hash,result):
        db.execute("""INSERT INTO builder_idempotency
            (tenant,project_id,op_key,request_digest,response_json)
            VALUES(?,?,?,?,?)""",
            (tenant,project,key,req_hash,canonical(result).decode("utf-8")))

    def create(self,*,tenant:str,project_id:str,model:str,data:dict,
               idempotency_key:str)->dict:
        _identity(tenant,project_id)
        self._key(idempotency_key)
        req=digest({"op":"create","tenant":tenant,"project":project_id,
                    "model":model,"data":data})
        with self.drafts._tx() as db:
            repeated=self._seen(db,tenant,project_id,idempotency_key,req)
            if repeated is not None:return repeated
            spec,_=self.drafts._head(db,tenant,project_id)
            definition=self._model(spec,model)
            normalized=validate_row(definition,data)
            self._refs(db,tenant,project_id,definition,normalized)
            row_id=str(uuid.uuid4())
            hash_value=digest(normalized)
            db.execute("""INSERT INTO builder_rows
                (tenant,project_id,model,row_id,version,content_digest,data_json,deleted)
                VALUES(?,?,?,?,1,?,?,0)""",
                (tenant,project_id,model,row_id,hash_value,
                 canonical(normalized).decode("utf-8")))
            self._replace_links(db,tenant,project_id,model,row_id,definition,normalized)
            out={"tenant":tenant,"project_id":project_id,"model":model,
                 "row_id":row_id,"version":1,"sha256":hash_value,
                 "persisted_locally":True,"production_visible":False}
            self._remember(db,tenant,project_id,idempotency_key,req,out)
            return out

    def update(self,*,tenant:str,project_id:str,model:str,row_id:str,
               expected_version:int,changes:dict,idempotency_key:str)->dict:
        _identity(tenant,project_id)
        self._rowid(row_id)
        self._key(idempotency_key)
        if type(expected_version) is not int or expected_version<1:
            raise RecordDenied("Expected positive row revision")
        if type(changes) is not dict or not changes:
            raise RecordDenied("Empty record edit rejected")
        req=digest({"op":"update","tenant":tenant,"project":project_id,
                    "model":model,"row_id":row_id,"expected":expected_version,
                    "changes":changes})
        with self.drafts._tx() as db:
            repeated=self._seen(db,tenant,project_id,idempotency_key,req)
            if repeated is not None:return repeated
            spec,_=self.drafts._head(db,tenant,project_id)
            definition=self._model(spec,model)
            old,row=self._row(db,tenant,project_id,model,row_id)
            if row["version"]!=expected_version:
                raise RecordDenied("Stale row edit")
            updated=validate_row(definition,{**old,**changes})
            self._refs(db,tenant,project_id,definition,updated)
            sha=digest(updated)
            new_version=expected_version+1
            db.execute("""UPDATE builder_rows SET version=?,content_digest=?,
                data_json=? WHERE tenant=? AND project_id=? AND model=?
                AND row_id=? AND version=?""",
                (new_version,sha,canonical(updated).decode("utf-8"),
                 tenant,project_id,model,row_id,expected_version))
            self._replace_links(db,tenant,project_id,model,row_id,definition,updated)
            out={"tenant":tenant,"project_id":project_id,"model":model,"row_id":row_id,
                 "version":new_version,"sha256":sha,
                 "persisted_locally":True,"production_visible":False}
            self._remember(db,tenant,project_id,idempotency_key,req,out)
            return out

    def delete(self,*,tenant:str,project_id:str,model:str,row_id:str,
               expected_version:int,idempotency_key:str)->dict:
        _identity(tenant,project_id)
        self._rowid(row_id)
        self._key(idempotency_key)
        if type(expected_version) is not int or expected_version<1:
            raise RecordDenied("Expected positive row revision")
        req=digest({"op":"delete","tenant":tenant,"project":project_id,
                    "model":model,"row_id":row_id,"expected":expected_version})
        with self.drafts._tx() as db:
            repeated=self._seen(db,tenant,project_id,idempotency_key,req)
            if repeated is not None:return repeated
            spec,_=self.drafts._head(db,tenant,project_id)
            self._model(spec,model)
            _,row=self._row(db,tenant,project_id,model,row_id)
            if row["version"]!=expected_version:
                raise RecordDenied("Stale delete")
            incoming=db.execute("""SELECT 1 FROM builder_links
                WHERE tenant=? AND project_id=? AND target_model=?
                AND target_row_id=? LIMIT 1""",(tenant,project_id,model,row_id)).fetchone()
            if incoming:
                raise RecordDenied("Cannot delete a record referenced by active records")
            db.execute("""UPDATE builder_rows SET deleted=1,version=version+1
                WHERE tenant=? AND project_id=? AND model=? AND row_id=?""",
                (tenant,project_id,model,row_id))
            db.execute("""DELETE FROM builder_links WHERE tenant=? AND project_id=?
                AND model=? AND row_id=?""",(tenant,project_id,model,row_id))
            out={"tenant":tenant,"project_id":project_id,"model":model,"row_id":row_id,
                 "deleted":True,"version":expected_version+1,"production_visible":False}
            self._remember(db,tenant,project_id,idempotency_key,req,out)
            return out

    def fetch(self,*,tenant:str,project_id:str,model:str,row_id:str)->dict:
        _identity(tenant,project_id)
        self._rowid(row_id)
        with self.drafts._db() as db:
            spec,_=self.drafts._head(db,tenant,project_id)
            definition=self._model(spec,model)
            body,row=self._row(db,tenant,project_id,model,row_id)
            validate_row(definition,body)
            return {"row_id":row_id,"version":row["version"],"fields":body,
                    "sha256":row["content_digest"]}

    def list(self,*,tenant:str,project_id:str,model:str,
             limit:int=50,offset:int=0)->list[dict]:
        _identity(tenant,project_id)
        if (type(limit) is not int or not 1<=limit<=100
                or type(offset) is not int or not 0<=offset<=10000):
            raise RecordDenied("Invalid bounded page size/offset")
        with self.drafts._db() as db:
            spec,_=self.drafts._head(db,tenant,project_id)
            definition=self._model(spec,model)
            rows=db.execute("""SELECT * FROM builder_rows
                WHERE tenant=? AND project_id=? AND model=? AND deleted=0
                ORDER BY rowid ASC LIMIT ? OFFSET ?""",
                (tenant,project_id,model,limit,offset)).fetchall()
            result=[]
            for row in rows:
                body,header=self._row(db,tenant,project_id,model,row["row_id"])
                validated=validate_row(definition,body)
                result.append({"row_id":header["row_id"],"version":header["version"],
                               "fields":validated})
            return result

    def preview_data(self,*,tenant:str,project_id:str,
                     max_rows_per_model:int=50)->dict[str,list[dict]]:
        _identity(tenant,project_id)
        if type(max_rows_per_model) is not int or not 1<=max_rows_per_model<=100:
            raise RecordDenied("Invalid preview record cap")
        spec=self.drafts.load(tenant=tenant,project_id=project_id)
        return {m["name"]:[x["fields"] for x in self.list(
            tenant=tenant,project_id=project_id,model=m["name"],limit=max_rows_per_model)]
            for m in spec["models"]}
