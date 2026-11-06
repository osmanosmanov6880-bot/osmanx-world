"""TITAN-X22/X23: loopback-only development WSGI API and static console.

An operator explicitly binds ONE verified principal and project when starting
the server. Caller-supplied organization, actor or role fields are NEVER trusted.
The 256-bit bearer token must be supplied out-of-band via local environment.
Do not bind to 0.0.0.0, proxy to the Internet, or expose this as a product API.
"""
from __future__ import annotations
import argparse
from hashlib import sha256
from hmac import compare_digest
import json
import os
from pathlib import Path
import re
import secrets
import sys
from typing import Any,Callable
from wsgiref.simple_server import make_server

from .app_policy import AppPrincipal,AppAccessDenied
from .app_runtime import LocalAppRuntime,AppOperationDenied
from .model_editor import LocalModelEditor
from .builder import validate_site_spec
from .contracts import ACTOR_RE,TENANT_RE
from .drafts import DraftDenied,_identity

_BODY_LIMIT=65536
_SLUG=re.compile(r"^[a-z][a-z0-9-]{0,39}$")
_MODEL=re.compile(r"^[a-z][a-z0-9_]{0,31}$")
_UUID=re.compile(r"^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$")
_ROOT=Path(__file__).resolve().parent.parent

class ConsoleDenied(ValueError):
    pass

def _unique_object(pairs):
    result={}
    for key,value in pairs:
        if key in result:
            raise ConsoleDenied("Duplicate JSON keys denied")
        result[key]=value
    return result

def _no_constants(value):
    raise ConsoleDenied("Nonfinite JSON numbers denied")

class LocalConsole:
    """WSGI app bound to one *server-defined* tenant/project/actor.

    Requires strong bearer token; never accepts identity in request body.
    Browser UI keeps token only in a JS variable (no cookies/localStorage).
    """

    def __init__(self,database:Path|str,*,tenant:str,project_id:str,actor:str,
                 token:str,port:int):
        _identity(tenant,project_id)
        if type(actor) is not str or not ACTOR_RE.fullmatch(actor):
            raise ConsoleDenied("Invalid trusted actor")
        if (type(token) is not str or len(token)<43 or len(token)>256
            or not re.fullmatch(r"[A-Za-z0-9_-]+",token)
            or len(set(token))<12):
            raise ConsoleDenied("A strong URL-safe local bearer token is required")
        if type(port) is not int or not 1024<=port<=65535:
            raise ConsoleDenied("Invalid local port")
        self.tenant=tenant
        self.project_id=project_id
        self.actor=actor
        self.token=token
        self.port=port
        self.runtime=LocalAppRuntime(str(database))
        self.model_editor=LocalModelEditor(self.runtime)
        # Fail early when the trusted local principal was not provisioned.
        self.runtime.policy.get_role(tenant=tenant,project_id=project_id,actor=actor)

    def _response(self,start_response,code:str,payload:bytes,ctype:str):
        headers=[
            ("Content-Type",ctype),
            ("Content-Length",str(len(payload))),
            ("Cache-Control","no-store, max-age=0"),
            ("X-Content-Type-Options","nosniff"),
            ("Referrer-Policy","no-referrer"),
            ("X-Frame-Options","DENY"),
            ("Cross-Origin-Resource-Policy","same-origin"),
            ("Content-Security-Policy",
             "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; "
             "frame-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"),
        ]
        start_response(code,headers)
        return [payload]

    def _json(self,start_response,code,payload:Any):
        return self._response(start_response,code,
                              json.dumps(payload,ensure_ascii=False,
                              separators=(",",":"),allow_nan=False).encode("utf-8"),
                              "application/json; charset=utf-8")

    @staticmethod
    def _body(environ)->dict:
        content_type=environ.get("CONTENT_TYPE","").split(";",1)[0].strip().lower()
        if content_type!="application/json" or environ.get("HTTP_TRANSFER_ENCODING"):
            raise ConsoleDenied("Only bounded JSON requests are accepted")
        try: size=int(environ.get("CONTENT_LENGTH",""))
        except ValueError as exc:
            raise ConsoleDenied("Explicit JSON body length required") from exc
        if not 1<=size<=_BODY_LIMIT:
            raise ConsoleDenied("Request body length out of bounds")
        # WSGI input can be a live socket: reading size+1 waits for a byte that
        # cannot arrive while the client is waiting for this response.
        # Content-Length is already bounded; read exactly size bytes.
        data=environ["wsgi.input"].read(size)
        if len(data)!=size:
            raise ConsoleDenied("Body shorter than declared Content-Length")
        try:
            raw=json.loads(data.decode("utf-8"),object_pairs_hook=_unique_object,
                           parse_constant=_no_constants)
        except (UnicodeError,ValueError,TypeError) as exc:
            raise ConsoleDenied("Malformed JSON") from exc
        if type(raw) is not dict:
            raise ConsoleDenied("JSON object required")
        return raw

    @staticmethod
    def _fields(data:dict,allowed:set,required:set)->None:
        if not required<=set(data) or not set(data)<=allowed:
            raise ConsoleDenied("Unknown or missing JSON request keys")

    def __call__(self,environ,start_response):
        """WSGI adapter with no cookies, CORS or external-resource fetching."""
        host=f"127.0.0.1:{self.port}"
        if (environ.get("HTTP_HOST")!=host
            or environ.get("REMOTE_ADDR")!="127.0.0.1"
            or environ.get("QUERY_STRING","")):
            return self._json(start_response,"403 Forbidden",{"error":"LOCAL_HOST_DENIED"})
        method=environ.get("REQUEST_METHOD","GET")
        path=environ.get("PATH_INFO","")
        if method in ("POST","PATCH","DELETE") and environ.get("HTTP_ORIGIN") not in (
                None,"http://"+host):
            return self._json(start_response,"403 Forbidden",{"error":"CROSS_ORIGIN_DENIED"})
        if method=="GET" and path in ("/","/console"):
            return self._asset(start_response,"index.html","text/html; charset=utf-8")
        if method=="GET" and path=="/assets/console.css":
            return self._asset(start_response,"console.css","text/css; charset=utf-8")
        if method=="GET" and path=="/assets/console.js":
            return self._asset(start_response,"console.js","application/javascript; charset=utf-8")
        if not path.startswith("/api/v1/"):
            return self._json(start_response,"404 Not Found",{"error":"NOT_FOUND"})
        authorization=environ.get("HTTP_AUTHORIZATION","")
        presented=authorization[7:] if authorization.startswith("Bearer ") else ""
        if not presented or not compare_digest(presented,self.token):
            return self._json(start_response,"401 Unauthorized",
                              {"error":"AUTHENTICATION_REQUIRED"})
        if method not in ("GET","POST","PATCH","DELETE"):
            return self._json(start_response,"405 Method Not Allowed",
                              {"error":"METHOD_NOT_ALLOWED"})
        try:
            return self._api(environ,start_response,method,path)
        except (ConsoleDenied,AppAccessDenied,DraftDenied,AppOperationDenied,ValueError) as exc:
            # Deliberately do not disclose tenant, actor, secrets or raw content.
            error="PERMISSION_DENIED" if isinstance(exc,AppAccessDenied) else "INVALID_OPERATION"
            status="403 Forbidden" if error=="PERMISSION_DENIED" else "400 Bad Request"
            return self._json(start_response,status,{"error":error})
        except Exception:
            return self._json(start_response,"500 Internal Server Error",
                              {"error":"LOCAL_API_ERROR"})

    def _asset(self,start_response,name,ctype):
        file=_ROOT/"assets"/name
        if file.is_symlink() or not file.is_file():
            return self._json(start_response,"404 Not Found",{"error":"ASSET_MISSING"})
        blob=file.read_bytes()
        if len(blob)>256000:
            return self._json(start_response,"500 Internal Server Error",
                              {"error":"ASSET_TOO_LARGE"})
        return self._response(start_response,"200 OK",blob,ctype)

    def _api(self,environ,start_response,method,path):
        tid,project,actor=self.tenant,self.project_id,self.actor
        runtime=self.runtime
        if method=="GET" and path=="/api/v1/me":
            out=runtime.policy.get_role(tenant=tid,project_id=project,actor=actor)
            return self._json(start_response,"200 OK",out)
        if method=="GET" and path=="/api/v1/spec":
            out=runtime.get_spec(tenant=tid,project_id=project,actor=actor)
            return self._json(start_response,"200 OK",out)
        if method=="GET" and path=="/api/v1/workflows":
            out=runtime.list_workflows(tenant=tid,project_id=project,actor=actor)
            return self._json(start_response,"200 OK",{"workflows":out})
        if method=="POST" and path=="/api/v1/workflows":
            data=self._body(environ)
            self._fields(data,{"rule"},{"rule"})
            out=runtime.add_workflow(tenant=tid,project_id=project,actor=actor,
                                     rule=data["rule"])
            return self._json(start_response,"201 Created",out)
        match=re.fullmatch(r"/api/v1/workflows/("+_UUID.pattern[1:-1]+r")/(run|disable)",path)
        if method=="POST" and match:
            workflow_id,op=match.groups()
            data=self._body(environ)
            if op=="run":
                self._fields(data,{"event_id","trigger","row_id"},
                             {"event_id","trigger","row_id"})
                out=runtime.run_workflow(tenant=tid,project_id=project,
                    actor=actor,workflow_id=workflow_id,**data)
            else:
                self._fields(data,{"expected_revision"},{"expected_revision"})
                out=runtime.disable_workflow(tenant=tid,project_id=project,
                    actor=actor,workflow_id=workflow_id,**data)
            return self._json(start_response,"200 OK",out)
        match=re.fullmatch(r"/api/v1/pages/("+_SLUG.pattern[1:-1]+r")/structure",path)
        if method=="POST" and match:
            data=self._body(environ)
            self._fields(data,{"expected_revision","operation","index",
                               "section","target_index"},
                         {"expected_revision","operation","index"})
            out=runtime.edit_structure(tenant=tid,project_id=project,actor=actor,
                                       slug=match.group(1),**data)
            return self._json(start_response,"200 OK",out)
        match=re.fullmatch(r"/api/v1/pages/("+_SLUG.pattern[1:-1]+r")",path)
        if method=="PATCH" and match:
            data=self._body(environ)
            self._fields(data,{"expected_revision","title","section_index","changes"},
                         {"expected_revision"})
            out=runtime.edit_page(tenant=tid,project_id=project,actor=actor,
                                  slug=match.group(1),**data)
            return self._json(start_response,"200 OK",out)
        if method=="GET" and path=="/api/v1/schema/migrations":
            out=self.model_editor.list_migrations(
                tenant=tid,project_id=project,actor=actor)
            return self._json(start_response,"200 OK",{"migrations":out})
        if method=="POST" and path=="/api/v1/schema/models":
            data=self._body(environ)
            self._fields(data,{"expected_revision","model"},
                         {"expected_revision","model"})
            out=self.model_editor.add_model(
                tenant=tid,project_id=project,actor=actor,**data)
            return self._json(start_response,"201 Created",out)
        match=re.fullmatch(r"/api/v1/schema/models/("+_MODEL.pattern[1:-1]+r")/fields/("+_MODEL.pattern[1:-1]+r")",path)
        if method=="PATCH" and match:
            data=self._body(environ)
            self._fields(data,{"expected_revision","label"},
                         {"expected_revision","label"})
            out=self.model_editor.label_field(
                tenant=tid,project_id=project,actor=actor,
                model=match.group(1),field=match.group(2),**data)
            return self._json(start_response,"200 OK",out)
        match=re.fullmatch(r"/api/v1/schema/models/("+_MODEL.pattern[1:-1]+r")/fields",path)
        if method=="POST" and match:
            data=self._body(environ)
            self._fields(data,{"expected_revision","field","default_value"},
                         {"expected_revision","field"})
            supplied="default_value" in data
            out=self.model_editor.add_field(
                tenant=tid,project_id=project,actor=actor,
                model=match.group(1),expected_revision=data["expected_revision"],
                field=data["field"],default_provided=supplied,
                default_value=data.get("default_value"))
            return self._json(start_response,"201 Created",out)
        match=re.fullmatch(r"/api/v1/schema/models/("+_MODEL.pattern[1:-1]+r")",path)
        if method=="PATCH" and match:
            data=self._body(environ)
            self._fields(data,{"expected_revision","label"},
                         {"expected_revision","label"})
            out=self.model_editor.label_model(
                tenant=tid,project_id=project,actor=actor,
                model=match.group(1),**data)
            return self._json(start_response,"200 OK",out)
        match=re.fullmatch(r"/api/v1/models/("+_MODEL.pattern[1:-1]+r")",path)
        if match and method=="GET":
            out=runtime.list_rows(tenant=tid,project_id=project,actor=actor,
                                  model=match.group(1))
            return self._json(start_response,"200 OK",{"rows":out})
        if match and method=="POST":
            data=self._body(environ)
            self._fields(data,{"data","idempotency_key"},{"data","idempotency_key"})
            out=runtime.create_row(tenant=tid,project_id=project,actor=actor,
                                   model=match.group(1),**data)
            return self._json(start_response,"201 Created",out)
        match=re.fullmatch(r"/api/v1/models/("+_MODEL.pattern[1:-1]+r")/("+
                           _UUID.pattern[1:-1]+r")",path)
        if match and method in ("PATCH","DELETE"):
            model,row_id=match.groups()
            data=self._body(environ)
            required={"expected_version","idempotency_key"}
            self._fields(data,required|({"changes"} if method=="PATCH" else set()),
                         required|({"changes"} if method=="PATCH" else set()))
            if method=="PATCH":
                out=runtime.update_row(tenant=tid,project_id=project,actor=actor,
                    model=model,row_id=row_id,**data)
            else:
                out=runtime.delete_row(tenant=tid,project_id=project,actor=actor,
                    model=model,row_id=row_id,**data)
            return self._json(start_response,"200 OK",out)
        match=re.fullmatch(r"/api/v1/preview/("+_SLUG.pattern[1:-1]+r")",path)
        if method=="GET" and match:
            pages=runtime.render_preview(tenant=tid,project_id=project,actor=actor)
            name="index.html" if match.group(1)=="home" else match.group(1)+".html"
            if name not in pages:
                return self._json(start_response,"404 Not Found",{"error":"PAGE_MISSING"})
            return self._json(start_response,"200 OK",
                              {"html":pages[name].decode("utf-8"),
                               "production_published":False})
        return self._json(start_response,"404 Not Found",{"error":"NOT_FOUND"})

def main(argv=None)->int:
    parser=argparse.ArgumentParser(description="Loopback-only local site builder console")
    subs=parser.add_subparsers(dest="command",required=True)
    for name in ("bootstrap","serve"):
        command=subs.add_parser(name)
        command.add_argument("--database",type=Path,required=True)
        command.add_argument("--tenant",required=True)
        command.add_argument("--project-id",required=True)
        command.add_argument("--actor",required=True)
        if name=="serve":
            command.add_argument("--port",type=int,default=8765)
    init=subs.add_parser("init")
    init.add_argument("--database",type=Path,required=True)
    init.add_argument("--spec",type=Path,required=True)
    init.add_argument("--actor",required=True)
    args=parser.parse_args(argv)
    if args.command=="init":
        data=json.loads(args.spec.read_text(encoding="utf-8"))
        validated=validate_site_spec(data)
        app=LocalAppRuntime(str(args.database))
        app.drafts.create(validated,tenant=validated["tenant_id"])
        app.policy.bootstrap_owner(tenant=validated["tenant_id"],
            project_id=validated["project_id"],actor=args.actor,
            now=__import__("time").time_ns()//10**9)
        print("LOCAL_DEMO_INITIALIZED; project="+validated["project_id"])
        return 0
    if args.command=="bootstrap":
        app=LocalAppRuntime(str(args.database))
        app.policy.bootstrap_owner(tenant=args.tenant,project_id=args.project_id,
                                   actor=args.actor,now=__import__("time").time_ns()//10**9)
        print("LOCAL_OWNER_PROVISIONED; no network service or production access")
        return 0
    token=os.environ.get("OSGARD_LOCAL_API_TOKEN","")
    app=LocalConsole(args.database,tenant=args.tenant,project_id=args.project_id,
                      actor=args.actor,token=token,port=args.port)
    with make_server("127.0.0.1",args.port,app) as server:
        print(f"Local console ready: http://127.0.0.1:{args.port}/console")
        print("Bearer token is never printed or stored by this server")
        server.serve_forever()
    return 0

if __name__=="__main__":
    raise SystemExit(main())
