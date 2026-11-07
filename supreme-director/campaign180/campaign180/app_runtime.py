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
from .structure import mutate_structure
from .forms import edit_form
from .form_submissions import submit_form
from .record_bulk import query_rows, export_csv, inspect_import, apply_import
from .record_batches import (
    init_journal, inspect_batch_update, apply_batch_update,
    list_batch_history, inspect_batch_restore, apply_batch_restore,
)
from .team_tasks import (
    init_tasks, list_members as task_members, create_task as create_team_task,
    update_task as update_team_task, query_tasks as query_team_tasks,
    task_summary as team_task_summary, task_history as team_task_history,
)
from .task_collaboration import (
    init_collaboration,add_comment,list_comments,add_checklist_item,
    list_checklist,set_checklist_done,team_workload,
)
from .task_planning import (
    init_planning,mutate_dependency,list_dependencies,calendar_agenda,
    dependency_events,
)
from .delivery_plan import (
    init_delivery,create_phase,revise_phase_forecast,create_milestone,
    change_milestone,delivery_report,delivery_history,
)
from .resource_forecast import (
    init_forecast,set_effort,set_capacity,project_forecast,forecast_history,
)
from .resource_scenarios import workload_report,compare_reassignment
from .scenario_library import (
    init_scenario_library,save_variant,list_variants,select_variant,
    apply_variant,decision_history,
)
from .scenario_outcomes import (
    init_outcomes,outcome_detail,rollback_application,
)

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
        init_journal(self)
        init_tasks(self)
        init_collaboration(self)
        init_planning(self)
        init_delivery(self)
        init_forecast(self)
        init_scenario_library(self)
        init_outcomes(self)

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

    def edit_structure(self,*,tenant:str,project_id:str,actor:str,slug:str,
                       expected_revision:int,operation:str,index:int,
                       section:dict|None=None,target_index:int|None=None)->dict:
        return mutate_structure(self,tenant=tenant,project_id=project_id,actor=actor,
                                slug=slug,expected_revision=expected_revision,
                                operation=operation,index=index,section=section,
                                target_index=target_index)

    def edit_form(self,*,tenant:str,project_id:str,actor:str,slug:str,
                  expected_revision:int,section_index:int,model:str,
                  heading:str,button_label:str,fields:list[str])->dict:
        return edit_form(self,tenant=tenant,project_id=project_id,actor=actor,
                         slug=slug,expected_revision=expected_revision,
                         section_index=section_index,model=model,heading=heading,
                         button_label=button_label,fields=fields)

    def submit_form(self,*,tenant:str,project_id:str,actor:str,slug:str,
                    section_index:int,expected_revision:int,data:dict,
                    idempotency_key:str)->dict:
        return submit_form(self,tenant=tenant,project_id=project_id,
                           actor=actor,slug=slug,section_index=section_index,
                           expected_revision=expected_revision,data=data,
                           idempotency_key=idempotency_key)

    def query_rows(self,*,tenant:str,project_id:str,actor:str,model:str,
                   limit:int=25,offset:int=0,search:str="",field:str|None=None)->dict:
        return query_rows(self,tenant=tenant,project_id=project_id,actor=actor,
                          model=model,limit=limit,offset=offset,
                          search=search,field=field)

    def export_csv(self,*,tenant:str,project_id:str,actor:str,model:str,
                   limit:int=100,search:str="",field:str|None=None)->dict:
        return export_csv(self,tenant=tenant,project_id=project_id,actor=actor,
                          model=model,limit=limit,search=search,field=field)

    def inspect_csv_import(self,*,tenant:str,project_id:str,actor:str,
                           model:str,expected_revision:int,csv_text:str)->dict:
        return inspect_import(self,tenant=tenant,project_id=project_id,
                              actor=actor,model=model,
                              expected_revision=expected_revision,csv_text=csv_text)

    def apply_csv_import(self,*,tenant:str,project_id:str,actor:str,
                         model:str,expected_revision:int,csv_text:str,
                         expected_plan_sha256:str,idempotency_key:str)->dict:
        return apply_import(self,tenant=tenant,project_id=project_id,
                            actor=actor,model=model,expected_revision=expected_revision,
                            csv_text=csv_text,expected_plan_sha256=expected_plan_sha256,
                            idempotency_key=idempotency_key)

    def inspect_batch_update(self,*,tenant:str,project_id:str,actor:str,
                             model:str,expected_revision:int,patches:list[dict])->dict:
        return inspect_batch_update(self,tenant=tenant,project_id=project_id,
                                    actor=actor,model=model,
                                    expected_revision=expected_revision,patches=patches)

    def apply_batch_update(self,*,tenant:str,project_id:str,actor:str,
                           model:str,expected_revision:int,patches:list[dict],
                           expected_plan_sha256:str,idempotency_key:str)->dict:
        return apply_batch_update(self,tenant=tenant,project_id=project_id,
                                  actor=actor,model=model,
                                  expected_revision=expected_revision,patches=patches,
                                  expected_plan_sha256=expected_plan_sha256,
                                  idempotency_key=idempotency_key)

    def list_batch_history(self,*,tenant:str,project_id:str,actor:str,
                           model:str,limit:int=20)->dict:
        return list_batch_history(self,tenant=tenant,project_id=project_id,
                                  actor=actor,model=model,limit=limit)

    def inspect_batch_restore(self,*,tenant:str,project_id:str,actor:str,
                              model:str,batch_id:str,expected_revision:int)->dict:
        return inspect_batch_restore(self,tenant=tenant,project_id=project_id,
                                     actor=actor,model=model,batch_id=batch_id,
                                     expected_revision=expected_revision)

    def apply_batch_restore(self,*,tenant:str,project_id:str,actor:str,
                            model:str,batch_id:str,expected_revision:int,
                            expected_plan_sha256:str,idempotency_key:str)->dict:
        return apply_batch_restore(self,tenant=tenant,project_id=project_id,
                                   actor=actor,model=model,batch_id=batch_id,
                                   expected_revision=expected_revision,
                                   expected_plan_sha256=expected_plan_sha256,
                                   idempotency_key=idempotency_key)

    def task_members(self,*,tenant:str,project_id:str,actor:str)->dict:
        return task_members(self,tenant=tenant,project_id=project_id,actor=actor)

    def create_team_task(self,*,tenant:str,project_id:str,actor:str,
                         title:str,idempotency_key:str,description:str="",
                         assignee:str|None=None,due_date:str|None=None,
                         priority:str="normal")->dict:
        return create_team_task(self,tenant=tenant,project_id=project_id,
                                actor=actor,title=title,
                                idempotency_key=idempotency_key,
                                description=description,assignee=assignee,
                                due_date=due_date,priority=priority)

    def update_team_task(self,*,tenant:str,project_id:str,actor:str,
                         task_id:str,expected_version:int,changes:dict,
                         idempotency_key:str)->dict:
        return update_team_task(self,tenant=tenant,project_id=project_id,
                                actor=actor,task_id=task_id,
                                expected_version=expected_version,
                                changes=changes,idempotency_key=idempotency_key)

    def query_team_tasks(self,*,tenant:str,project_id:str,actor:str,
                         limit:int=25,offset:int=0,status:str|None=None,
                         assignee:str|None=None,due:str|None=None)->dict:
        return query_team_tasks(self,tenant=tenant,project_id=project_id,
                                actor=actor,limit=limit,offset=offset,status=status,
                                assignee=assignee,due=due)

    def team_task_summary(self,*,tenant:str,project_id:str,actor:str)->dict:
        return team_task_summary(self,tenant=tenant,project_id=project_id,actor=actor)

    def team_task_history(self,*,tenant:str,project_id:str,actor:str,
                          task_id:str,limit:int=25)->dict:
        return team_task_history(self,tenant=tenant,project_id=project_id,
                                 actor=actor,task_id=task_id,limit=limit)

    def add_task_comment(self,*,tenant:str,project_id:str,actor:str,
                         task_id:str,body:str,idempotency_key:str)->dict:
        return add_comment(self,tenant=tenant,project_id=project_id,actor=actor,
                           task_id=task_id,body=body,idempotency_key=idempotency_key)

    def list_task_comments(self,*,tenant:str,project_id:str,actor:str,
                           task_id:str,limit:int=25,offset:int=0)->dict:
        return list_comments(self,tenant=tenant,project_id=project_id,
                             actor=actor,task_id=task_id,limit=limit,offset=offset)

    def add_task_checklist_item(self,*,tenant:str,project_id:str,actor:str,
                                task_id:str,label:str,idempotency_key:str)->dict:
        return add_checklist_item(self,tenant=tenant,project_id=project_id,
                                  actor=actor,task_id=task_id,label=label,
                                  idempotency_key=idempotency_key)

    def list_task_checklist(self,*,tenant:str,project_id:str,actor:str,
                            task_id:str)->dict:
        return list_checklist(self,tenant=tenant,project_id=project_id,
                              actor=actor,task_id=task_id)

    def set_task_checklist_done(self,*,tenant:str,project_id:str,actor:str,
                                task_id:str,item_id:str,expected_version:int,
                                done:bool,idempotency_key:str)->dict:
        return set_checklist_done(self,tenant=tenant,project_id=project_id,
                                  actor=actor,task_id=task_id,item_id=item_id,
                                  expected_version=expected_version,done=done,
                                  idempotency_key=idempotency_key)

    def team_workload(self,*,tenant:str,project_id:str,actor:str)->dict:
        return team_workload(self,tenant=tenant,project_id=project_id,actor=actor)

    def add_task_dependency(self,*,tenant:str,project_id:str,actor:str,
                            task_id:str,prerequisite_id:str,
                            expected_version:int,idempotency_key:str)->dict:
        return mutate_dependency(self,tenant=tenant,project_id=project_id,
                                 actor=actor,task_id=task_id,
                                 prerequisite_id=prerequisite_id,
                                 expected_version=expected_version,
                                 idempotency_key=idempotency_key,action="add")

    def remove_task_dependency(self,*,tenant:str,project_id:str,actor:str,
                               task_id:str,prerequisite_id:str,
                               expected_version:int,idempotency_key:str)->dict:
        return mutate_dependency(self,tenant=tenant,project_id=project_id,
                                 actor=actor,task_id=task_id,
                                 prerequisite_id=prerequisite_id,
                                 expected_version=expected_version,
                                 idempotency_key=idempotency_key,action="remove")

    def list_task_dependencies(self,*,tenant:str,project_id:str,actor:str,
                               task_id:str)->dict:
        return list_dependencies(self,tenant=tenant,project_id=project_id,
                                 actor=actor,task_id=task_id)

    def task_calendar(self,*,tenant:str,project_id:str,actor:str,
                      start_date:str|None=None,days:int=30,
                      include_overdue:bool=True)->dict:
        return calendar_agenda(self,tenant=tenant,project_id=project_id,
                               actor=actor,start_date=start_date,days=days,
                               include_overdue=include_overdue)

    def task_dependency_events(self,*,tenant:str,project_id:str,actor:str,
                               task_id:str,limit:int=30)->dict:
        return dependency_events(self,tenant=tenant,project_id=project_id,
                                 actor=actor,task_id=task_id,limit=limit)

    def create_delivery_phase(self,*,tenant:str,project_id:str,actor:str,
                              name:str,baseline_start:str,baseline_end:str,
                              idempotency_key:str)->dict:
        return create_phase(self,tenant=tenant,project_id=project_id,
                            actor=actor,name=name,baseline_start=baseline_start,
                            baseline_end=baseline_end,idempotency_key=idempotency_key)

    def revise_delivery_phase(self,*,tenant:str,project_id:str,actor:str,
                              phase_id:str,expected_version:int,
                              forecast_end:str,idempotency_key:str)->dict:
        return revise_phase_forecast(self,tenant=tenant,project_id=project_id,
                                     actor=actor,phase_id=phase_id,
                                     expected_version=expected_version,
                                     forecast_end=forecast_end,
                                     idempotency_key=idempotency_key)

    def create_delivery_milestone(self,*,tenant:str,project_id:str,actor:str,
                                  phase_id:str,name:str,baseline_due:str,
                                  idempotency_key:str,
                                  linked_task_id:str|None=None)->dict:
        return create_milestone(self,tenant=tenant,project_id=project_id,
                                actor=actor,phase_id=phase_id,name=name,
                                baseline_due=baseline_due,
                                idempotency_key=idempotency_key,
                                linked_task_id=linked_task_id)

    def change_delivery_milestone(self,*,tenant:str,project_id:str,actor:str,
                                  milestone_id:str,expected_version:int,
                                  operation:str,value:str,
                                  idempotency_key:str)->dict:
        return change_milestone(self,tenant=tenant,project_id=project_id,
                                actor=actor,milestone_id=milestone_id,
                                expected_version=expected_version,
                                operation=operation,value=value,
                                idempotency_key=idempotency_key)

    def delivery_schedule(self,*,tenant:str,project_id:str,actor:str)->dict:
        return delivery_report(self,tenant=tenant,project_id=project_id,actor=actor)

    def delivery_event_history(self,*,tenant:str,project_id:str,actor:str,
                               entity_id:str,limit:int=30)->dict:
        return delivery_history(self,tenant=tenant,project_id=project_id,
                                actor=actor,entity_id=entity_id,limit=limit)

    def set_forecast_effort(self,*,tenant:str,project_id:str,actor:str,
                            task_id:str,effort_hours:int,expected_version:int,
                            idempotency_key:str)->dict:
        return set_effort(self,tenant=tenant,project_id=project_id,actor=actor,
                          task_id=task_id,effort_hours=effort_hours,
                          expected_version=expected_version,
                          idempotency_key=idempotency_key)

    def set_forecast_capacity(self,*,tenant:str,project_id:str,actor:str,
                              worker:str,hours_per_day:int,expected_version:int,
                              idempotency_key:str)->dict:
        return set_capacity(self,tenant=tenant,project_id=project_id,actor=actor,
                            worker=worker,hours_per_day=hours_per_day,
                            expected_version=expected_version,
                            idempotency_key=idempotency_key)

    def project_resource_forecast(self,*,tenant:str,project_id:str,
                                  actor:str)->dict:
        return project_forecast(self,tenant=tenant,project_id=project_id,
                                actor=actor)

    def project_forecast_history(self,*,tenant:str,project_id:str,
                                 actor:str,limit:int=30)->dict:
        return forecast_history(self,tenant=tenant,project_id=project_id,
                                actor=actor,limit=limit)

    def resource_workload(self,*,tenant:str,project_id:str,actor:str)->dict:
        return workload_report(self,tenant=tenant,project_id=project_id,
                               actor=actor)

    def compare_resource_scenario(self,*,tenant:str,project_id:str,actor:str,
                                  expected_snapshot:str,moves:list[dict])->dict:
        return compare_reassignment(self,tenant=tenant,project_id=project_id,
                                    actor=actor,expected_snapshot=expected_snapshot,
                                    moves=moves)

    def save_resource_variant(self,*,tenant:str,project_id:str,actor:str,
                              title:str,expected_snapshot:str,moves:list[dict],
                              idempotency_key:str)->dict:
        return save_variant(self,tenant=tenant,project_id=project_id,
                            actor=actor,title=title,expected_snapshot=expected_snapshot,
                            moves=moves,idempotency_key=idempotency_key)

    def list_resource_variants(self,*,tenant:str,project_id:str,actor:str)->dict:
        return list_variants(self,tenant=tenant,project_id=project_id,actor=actor)

    def select_resource_variant(self,*,tenant:str,project_id:str,actor:str,
                                scenario_id:str,expected_version:int,
                                expected_snapshot:str,idempotency_key:str)->dict:
        return select_variant(self,tenant=tenant,project_id=project_id,
                              actor=actor,scenario_id=scenario_id,
                              expected_version=expected_version,
                              expected_snapshot=expected_snapshot,
                              idempotency_key=idempotency_key)

    def apply_resource_variant(self,*,tenant:str,project_id:str,actor:str,
                               scenario_id:str,expected_version:int,
                               expected_snapshot:str,confirmation:str,
                               idempotency_key:str)->dict:
        return apply_variant(self,tenant=tenant,project_id=project_id,
                             actor=actor,scenario_id=scenario_id,
                             expected_version=expected_version,
                             expected_snapshot=expected_snapshot,
                             confirmation=confirmation,
                             idempotency_key=idempotency_key)

    def resource_variant_history(self,*,tenant:str,project_id:str,actor:str,
                                 scenario_id:str,limit:int=30)->dict:
        return decision_history(self,tenant=tenant,project_id=project_id,
                                actor=actor,scenario_id=scenario_id,limit=limit)

    def scenario_outcome(self,*,tenant:str,project_id:str,actor:str,
                         scenario_id:str)->dict:
        return outcome_detail(self,tenant=tenant,project_id=project_id,
                              actor=actor,scenario_id=scenario_id)

    def rollback_resource_variant(self,*,tenant:str,project_id:str,actor:str,
                                  scenario_id:str,expected_version:int,
                                  expected_snapshot:str,confirmation:str,
                                  idempotency_key:str)->dict:
        return rollback_application(
            self,tenant=tenant,project_id=project_id,actor=actor,
            scenario_id=scenario_id,expected_version=expected_version,
            expected_snapshot=expected_snapshot,confirmation=confirmation,
            idempotency_key=idempotency_key)

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

    def reference_choices(self,*,tenant:str,project_id:str,actor:str,
                          model:str)->dict:
        """List at most 100 tenant-authorized row labels, not arbitrary raw fields."""
        with self.drafts._db() as db:
            self._guard(db,tenant,project_id,actor,"record.read")
            spec,_=self.drafts._head(db,tenant,project_id)
            definition=self.records._model(spec,model)
            text_field=next((f["name"] for f in definition["fields"]
                             if f["type"]=="text"),None)
            rows=db.execute("""SELECT row_id FROM builder_rows WHERE tenant=?
                AND project_id=? AND model=? AND deleted=0 ORDER BY rowid
                LIMIT 101""",(tenant,project_id,model)).fetchall()
            choices=[]
            for row in rows[:100]:
                body,_=self.records._row(db,tenant,project_id,model,row["row_id"])
                checked=validate_row(definition,body)
                label=str(checked.get(text_field) or row["row_id"])[:96]
                choices.append({"row_id":row["row_id"],"label":label})
            return {"choices":choices,"truncated":len(rows)>100,
                    "total_included":len(choices),"tenant_bound":True}

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
