"""TITAN-X20/X22: versioned no-code page structure operations.

All structure mutation steps, permission checks, specification validation and
history writes run in one SQLite transaction. This is a local bounded editor,
not a plugin marketplace, script executor or publishing pipeline.
"""
from __future__ import annotations
from typing import Any,TYPE_CHECKING

from .builder import validate_site_spec
from .contracts import canonical,digest

if TYPE_CHECKING:
    from .app_runtime import LocalAppRuntime

ALLOWED_OPERATIONS=frozenset(("add","move","remove"))
MAX_SECTIONS=12

class StructureDenied(ValueError):
    pass

def mutate_structure(runtime:"LocalAppRuntime",*,tenant:str,project_id:str,
                     actor:str,slug:str,expected_revision:int,operation:str,
                     index:int,section:dict|None=None,
                     target_index:int|None=None)->dict:
    if type(expected_revision) is not int or expected_revision<1:
        raise StructureDenied("Expected positive specification revision")
    if type(slug) is not str or operation not in ALLOWED_OPERATIONS:
        raise StructureDenied("Unknown page or structure operation")
    if type(index) is not int or index<0:
        raise StructureDenied("Invalid section index")
    with runtime.drafts._tx() as db:
        runtime._guard(db,tenant,project_id,actor,"spec.write")
        document,head=runtime.drafts._head(db,tenant,project_id)
        if head["revision"]!=expected_revision:
            raise StructureDenied("Stale section edit")
        pages=[p for p in document["pages"] if p["slug"]==slug]
        if len(pages)!=1:
            raise StructureDenied("Page not found")
        items=pages[0]["sections"]
        if operation=="add":
            if section is None or target_index is not None or index>len(items):
                raise StructureDenied("Invalid section insertion")
            if len(items)>=MAX_SECTIONS:
                raise StructureDenied("Maximum number of page sections reached")
            if type(section) is not dict:
                raise StructureDenied("Section must be a structured JSON object")
            items.insert(index,section)
        elif operation=="move":
            if section is not None or type(target_index) is not int or not (
                0<=index<len(items) and 0<=target_index<len(items)):
                raise StructureDenied("Invalid section reorder")
            moved=items.pop(index)
            items.insert(target_index,moved)
        elif operation=="remove":
            if section is not None or target_index is not None or len(items)<=1 or index>=len(items):
                raise StructureDenied("Cannot remove last/unknown section")
            items.pop(index)
        checked=validate_site_spec(document)
        content=canonical(checked).decode("utf-8")
        signature=digest(checked)
        if signature==head["content_digest"]:
            return {"revision":expected_revision,"changed":False,
                    "section_count":len(items),"production_published":False}
        new_revision=expected_revision+1
        changed=db.execute("""UPDATE draft_projects SET revision=?,content_digest=?,
            content_json=? WHERE tenant=? AND project_id=? AND revision=?""",
            (new_revision,signature,content,tenant,project_id,expected_revision)).rowcount
        if changed!=1:
            raise StructureDenied("Concurrent section mutation denied")
        db.execute("""INSERT INTO draft_revisions
            (tenant,project_id,revision,content_digest,content_json)
            VALUES(?,?,?,?,?)""",(tenant,project_id,new_revision,signature,content))
        return {"revision":new_revision,"changed":True,
                "section_count":len(items),"sha256":signature,
                "production_published":False}
