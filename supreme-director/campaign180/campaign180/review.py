"""TITAN-X18: no-write, fail-closed patch proposals against exact source bytes.

This is NOT a GitHub approval, independent code review or patch executor.
The caller supplies bytes and base SHA-256 for all proposed replacements.
Only the isolated campaign180 source tree is eligible for local review.
"""
from __future__ import annotations

import ast
import base64
from hashlib import sha256
from pathlib import Path, PurePosixPath
import re
from typing import Any

from .contracts import ACTOR_RE, canonical
from .gates import check_change_set

PREFIX="supreme-director/campaign180/"
HEX64=re.compile(r"^[a-f0-9]{64}$")
MAX_PATCH_FILES=30
MAX_FILE_BYTES=192*1024
MAX_CHANGE_BYTES=1024*1024


class PatchDenied(ValueError):
    pass


def _path(root: Path, name: Any) -> Path:
    if (type(name) is not str or not name.startswith(PREFIX)
            or "\\" in name or "\x00" in name or name.endswith("/")
            or any(s in (".","..") for s in PurePosixPath(name).parts)):
        raise PatchDenied("Patch path is outside isolated campaign tree")
    local=root.joinpath(*PurePosixPath(name).parts)
    if not local.resolve().is_relative_to(root.resolve()):
        raise PatchDenied("Symlink escape in patch path")
    current=root
    for segment in PurePosixPath(name).parts:
        current=current/segment
        if current.is_symlink():
            raise PatchDenied("Symlink in patch path")
    if local.exists() and not local.is_file():
        raise PatchDenied("Patch target is not regular file")
    if any(part.lower().startswith(".env") for part in PurePosixPath(name).parts):
        raise PatchDenied("Sensitive patch name")
    return local


def _python_policy(content: bytes) -> list[str]:
    try:
        script=content.decode("utf-8")
        tree=ast.parse(script)
    except (UnicodeError,SyntaxError,ValueError):
        return ["INVALID_PYTHON_SYNTAX"]
    issues=[]
    for node in ast.walk(tree):
        if not isinstance(node,ast.Call):
            continue
        fn=node.func
        if isinstance(fn,ast.Name) and fn.id in ("eval","exec","compile","__import__"):
            issues.append("DYNAMIC_CODE_EXECUTION")
        if isinstance(fn,ast.Attribute) and isinstance(fn.value,ast.Name):
            if fn.value.id=="os" and fn.attr=="system":
                issues.append("SHELL_EXECUTION")
            if fn.value.id=="subprocess" and fn.attr=="Popen":
                issues.append("UNREVIEWED_SUBPROCESS")
        if isinstance(fn,ast.Attribute) and isinstance(fn.value,ast.Name) and fn.value.id=="subprocess":
            if any(k.arg=="shell" and isinstance(k.value,ast.Constant)
                   and k.value.value is True for k in node.keywords):
                issues.append("SHELL_TRUE_EXECUTION")
    return sorted(set(issues))


def inspect_patch(root: Path, proposal: Any) -> dict:
    root=Path(root).resolve()
    if type(proposal) is not dict or set(proposal)!={"schema","author","reviewer","changes"}:
        raise PatchDenied("Expected exact patch proposal schema")
    if proposal["schema"]!="osgard.original180.patch-proposal/1":
        raise PatchDenied("Unsupported patch schema")
    author,reviewer=proposal["author"],proposal["reviewer"]
    if (type(author) is not str or not ACTOR_RE.fullmatch(author)
            or type(reviewer) is not str or not ACTOR_RE.fullmatch(reviewer)
            or author==reviewer):
        raise PatchDenied("Patch requires distinct declared author and reviewer")
    changes=proposal["changes"]
    if type(changes) is not list or not 1<=len(changes)<=MAX_PATCH_FILES:
        raise PatchDenied("Invalid patch file count")
    seen=set()
    summaries=[]
    total=0
    for item in changes:
        if type(item) is not dict or set(item)!={"path","base_sha256","content_base64"}:
            raise PatchDenied("Invalid patch file entry")
        name=item["path"]
        path=_path(root,name)
        if name in seen:
            raise PatchDenied("Duplicate patch file")
        seen.add(name)
        base=item["base_sha256"]
        if path.exists():
            if type(base) is not str or not HEX64.fullmatch(base):
                raise PatchDenied("Existing file requires exact base SHA256")
            if sha256(path.read_bytes()).hexdigest()!=base:
                raise PatchDenied("Stale base SHA256; patch review must restart")
        elif base is not None:
            raise PatchDenied("New file must declare null base SHA256")
        raw=item["content_base64"]
        if type(raw) is not str or len(raw)>4*MAX_FILE_BYTES:
            raise PatchDenied("Invalid base64 source")
        try:
            body=base64.b64decode(raw,validate=True)
        except (ValueError,base64.binascii.Error) as exc:
            raise PatchDenied("Malformed base64 source") from exc
        if not body or len(body)>MAX_FILE_BYTES:
            raise PatchDenied("Patch file content exceeds limit")
        total+=len(body)
        if total>MAX_CHANGE_BYTES:
            raise PatchDenied("Patch total content exceeds limit")
        issues=[]
        if b"\x00" in body:
            issues.append("BINARY_CONTENT")
        elif name.endswith(".py"):
            issues.extend(_python_policy(body))
        if b"\xe2\x80\xae" in body or b"\xe2\x80\xad" in body:
            issues.append("BIDI_OVERRIDE_CHARACTER")
        # Read-only static scanner, never expose discovered key values.
        from .supplychain import scan_content
        issues.extend([x["rule"] for x in scan_content(name,body) if x["severity"]=="blocker"])
        summaries.append({"path":name,"old_sha256":base,
                          "new_sha256":sha256(body).hexdigest(),
                          "bytes":len(body),"issues":sorted(set(issues))})
    changed=check_change_set(root,[x["path"] for x in summaries])
    if not changed["admitted_for_local_nonproduction_development"]:
        raise PatchDenied("Change set fails existing source ownership gate")
    all_issues=sorted({issue for x in summaries for issue in x["issues"]})
    receipt={"schema":"osgard.original180.patch-review/1",
             "proposal_sha256":sha256(canonical(proposal)).hexdigest(),
             "files":summaries,"issues":all_issues,
             "local_static_checks_pass":not all_issues,
             "external_identity_verification":False,
             "independent_reviewer_verified":False,
             "github_approval":False,"product_merge_authorized":False,
             "production_deploy_authorized":False}
    return receipt
