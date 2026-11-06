"""TITAN-X22/X23: atomic local app operations and bounded, explicit workflows.

All application authorization checks and write operations use a single SQLite
BEGIN IMMEDIATE transaction. Tenant and actor are trusted server bindings;
never map them from a JSON body or an unauthenticated request. No outbound
HTTP, user-defined code, unattended scheduling or production execution.
"""
from __future__ import annotations

from hashlib import sha256
import json
import sqlite3
from typing import Any
import uuid

from .app_policy import LocalAppPolicy,AppAccessDenied
from .builder import validate_site_spec,validate_row,render_site
from .contracts import canonical,digest
from .drafts import LocalDraftStore,_identity,DraftDenied
from .records import LocalRecordStore,RecordDenied
from .automatic import apply_record_event

RULE_SCHEMA="osgard.original180.app-workflow/1"
TRIGGERS=frozenset(("manual","record.created","record.updated"))
MAX_WORKFLOWS=20
MAX_WORKFLOW_EVENTS=10000

class AppOperationDenied(AppAccessDenied):
    pass

def _uuid(value:Any)->str:
    try:
        if type(value) is not str or str(uuid.UUID(value))!=value:
            raise ValueError()
    except ValueError as exc:
        raise AppOperationDenied("Expected canonical UUID") from exc
    return value

class LocalAppRuntime:
    """Interactive local app controller; caller must be authenticated externally."""

    def __init__(self,database:str):
        self.drafts=LocalDraftStore(database)
        self.records=LocalRecordStore(self.drafts)
        self.policy=LocalAppPolicy(self.drafts)
        with self.drafts._db() as db:
            db.executescript("""CREATE TABLE IF NOT EXISTS app_workflows(
                tenant TEXT NOT NULL,project_id TEXT NOT NULL,workflow_id TEXT NOT NULL,
                spec_json TEXT NOT NULL,spec_digest TEXT NOT NULL,enabled INTEGER NOT NULL
                CHECK(enabled IN (0,1)),revision INTEGER NOT NULL,
                PRIMARY KEY(tenant,project_id,workflow_id));
            CREATE TABLE IF NOT EXISTS app_workflow_runs(
                tenant TEXT NOT NULL,project_id TEXT NOT NULL,workflow_id TEXT NOT NULL,
                event_id TEXT NOT NULL,run_digest TEXT NOT NULL,response_json TEXT NOT NULL,
                PRIMARY KEY(tenant,project_id,workflow_id,event_id));""")

    def _guard(self,db,tenant,project,actor,cap):
        return self.policy.require(db,tenant=tenant,project_id=project,
                                   actor=actor,capability=cap)

    def get_spec(self,*,tenant:str,project_id:str,actor:str)->dict:
        with self.drafts._db() as db:
            self._guard(db,tenant,project_id,actor,"spec.read")
            data,header=self.drafts._head(db,tenant,project_id)
            return {"spec":data,"revision":header["revision"],
                    "sha256":header["content_digest"]}

    def edit_page(self,*,tenant:str,project_id:str,actor:str,slug:str,
                  expected_revision:int,title:str|None=None,
                  section_index:int|None=None,changes:dict|None=None)->dict:
        """Server-authorized no-AI page edit; atomic with revision CAS."""
        if type(expected_revision) is not int or expected_revision<1:
            raise AppOperationDenied("Expected positive project version")
        if type(slug) is not str or (title is None and changes is None):
            raise AppOperationDenied("Invalid or empty page edit")
        with self.drafts._tx() as db:
            self._guard(db,tenant,project_id,actor,"spec.write")
            source,header=self.drafts._head(db,tenant,project_id)
            if header["revision"]!=expected_revision:
                raise AppOperationDenied("Stale project revision")
            pages=[p for p in source["pages"] if p["slug"]==slug]
            if len(pages)!=1:
                raise AppOperationDenied("Unknown project page")
            page=pages[0]
            if title is not None:page["title"]=title
            if changes is not None:
                if (type(section_index) is not int or section_index<0
                    or section_index>=len(page["sections"]) or type(changes) is not dict
                    or not changes or "type" in changes):
                    raise AppOperationDenied("Invalid section patch")
                section=page["sections"][section_index]
                if not set(changes)<=set(section):
                    raise AppOperationDenied("Unsupported section keys")
                section.update(changes)
            verified=validate_site_spec(source)
            canonical_json=canonical(verified).decode("utf-8")
            h=digest(verified)
            if h==header["content_digest"]:
                return {"revision":expected_revision,"changed":False,"sha256":h,
                        "production_published":False}
            version=expected_revision+1
            count=db.execute("""UPDATE draft_projects SET revision=?,content_digest=?,
                content_json=? WHERE tenant=? AND project_id=? AND revision=?""",
                (version,h,canonical_json,tenant,project_id,expected_revision)).rowcount
            if count!=1:
                raise AppOperationDenied("Concurrent project edit failed")
            db.execute("""INSERT INTO draft_revisions
                (tenant,project_id,revision,content_digest,content_json)
                VALUES(?,?,?,?,?)""",(tenant,project_id,version,h,canonical_json))
            return {"revision":version,"changed":True,"sha256":h,
                    "production_published":False}

    def list_rows(self,*,tenant:str,project_id:str,actor:str,model:str,
                  limit:int=50,offset:int=0)->list[dict]:
        if (type(limit) is not int or not 1<=limit<=100
            or type(offset) is not int or not 0<=offset<=10000):
            raise AppOperationDenied("Invalid page size or offset")
        with self.drafts._db() as db:
            self._guard(db,tenant,project_id,actor,"record.read")
            spec,_=self.drafts._head(db,tenant,project_id)
            definition=self.records._model(spec,model)
            rows=db.execute("""SELECT * FROM builder_rows WHERE tenant=?
                AND project_id=? AND model=? AND deleted=0 ORDER BY rowid
                LIMIT ? OFFSET ?""",(tenant,project_id,model,limit,offset)).fetchall()
            output=[]
            for row in rows:
                fields,_=self.records._row(db,tenant,project_id,model,row["row_id"])
                validated=validate_row(definition,fields)
                output.append({"row_id":row["row_id"],"version":row["version"],
                               "fields":validated,"sha256":row["content_digest"]})
            return output

    def create_row(self,*,tenant:str,project_id:str,actor:str,model:str,
                   data:dict,idempotency_key:str)->dict:
        self.records._key(idempotency_key)
        with self.drafts._tx() as db:
            self._guard(db,tenant,project_id,actor,"record.write")
            req=digest({"op":"create","tenant":tenant,"project":project_id,
                        "model":model,"data":data})
            repeated=self.records._seen(db,tenant,project_id,idempotency_key,req)
            if repeated is not None:return repeated
            spec,_=self.drafts._head(db,tenant,project_id)
            definition=self.records._model(spec,model)
            normalized=validate_row(definition,data)
            self.records._refs(db,tenant,project_id,definition,normalized)
            rid=str(uuid.uuid4())
            h=digest(normalized)
            db.execute("""INSERT INTO builder_rows
                (tenant,project_id,model,row_id,version,content_digest,data_json,deleted)
                VALUES(?,?,?,?,1,?,?,0)""",
                (tenant,project_id,model,rid,h,canonical(normalized).decode("utf-8")))
            self.records._replace_links(db,tenant,project_id,model,rid,definition,normalized)
            auto=apply_record_event(self,db,tenant=tenant,project_id=project_id,
                model=model,row_id=rid,trigger="record.created",
                mutation_key=idempotency_key)
            final,row=self.records._row(db,tenant,project_id,model,rid)
            receipt={"row_id":rid,"version":row["version"],
                "sha256":row["content_digest"],"automatic_workflows":auto,
                "production_visible":False}
            self.records._remember(db,tenant,project_id,idempotency_key,req,receipt)
            return receipt

    def update_row(self,*,tenant:str,project_id:str,actor:str,model:str,
                   row_id:str,expected_version:int,changes:dict,
                   idempotency_key:str)->dict:
        self.records._rowid(row_id)
        self.records._key(idempotency_key)
        if (type(expected_version) is not int or expected_version<1
            or type(changes) is not dict or not changes):
            raise AppOperationDenied("Invalid row update")
        req=digest({"op":"update","tenant":tenant,"project":project_id,
                    "model":model,"row_id":row_id,"expected":expected_version,
                    "changes":changes})
        with self.drafts._tx() as db:
            self._guard(db,tenant,project_id,actor,"record.write")
            repeated=self.records._seen(db,tenant,project_id,idempotency_key,req)
            if repeated is not None:return repeated
            spec,_=self.drafts._head(db,tenant,project_id)
            definition=self.records._model(spec,model)
            old,header=self.records._row(db,tenant,project_id,model,row_id)
            if header["version"]!=expected_version:
                raise AppOperationDenied("Stale record version")
            data=validate_row(definition,{**old,**changes})
            self.records._refs(db,tenant,project_id,definition,data)
            h=digest(data)
            version=expected_version+1
            count=db.execute("""UPDATE builder_rows SET version=?,
                content_digest=?,data_json=? WHERE tenant=? AND project_id=? AND
                model=? AND row_id=? AND version=? AND deleted=0""",
                (version,h,canonical(data).decode("utf-8"),tenant,project_id,
                 model,row_id,expected_version)).rowcount
            if count!=1:
                raise AppOperationDenied("Concurrent row edit failed")
            self.records._replace_links(db,tenant,project_id,model,row_id,definition,data)
            auto=apply_record_event(self,db,tenant=tenant,project_id=project_id,
                model=model,row_id=row_id,trigger="record.updated",
                mutation_key=idempotency_key)
            final,row=self.records._row(db,tenant,project_id,model,row_id)
            receipt={"row_id":row_id,"version":row["version"],
                     "sha256":row["content_digest"],"automatic_workflows":auto,
                     "production_visible":False}
            self.records._remember(db,tenant,project_id,idempotency_key,req,receipt)
            return receipt

    def delete_row(self,*,tenant:str,project_id:str,actor:str,model:str,
                   row_id:str,expected_version:int,idempotency_key:str)->dict:
        self.records._rowid(row_id)
        self.records._key(idempotency_key)
        if type(expected_version) is not int or expected_version<1:
            raise AppOperationDenied("Invalid row version")
        req=digest({"op":"delete","tenant":tenant,"project":project_id,
                    "model":model,"row_id":row_id,"expected":expected_version})
        with self.drafts._tx() as db:
            self._guard(db,tenant,project_id,actor,"record.write")
            repeated=self.records._seen(db,tenant,project_id,idempotency_key,req)
            if repeated is not None:return repeated
            spec,_=self.drafts._head(db,tenant,project_id)
            self.records._model(spec,model)
            _,row=self.records._row(db,tenant,project_id,model,row_id)
            if row["version"]!=expected_version:
                raise AppOperationDenied("Stale row deletion version")
            linked=db.execute("""SELECT 1 FROM builder_links WHERE tenant=?
                AND project_id=? AND target_model=? AND target_row_id=? LIMIT 1""",
                (tenant,project_id,model,row_id)).fetchone()
            if linked:
                raise AppOperationDenied("Cannot delete referenced row")
            version=expected_version+1
            count=db.execute("""UPDATE builder_rows SET version=?,deleted=1
                WHERE tenant=? AND project_id=? AND model=? AND row_id=? AND
                version=? AND deleted=0""",
                (version,tenant,project_id,model,row_id,expected_version)).rowcount
            if count!=1:
                raise AppOperationDenied("Concurrent row deletion failed")
            db.execute("""DELETE FROM builder_links WHERE tenant=? AND project_id=?
                AND model=? AND row_id=?""",(tenant,project_id,model,row_id))
            receipt={"row_id":row_id,"version":version,"deleted":True,
                     "production_visible":False}
            self.records._remember(db,tenant,project_id,idempotency_key,req,receipt)
            return receipt

    @staticmethod
    def _rule(spec:dict,rule:Any)->dict:
        if type(rule) is not dict or set(rule)!={"schema","name","model","trigger",
                                                 "condition","action"}:
            raise AppOperationDenied("Invalid workflow schema keys")
        if rule["schema"]!=RULE_SCHEMA or rule["trigger"] not in TRIGGERS:
            raise AppOperationDenied("Unknown workflow trigger/schema")
        if (type(rule["name"]) is not str or not 1<=len(rule["name"])<=64
            or any(ord(c)<32 for c in rule["name"])):
            raise AppOperationDenied("Invalid workflow label")
        models={m["name"]:m for m in spec["models"]}
        if rule["model"] not in models:
            raise AppOperationDenied("Workflow model not in project")
        fields={f["name"]:f for f in models[rule["model"]]["fields"]}
        condition=rule["condition"]
        if condition is not None:
            if (type(condition) is not dict or set(condition)!={"field","equals"}
                or condition["field"] not in fields):
                raise AppOperationDenied("Condition references unsupported field")
            validate_row({"fields":[{**fields[condition["field"]],"required":False}]},
                         {condition["field"]:condition["equals"]},partial=True)
        action=rule["action"]
        if type(action) is not dict or action.get("type")!="set_field" or set(action)!={
            "type","field","value"} or action.get("field") not in fields:
            raise AppOperationDenied("Only deterministic same-row set_field is allowed")
        if fields[action["field"]]["type"]=="reference":
            raise AppOperationDenied("Workflow cannot change relation edges")
        validate_row({"fields":[{**fields[action["field"]],"required":False}]},
                     {action["field"]:action["value"]},partial=True)
        return json.loads(canonical(rule))

    def add_workflow(self,*,tenant:str,project_id:str,actor:str,rule:dict)->dict:
        with self.drafts._tx() as db:
            self._guard(db,tenant,project_id,actor,"workflow.manage")
            spec,_=self.drafts._head(db,tenant,project_id)
            checked=self._rule(spec,rule)
            total=db.execute("""SELECT COUNT(*) FROM app_workflows WHERE tenant=?
                AND project_id=?""",(tenant,project_id)).fetchone()[0]
            if total>=MAX_WORKFLOWS:
                raise AppOperationDenied("Too many workflows in project")
            workflow_id=str(uuid.uuid4())
            h=digest(checked)
            db.execute("""INSERT INTO app_workflows
                (tenant,project_id,workflow_id,spec_json,spec_digest,enabled,revision)
                VALUES(?,?,?,?,?,1,1)""",(tenant,project_id,workflow_id,
                canonical(checked).decode("utf-8"),h))
            return {"workflow_id":workflow_id,"revision":1,"sha256":h,
                    "enabled":True,"external_actions_permitted":False}

    def list_workflows(self,*,tenant:str,project_id:str,actor:str)->list[dict]:
        with self.drafts._db() as db:
            self._guard(db,tenant,project_id,actor,"workflow.read")
            rows=db.execute("""SELECT * FROM app_workflows WHERE tenant=?
                AND project_id=? ORDER BY rowid""",(tenant,project_id)).fetchall()
            return [self._read_rule(r) for r in rows]

    @classmethod
    def _read_rule(cls,row:sqlite3.Row)->dict:
        try:
            value=json.loads(row["spec_json"])
        except (ValueError,TypeError) as exc:
            raise AppOperationDenied("Stored workflow invalid") from exc
        if type(value) is not dict or canonical(value).decode("utf-8")!=row["spec_json"]:
            raise AppOperationDenied("Noncanonical stored workflow")
        if digest(value)!=row["spec_digest"]:
            raise AppOperationDenied("Stored workflow altered without checksum update")
        return {"workflow_id":row["workflow_id"],"revision":row["revision"],
                "enabled":bool(row["enabled"]),"rule":value,
                "sha256":row["spec_digest"]}

    def disable_workflow(self,*,tenant:str,project_id:str,actor:str,
                         workflow_id:str,expected_revision:int)->dict:
        _uuid(workflow_id)
        if type(expected_revision) is not int or expected_revision<1:
            raise AppOperationDenied("Expected workflow revision")
        with self.drafts._tx() as db:
            self._guard(db,tenant,project_id,actor,"workflow.manage")
            row=db.execute("""SELECT * FROM app_workflows WHERE tenant=?
                AND project_id=? AND workflow_id=?""",
                (tenant,project_id,workflow_id)).fetchone()
            if row is None or row["revision"]!=expected_revision or not row["enabled"]:
                raise AppOperationDenied("Inactive or stale workflow")
            self._read_rule(row)
            db.execute("""UPDATE app_workflows SET enabled=0,revision=revision+1
                WHERE tenant=? AND project_id=? AND workflow_id=?""",
                (tenant,project_id,workflow_id))
            return {"workflow_id":workflow_id,"revision":expected_revision+1,
                    "enabled":False}

    def run_workflow(self,*,tenant:str,project_id:str,actor:str,workflow_id:str,
                     event_id:str,trigger:str,row_id:str)->dict:
        """Explicit, idempotent local workflow; never schedules or calls network."""
        _uuid(workflow_id)
        _uuid(event_id)
        _uuid(row_id)
        if trigger!="manual":
            raise AppOperationDenied("Automatic record events cannot be forged by API callers")
        with self.drafts._tx() as db:
            self._guard(db,tenant,project_id,actor,"workflow.run")
            found=db.execute("""SELECT * FROM app_workflows WHERE tenant=?
                AND project_id=? AND workflow_id=?""",
                (tenant,project_id,workflow_id)).fetchone()
            if found is None or not found["enabled"]:
                raise AppOperationDenied("Workflow disabled or not found")
            rule=self._read_rule(found)["rule"]
            if rule["trigger"]!=trigger:
                raise AppOperationDenied("Workflow trigger mismatch")
            spec,_=self.drafts._head(db,tenant,project_id)
            self._rule(spec,rule)
            event_hash=digest({"workflow_id":workflow_id,"event_id":event_id,
                               "trigger":trigger,"row_id":row_id})
            old=db.execute("""SELECT run_digest,response_json FROM app_workflow_runs
                WHERE tenant=? AND project_id=? AND workflow_id=? AND event_id=?""",
                (tenant,project_id,workflow_id,event_id)).fetchone()
            if old:
                if old["run_digest"]!=event_hash:
                    raise AppOperationDenied("Workflow event idempotency collision")
                return json.loads(old["response_json"])
            count=db.execute("""SELECT COUNT(*) FROM app_workflow_runs WHERE tenant=?
                AND project_id=?""",(tenant,project_id)).fetchone()[0]
            if count>=MAX_WORKFLOW_EVENTS:
                raise AppOperationDenied("Workflow run retention quota reached")
            model=rule["model"]
            definition=self.records._model(spec,model)
            data,row=self.records._row(db,tenant,project_id,model,row_id)
            fields=validate_row(definition,data)
            cond=rule["condition"]
            matched=cond is None or fields.get(cond["field"])==cond["equals"]
            changed=False
            new_version=row["version"]
            if matched:
                name=rule["action"]["field"]
                literal=rule["action"]["value"]
                proposed=validate_row(definition,{**fields,name:literal})
                if proposed!=fields:
                    self.records._refs(db,tenant,project_id,definition,proposed)
                    new_version+=1
                    updated=db.execute("""UPDATE builder_rows SET version=?,
                        content_digest=?,data_json=? WHERE tenant=? AND project_id=?
                        AND model=? AND row_id=? AND version=? AND deleted=0""",
                        (new_version,digest(proposed),canonical(proposed).decode("utf-8"),
                         tenant,project_id,model,row_id,row["version"])).rowcount
                    if updated!=1:
                        raise AppOperationDenied("Workflow row revision changed")
                    self.records._replace_links(db,tenant,project_id,model,row_id,
                                                definition,proposed)
                    changed=True
            result={"workflow_id":workflow_id,"event_id":event_id,"matched":matched,
                    "changed":changed,"row_version":new_version,"network_calls":0,
                    "production_executed":False}
            db.execute("""INSERT INTO app_workflow_runs
                (tenant,project_id,workflow_id,event_id,run_digest,response_json)
                VALUES(?,?,?,?,?,?)""",
                (tenant,project_id,workflow_id,event_id,event_hash,
                 canonical(result).decode("utf-8")))
            return result

    def render_preview(self,*,tenant:str,project_id:str,actor:str)->dict[str,bytes]:
        """Tenant-authorized snapshot of local static pages (max 50 rows/model)."""
        with self.drafts._tx() as db:
            self._guard(db,tenant,project_id,actor,"preview.read")
            spec,_=self.drafts._head(db,tenant,project_id)
            dataset={}
            for model in spec["models"]:
                rows=db.execute("""SELECT * FROM builder_rows WHERE tenant=?
                    AND project_id=? AND model=? AND deleted=0 ORDER BY rowid LIMIT 50""",
                    (tenant,project_id,model["name"])).fetchall()
                dataset[model["name"]]=[]
                for row in rows:
                    data,_=self.records._row(db,tenant,project_id,model["name"],
                                             row["row_id"])
                    dataset[model["name"]].append(validate_row(model,data))
            return render_site(spec,datasets=dataset)
