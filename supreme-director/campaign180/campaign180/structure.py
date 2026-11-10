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


# TITAN-X20: full offline/no-AI page lifecycle in the existing SQLite
# editor. Every operation uses the same RBAC and immutable draft revisions.
PAGE_OPERATIONS=frozenset(("add","duplicate","rename","move","remove"))

def mutate_pages(runtime:"LocalAppRuntime",*,tenant:str,project_id:str,
                 actor:str,operation:str,slug:str,expected_revision:int,
                 target_slug:str|None=None,title:str|None=None,
                 target_index:int|None=None)->dict:
    """Transactionally add/copy/rename/reorder/delete safe static pages.

    Home cannot be renamed/deleted. References to renamed pages are updated
    atomically, while removal of a referenced page is denied until callers
    explicitly change the CTA. No publishing, SQL schema changes or scripts.
    """
    from .builder import MAX_PAGES,SLUG
    from copy import deepcopy
    if (type(operation) is not str or operation not in PAGE_OPERATIONS or
        type(slug) is not str or not SLUG.fullmatch(slug) or
        type(expected_revision) is not int or expected_revision<1):
        raise StructureDenied("Invalid bounded page operation")
    if target_slug is not None and (
        type(target_slug) is not str or not SLUG.fullmatch(target_slug)):
        raise StructureDenied("Invalid new page slug")
    if title is not None and (type(title) is not str or
        not title.strip() or len(title)>100):
        raise StructureDenied("Invalid page title")
    if target_index is not None and (
        type(target_index) is not int or target_index<0 or
        target_index>=MAX_PAGES):
        raise StructureDenied("Invalid new page index")
    if operation=="add" and (target_slug is not None or target_index is not None
                             or title is None):
        raise StructureDenied("Add requires new slug and page title")
    if operation in ("duplicate","rename") and (target_slug is None or
                                                target_index is not None):
        raise StructureDenied("Copy/rename requires new target slug")
    if operation in ("remove","move") and (
        target_slug is not None or title is not None):
        raise StructureDenied("Remove/reorder cannot rename a page")
    if operation=="move" and target_index is None:
        raise StructureDenied("Reorder requires destination position")
    if operation=="remove" and target_index is not None:
        raise StructureDenied("Removal does not accept page position")
    with runtime.drafts._tx() as db:
        runtime._guard(db,tenant,project_id,actor,"spec.write")
        spec,head=runtime.drafts._head(db,tenant,project_id)
        if head["revision"]!=expected_revision:
            raise StructureDenied("Stale page version")
        pages=spec["pages"]
        old=next((p for p in pages if p["slug"]==slug),None)
        destination=target_slug if target_slug is not None else slug
        if operation=="add":
            if old is not None or len(pages)>=MAX_PAGES:
                raise StructureDenied("Page exists or page limit exceeded")
            pages.append({"slug":slug,"title":title.strip(),
                          "sections":[{"type":"text","heading":"Новый раздел",
                                       "text":"Содержимое страницы"}]})
        else:
            if old is None:
                raise StructureDenied("Original page not found")
            if operation=="duplicate":
                if (destination==slug or len(pages)>=MAX_PAGES or
                    any(p["slug"]==destination for p in pages)):
                    raise StructureDenied("New duplicated page slug is unavailable")
                new=deepcopy(old)
                new["slug"]=destination
                new["title"]=title.strip() if title is not None else old["title"]+" — копия"
                pages.insert(pages.index(old)+1,new)
            elif operation=="rename":
                if slug=="home" or destination==slug or any(
                    p["slug"]==destination for p in pages):
                    raise StructureDenied("Home or duplicate page slug cannot be renamed")
                old["slug"]=destination
                if title is not None:old["title"]=title.strip()
                for page in pages:
                    for sec in page["sections"]:
                        if sec.get("cta_page")==slug:
                            sec["cta_page"]=destination
            elif operation=="move":
                if target_index>=len(pages):
                    raise StructureDenied("Page reorder target does not exist")
                pages.remove(old)
                pages.insert(target_index,old)
            elif operation=="remove":
                if slug=="home" or len(pages)<=1:
                    raise StructureDenied("Cannot remove the last/home page")
                if any(section.get("cta_page")==slug for page in pages
                       for section in page["sections"]):
                    raise StructureDenied("Page is referenced by a CTA; update it first")
                pages.remove(old)
        checked=validate_site_spec(spec)
        encoded=canonical(checked).decode("utf-8")
        sha=digest(checked)
        if sha==head["content_digest"]:
            return {"revision":expected_revision,"changed":False,
                    "slug":destination,"page_count":len(pages),
                    "production_published":False}
        revision=expected_revision+1
        changed=db.execute("""UPDATE draft_projects SET revision=?,
            content_digest=?,content_json=? WHERE tenant=? AND project_id=?
            AND revision=?""",
            (revision,sha,encoded,tenant,project_id,expected_revision)).rowcount
        if changed!=1:
            raise StructureDenied("Concurrent page change denied")
        db.execute("""INSERT INTO draft_revisions
            (tenant,project_id,revision,content_digest,content_json)
            VALUES(?,?,?,?,?)""",(tenant,project_id,revision,sha,encoded))
        return {"revision":revision,"changed":True,
                "slug":destination,"page_count":len(pages),"sha256":sha,
                "production_published":False}
