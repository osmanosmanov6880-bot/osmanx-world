"""TITAN-X22: database-atomic, bounded model-event workflow dispatch.

Runs only from a trusted CRUD transaction after validation. A client cannot
submit or impersonate record.created/updated events. No outbound I/O, arbitrary
code or recursive event dispatch is supported. A workflow failure rolls back
the ENTIRE originating record mutation.
"""
from __future__ import annotations

from dataclasses import dataclass
import sqlite3
from typing import TYPE_CHECKING
import uuid

from .builder import validate_row
from .contracts import canonical, digest
from .drafts import _identity

if TYPE_CHECKING:
    from .app_runtime import LocalAppRuntime

MAX_ACTIONS_PER_EVENT=20
AUTOMATIC_EVENTS=frozenset(("record.created","record.updated"))

class AutomaticWorkflowDenied(ValueError):
    pass

def apply_record_event(runtime:"LocalAppRuntime",db:sqlite3.Connection,*,
                       tenant:str,project_id:str,model:str,row_id:str,
                       trigger:str,mutation_key:str)->dict:
    """Runs after CRUD commit candidates, inside the caller's active transaction.

    The surrounding caller MUST already have a tenant/project-scoped record.write
    authorization in the same transaction. This is an internal-only function.
    """
    _identity(tenant,project_id)
    if trigger not in AUTOMATIC_EVENTS:
        raise AutomaticWorkflowDenied("Invalid local record event trigger")
    runtime.records._rowid(row_id)
    runtime.records._key(mutation_key)
    spec,_=runtime.drafts._head(db,tenant,project_id)
    definition=runtime.records._model(spec,model)
    rows=db.execute("""SELECT * FROM app_workflows WHERE tenant=? AND project_id=?
        AND enabled=1 ORDER BY workflow_id LIMIT ?""",
        (tenant,project_id,MAX_ACTIONS_PER_EVENT+1)).fetchall()
    if len(rows)>MAX_ACTIONS_PER_EVENT:
        raise AutomaticWorkflowDenied("Workflow event execution budget exceeded")
    fired=[]
    matched=0
    for wf in rows:
        checked=runtime._read_rule(wf)
        rule=runtime._rule(spec,checked["rule"])
        if rule["model"]!=model or rule["trigger"]!=trigger:
            continue
        event_id=str(uuid.uuid5(uuid.NAMESPACE_URL,
            f"osgard-auto/{tenant}/{project_id}/{model}/{row_id}/{trigger}/{mutation_key}/{wf['workflow_id']}"))
        run_digest=digest({"event_id":event_id,"workflow_id":wf["workflow_id"],
                           "trigger":trigger,"row_id":row_id})
        previous=db.execute("""SELECT run_digest,response_json FROM app_workflow_runs
            WHERE tenant=? AND project_id=? AND workflow_id=? AND event_id=?""",
            (tenant,project_id,wf["workflow_id"],event_id)).fetchone()
        if previous:
            if previous["run_digest"]!=run_digest:
                raise AutomaticWorkflowDenied("Automatic event idempotency collision")
            continue
        count=db.execute("""SELECT COUNT(*) FROM app_workflow_runs WHERE tenant=?
            AND project_id=?""",(tenant,project_id)).fetchone()[0]
        if count>=10000:
            raise AutomaticWorkflowDenied("Workflow run retention quota reached")
        body,row=runtime.records._row(db,tenant,project_id,model,row_id)
        fields=validate_row(definition,body)
        condition=rule["condition"]
        selected=condition is None or fields.get(condition["field"])==condition["equals"]
        changed=False
        version=row["version"]
        if selected:
            matched+=1
            new_name=rule["action"]["field"]
            new_value=rule["action"]["value"]
            replacement=validate_row(definition,{**fields,new_name:new_value})
            if replacement!=fields:
                runtime.records._refs(db,tenant,project_id,definition,replacement)
                version=row["version"]+1
                updated=db.execute("""UPDATE builder_rows SET version=?,content_digest=?,
                    data_json=? WHERE tenant=? AND project_id=? AND model=? AND row_id=?
                    AND version=? AND deleted=0""",
                    (version,digest(replacement),canonical(replacement).decode("utf-8"),
                     tenant,project_id,model,row_id,row["version"])).rowcount
                if updated!=1:
                    raise AutomaticWorkflowDenied("Record version changed during event")
                runtime.records._replace_links(db,tenant,project_id,model,row_id,
                                               definition,replacement)
                changed=True
        result={"workflow_id":wf["workflow_id"],"event_id":event_id,
                "matched":selected,"changed":changed,"row_version":version,
                "network_calls":0,"production_executed":False}
        db.execute("""INSERT INTO app_workflow_runs
            (tenant,project_id,workflow_id,event_id,run_digest,response_json)
            VALUES(?,?,?,?,?,?)""",
            (tenant,project_id,wf["workflow_id"],event_id,run_digest,
             canonical(result).decode("utf-8")))
        fired.append({"workflow_id":wf["workflow_id"],"changed":changed})
    return {"dispatched":len(fired),"matched":matched,
            "changed":sum(1 for event in fired if event["changed"]),
            "external_effects":0,"reentrant":False}
