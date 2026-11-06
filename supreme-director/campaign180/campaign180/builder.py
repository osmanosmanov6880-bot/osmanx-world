"""TITAN-X17/X20/X21 local: deterministic schema-to-site generator (no AI).

This is an isolated offline compiler for human-editable site specifications.
It does not deploy, grant product access, accept submitted web forms or
provide the original canonical KRAKEN editor. Escaped static output only.
"""
from __future__ import annotations

from hashlib import sha256
from html import escape
import json
import re
from typing import Any, Mapping
import uuid

from .contracts import TENANT_RE, canonical

SCHEMA="osgard.original180.site-spec/1"
SLUG=re.compile(r"^[a-z][a-z0-9-]{0,39}$")
FIELD=re.compile(r"^[a-z][a-z0-9_]{0,31}$")
EMAIL=re.compile(r"^[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,160}\.[A-Za-z]{2,24}$")
PHONE=re.compile(r"^\+?[0-9 ()-]{5,30}$")
MODEL_TYPES=frozenset(("text","integer","boolean","email","date","reference"))
SECTION_TYPES=frozenset(("hero","text","features","stats","contacts","table"))
SECRET_NAMES=frozenset(("password","passwd","secret","token","api_key","private_key","access_key"))
MAX_SPEC_BYTES=65536
MAX_PAGES=8
MAX_SECTIONS=12

CSS="""*{box-sizing:border-box}body{margin:0;background:#08111f;color:#e7ecf6;
font:16px/1.65 system-ui,-apple-system,'Segoe UI',sans-serif}a{color:inherit}
header{display:flex;align-items:center;justify-content:space-between;gap:24px;
padding:20px max(5vw,18px);border-bottom:1px solid #28344b;background:#0e1a2b}
nav{display:flex;gap:20px;flex-wrap:wrap}nav a{text-decoration:none;color:#acbcd8}
nav a[aria-current=page]{color:#fff}main{max-width:1120px;margin:0 auto;
padding:50px 24px 95px}section{padding:42px 0;border-bottom:1px solid #27354a}
h1{font-size:clamp(34px,6vw,66px);line-height:1.1;letter-spacing:-.04em}
h2{font-size:clamp(24px,4vw,38px);line-height:1.15;letter-spacing:-.025em}
h1,h2,p{margin:0 0 22px}.eyebrow{color:#91addd;letter-spacing:.15em;
font-size:12px;font-weight:700;text-transform:uppercase}.lead{max-width:680px;
font-size:19px;color:#bfcee5}.button{display:inline-block;text-decoration:none;
padding:12px 22px;border:1px solid #8eabc9;border-radius:10px;background:#173053}
.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(210px,1fr));gap:15px}
.tile{padding:20px;border:1px solid #2b4261;border-radius:13px;background:#101f33}
.tile p{margin:0}table{width:100%;border-collapse:collapse;display:block;
overflow-x:auto}th,td{padding:12px;border-bottom:1px solid #2b405f;text-align:left;
white-space:normal}th{color:#a9bbd8}footer{padding:25px 5vw;
color:#98acc8;background:#0d1829}small{color:#a5b7cf}a:focus-visible{outline:3px solid #fff;outline-offset:3px}
@media(max-width:540px){header{display:block}nav{margin-top:12px}main{padding-top:30px}}
"""

class SiteSpecDenied(ValueError):
    pass


def _record(raw:Any, allowed:set[str], required:set[str], kind:str)->dict:
    if type(raw) is not dict or not required<=set(raw) or not set(raw)<=allowed:
        raise SiteSpecDenied("Invalid "+kind+" keys")
    return raw


def _string(value:Any, name:str, max_len:int=240)->str:
    if (type(value) is not str or not value.strip()
            or len(value)>max_len or any(ord(x)<32 and x not in "\n\t" for x in value)):
        raise SiteSpecDenied("Invalid "+name)
    return value.strip()


def _uuid(value:Any)->str:
    try:
        if type(value) is not str or str(uuid.UUID(value))!=value:
            raise ValueError()
    except ValueError as exc:
        raise SiteSpecDenied("Expected canonical UUID") from exc
    return value


def validate_site_spec(raw:Any)->dict:
    """Strict, versioned schema: no remote resources, HTML, JS or arbitrary CSS."""
    s=_record(raw,{"schema","tenant_id","project_id","locale","title",
                   "description","pages","models"},
              {"schema","tenant_id","project_id","locale","title","pages","models"},"site")
    if s["schema"]!=SCHEMA:
        raise SiteSpecDenied("Unknown local site schema")
    if type(s["tenant_id"]) is not str or not TENANT_RE.fullmatch(s["tenant_id"]):
        raise SiteSpecDenied("Invalid tenant")
    _uuid(s["project_id"])
    if s["locale"] not in ("ru","en"):
        raise SiteSpecDenied("Unsupported locale")
    _string(s["title"],"site title",100)
    if "description" in s:
        _string(s["description"],"description",280)
    models=s["models"]
    if type(models) is not list or len(models)>8:
        raise SiteSpecDenied("Invalid models array")
    model_names=set()
    for model in models:
        m=_record(model,{"name","label","fields"},{"name","label","fields"},"model")
        if type(m["name"]) is not str or not FIELD.fullmatch(m["name"]) or m["name"] in model_names:
            raise SiteSpecDenied("Repeated or unsafe model name")
        model_names.add(m["name"])
        _string(m["label"],"model label",80)
        fields=m["fields"]
        if type(fields) is not list or not 1<=len(fields)<=12:
            raise SiteSpecDenied("Invalid fields")
        names=set()
        for f in fields:
            f=_record(f,{"name","label","type","required","references"},
                      {"name","label","type","required"},"field")
            if (type(f["name"]) is not str or not FIELD.fullmatch(f["name"])
                    or f["name"] in names or f["name"] in SECRET_NAMES or f["name"]=="id"):
                raise SiteSpecDenied("Repeated, reserved or sensitive field name")
            names.add(f["name"])
            _string(f["label"],"field label",80)
            if f["type"] not in MODEL_TYPES or type(f["required"]) is not bool:
                raise SiteSpecDenied("Unsupported field type/required")
            if f["type"]=="reference":
                if type(f.get("references")) is not str or not FIELD.fullmatch(f["references"]):
                    raise SiteSpecDenied("Reference requires target model")
            elif "references" in f:
                raise SiteSpecDenied("Only reference fields may point to models")
    for m in models:
        for f in m["fields"]:
            if f["type"]=="reference" and f["references"] not in model_names:
                raise SiteSpecDenied("Unknown referenced model")
    pages=s["pages"]
    if type(pages) is not list or not 1<=len(pages)<=MAX_PAGES:
        raise SiteSpecDenied("Invalid page count")
    slugs=set()
    for page in pages:
        _record(page,{"slug","title","sections"},{"slug","title","sections"},"page")
        if type(page["slug"]) is not str or not SLUG.fullmatch(page["slug"]) or page["slug"] in slugs:
            raise SiteSpecDenied("Duplicate/unsafe page slug")
        slugs.add(page["slug"])
        _string(page["title"],"page title",100)
        sections=page["sections"]
        if type(sections) is not list or not 1<=len(sections)<=MAX_SECTIONS:
            raise SiteSpecDenied("Invalid section count")
        for section in sections:
            if type(section) is not dict or "type" not in section or section["type"] not in SECTION_TYPES:
                raise SiteSpecDenied("Unknown section type")
            typ=section["type"]
            accepted={
                "hero":({"type","heading","text","cta_label","cta_page"},{"type","heading","text"}),
                "text":({"type","heading","text"},{"type","heading","text"}),
                "features":({"type","heading","items"},{"type","heading","items"}),
                "stats":({"type","heading","items"},{"type","heading","items"}),
                "contacts":({"type","heading","email","phone"},{"type","heading"}),
                "table":({"type","heading","model"},{"type","heading","model"}),
            }
            allow,required=accepted[typ]
            _record(section,allow,required,"section")
            _string(section["heading"],"section heading",140)
            if typ in ("hero","text"):
                _string(section["text"],"section text",1600)
                if ("cta_label" in section)!=("cta_page" in section):
                    raise SiteSpecDenied("CTA requires label and target")
                if "cta_label" in section:
                    _string(section["cta_label"],"CTA label",60)
            if typ=="features":
                items=section["items"]
                if type(items) is not list or not 1<=len(items)<=12:
                    raise SiteSpecDenied("Feature items required")
                for item in items:_string(item,"feature text",280)
            if typ=="stats":
                items=section["items"]
                if type(items) is not list or not 1<=len(items)<=12:
                    raise SiteSpecDenied("Stat items required")
                for item in items:
                    _record(item,{"label","value"},{"label","value"},"stat")
                    _string(item["label"],"stat label",80)
                    _string(item["value"],"stat value",80)
            if typ=="contacts":
                if not ("email" in section or "phone" in section):
                    raise SiteSpecDenied("Contacts section must offer direct contact")
                if "email" in section and (
                    type(section["email"]) is not str or not EMAIL.fullmatch(section["email"])):
                    raise SiteSpecDenied("Invalid email address")
                if "phone" in section and (
                    type(section["phone"]) is not str or not PHONE.fullmatch(section["phone"])):
                    raise SiteSpecDenied("Invalid phone number")
            if typ=="table" and section["model"] not in model_names:
                raise SiteSpecDenied("Unknown table data model")
    if "home" not in slugs:
        raise SiteSpecDenied("Home page required")
    for page in pages:
        for section in page["sections"]:
            if section.get("cta_page") is not None and section["cta_page"] not in slugs:
                raise SiteSpecDenied("CTA points to missing page")
    if len(canonical(s))>MAX_SPEC_BYTES:
        raise SiteSpecDenied("Site specification exceeds 64 KiB")
    # JSON round-trip prevents edits in one caller from mutating a queued spec.
    return json.loads(canonical(s))


def validate_row(model:dict, raw:Any, *, partial:bool=False)->dict:
    """Reject unknown/incorrect field data; reference existence is checked by DB."""
    if type(raw) is not dict:
        raise SiteSpecDenied("Expected exact data row")
    fields={x["name"]:x for x in model["fields"]}
    if not set(raw)<=set(fields):
        raise SiteSpecDenied("Unknown model field")
    if not partial and any(f["required"] and f["name"] not in raw for f in fields.values()):
        raise SiteSpecDenied("Required model field missing")
    data={}
    for name,value in raw.items():
        typ=fields[name]["type"]
        if value is None:
            if fields[name]["required"]:
                raise SiteSpecDenied("Required field cannot be null")
            data[name]=None
            continue
        if typ=="integer":
            if type(value) is not int or not -10**12<=value<=10**12:
                raise SiteSpecDenied("Invalid bounded integer")
        elif typ=="boolean":
            if type(value) is not bool:
                raise SiteSpecDenied("Expected boolean")
        elif typ=="email":
            if type(value) is not str or not EMAIL.fullmatch(value):
                raise SiteSpecDenied("Invalid email")
        elif typ=="date":
            from datetime import date
            try:
                if type(value) is not str or len(value)!=10 or date.fromisoformat(value).isoformat()!=value:
                    raise ValueError()
            except ValueError as exc:
                raise SiteSpecDenied("Invalid ISO date") from exc
        elif typ=="reference":
            _uuid(value)
        else:
            _string(value,name,1000)
        data[name]=value
    return data


def _href(slug:str)->str:
    return "index.html" if slug=="home" else slug+".html"


def render_site(raw:dict, *, datasets:Mapping[str,list[dict]] | None=None)->dict[str,bytes]:
    """Deterministic pure offline renderer; never contacts network or filesystem."""
    s=validate_site_spec(raw)
    datasets={} if datasets is None else datasets
    if not isinstance(datasets,Mapping) or not set(datasets)<=set(m["name"] for m in s["models"]):
        raise SiteSpecDenied("Preview dataset has unknown model")
    models={m["name"]:m for m in s["models"]}
    validated={}
    for name,rows in datasets.items():
        if type(rows) is not list or len(rows)>100:
            raise SiteSpecDenied("Preview row count limit")
        validated[name]=[validate_row(models[name],r) for r in rows]
    title=escape(s["title"],quote=True)
    links=" ".join(
        '<a href="'+_href(p["slug"])+'"'+(' aria-current="page"' if p["slug"]=="home" else "")+
        '>'+escape(p["title"])+"</a>" for p in s["pages"])
    out={}
    for p in s["pages"]:
        nav=" ".join('<a href="'+_href(q["slug"])+'"'+(
            ' aria-current="page"' if q["slug"]==p["slug"] else "")+
            '>'+escape(q["title"])+"</a>" for q in s["pages"])
        chunks=[]
        for sec in p["sections"]:
            name=escape(sec["heading"])
            typ=sec["type"]
            if typ=="hero":
                block='<section><p class="eyebrow">'+title+'</p><h1>'+name+'</h1><p class="lead">'+escape(sec["text"])+'</p>'
                if "cta_page" in sec:
                    block+='<a class="button" href="'+_href(sec["cta_page"])+'">'+escape(sec["cta_label"])+"</a>"
                chunks.append(block+"</section>")
            elif typ=="text":
                chunks.append("<section><h2>"+name+"</h2><p>"+escape(sec["text"])+"</p></section>")
            elif typ=="features":
                chunks.append("<section><h2>"+name+'</h2><div class="tiles">'+
                    "".join('<div class="tile"><p>'+escape(v)+"</p></div>" for v in sec["items"])+
                    "</div></section>")
            elif typ=="stats":
                chunks.append("<section><h2>"+name+'</h2><div class="tiles">'+
                    "".join('<div class="tile"><h2>'+escape(v["value"])+
                            '</h2><small>'+escape(v["label"])+"</small></div>" for v in sec["items"])+
                    "</div></section>")
            elif typ=="contacts":
                contact=[]
                if "email" in sec:
                    e=escape(sec["email"],quote=True)
                    contact.append('<a href="mailto:'+e+'">'+e+"</a>")
                if "phone" in sec:
                    e=escape(sec["phone"],quote=True)
                    contact.append('<a href="tel:'+escape(re.sub(r"[^0-9+]","",sec["phone"]))+'">'+e+"</a>")
                chunks.append("<section><h2>"+name+"</h2><p>"+" · ".join(contact)+"</p></section>")
            elif typ=="table":
                model=models[sec["model"]]
                fields=model["fields"]
                header="<tr>"+"".join("<th scope=\"col\">"+escape(f["label"])+"</th>" for f in fields)+"</tr>"
                rows=validated.get(sec["model"],[])
                lines=[]
                for row in rows:
                    values=[]
                    for field in fields:
                        value=row.get(field["name"])
                        if isinstance(value,bool):
                            value="Да" if value else "Нет"
                        values.append("<td>"+escape(str(value) if value is not None else "—")+"</td>")
                    lines.append("<tr>"+"".join(values)+"</tr>")
                chunks.append("<section><h2>"+name+"</h2><table><thead>"+header+
                    "</thead><tbody>"+"".join(lines)+"</tbody></table>"+
                    ("" if rows else "<p>Данные пока не добавлены.</p>")+"</section>")
        description=escape(s.get("description","Локальное превью"),quote=True)
        doc='<!doctype html><html lang="'+s["locale"]+'"><head><meta charset="utf-8">'+\
            '<meta name="viewport" content="width=device-width,initial-scale=1">'+\
            '<meta http-equiv="Content-Security-Policy" content="default-src &#39;none&#39;; style-src &#39;unsafe-inline&#39;; img-src data:; base-uri &#39;none&#39;; form-action &#39;none&#39;">'+\
            '<meta name="robots" content="noindex,nofollow">'+\
            '<meta name="description" content="'+description+'">'+\
            '<title>'+escape(p["title"])+' · '+title+'</title><style>'+CSS+'</style></head>'+\
            '<body><header><strong>'+title+'</strong><nav aria-label="Основная навигация">'+\
            nav+'</nav></header><main>'+"".join(chunks)+'</main><footer><small>'+\
            'Локальное превью · без публикации · '+title+'</small></footer></body></html>'
        out[_href(p["slug"])]=doc.encode("utf-8")
    return dict(sorted(out.items()))
