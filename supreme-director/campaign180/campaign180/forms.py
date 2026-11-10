"""TITAN-X20/X21: strict revisioned model-backed page form editor.

Form edits affect only a typed, non-submitting static form section. Owner/editor
rights, section bounds, and the spec revision are checked in the same SQLite
transaction as the immutable history update. No live form submission.
"""
from __future__ import annotations
from typing import TYPE_CHECKING

from .builder import validate_site_spec
from .contracts import canonical,digest

if TYPE_CHECKING:
    from .app_runtime import LocalAppRuntime

class FormEditorDenied(ValueError):
    pass

def edit_form(runtime:"LocalAppRuntime",*,tenant:str,project_id:str,actor:str,
              slug:str,expected_revision:int,section_index:int,model:str,
              heading:str,button_label:str,fields:list[str])->dict:
    if type(expected_revision) is not int or expected_revision<1:
        raise FormEditorDenied("A positive exact draft revision is required")
    if type(slug) is not str or type(section_index) is not int or section_index<0:
        raise FormEditorDenied("Invalid form section locator")
    if type(model) is not str or type(heading) is not str or type(button_label) is not str:
        raise FormEditorDenied("Invalid form properties")
    if type(fields) is not list or not 1<=len(fields)<=12 or any(type(f) is not str for f in fields):
        raise FormEditorDenied("A nonempty ordered field list is required")
    with runtime.drafts._tx() as db:
        runtime._guard(db,tenant,project_id,actor,"spec.write")
        spec,head=runtime.drafts._head(db,tenant,project_id)
        if head["revision"]!=expected_revision:
            raise FormEditorDenied("Stale form revision")
        page=next((p for p in spec["pages"] if p["slug"]==slug),None)
        if page is None or section_index>=len(page["sections"]):
            raise FormEditorDenied("Form section not found")
        section=page["sections"][section_index]
        if section["type"]!="form":
            raise FormEditorDenied("Only form sections are editable with this method")
        section.clear()
        section.update({"type":"form","heading":heading,
                        "model":model,"button_label":button_label,
                        "fields":fields})
        validated=validate_site_spec(spec)
        sha=digest(validated)
        if sha==head["content_digest"]:
            return {"changed":False,"revision":head["revision"],"sha256":sha,
                    "production_published":False}
        canonical_json=canonical(validated).decode("utf-8")
        next_revision=head["revision"]+1
        updated=db.execute("""UPDATE draft_projects SET revision=?,content_digest=?,
            content_json=? WHERE tenant=? AND project_id=? AND revision=?""",
            (next_revision,sha,canonical_json,tenant,project_id,
             expected_revision)).rowcount
        if updated!=1:
            raise FormEditorDenied("Concurrent form edit detected")
        db.execute("""INSERT INTO draft_revisions
            (tenant,project_id,revision,content_digest,content_json)
            VALUES(?,?,?,?,?)""",
            (tenant,project_id,next_revision,sha,canonical_json))
        return {"changed":True,"revision":next_revision,"sha256":sha,
                "selected_fields":len(fields),"production_published":False}
