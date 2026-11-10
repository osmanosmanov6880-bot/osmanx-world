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
import os
import re
import subprocess
import tempfile
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


# TITAN-X18: verified review signature over immutable, audited patch proposal.
# This DOES NOT by itself authenticate a real GitHub principal or grant merge.
# The caller must obtain an independently managed reviewer key fingerprint.
def review_signing_message(root:Path,proposal:dict)->bytes:
    """Canonical bytes for an owner-independent reviewer to sign offline."""
    receipt=inspect_patch(root,proposal)
    if not receipt["local_static_checks_pass"] or receipt["issues"]:
        raise PatchDenied("Patch has blocking static policy findings")
    content={"schema":"osgard.original180.patch-review-signature/1",
             "proposal_sha256":receipt["proposal_sha256"],
             "inspection_sha256":sha256(canonical(receipt)).hexdigest(),
             "reviewer":proposal["reviewer"],
             "verdict":"APPROVE_LOCAL_PATCH_ONLY",
             "product_merge_authorized":False,
             "production_deploy_authorized":False}
    return canonical(content)

def verify_signed_patch_review(root:Path,proposal:dict,*,signature:bytes,
                               reviewer_public_key:Path,
                               trusted_key_sha256:str)->dict:
    """X18: fail-closed distinct-author review and pinned Ed25519 signature.

    The public-key fingerprint must come from the independent review policy;
    generating a new key in CI validates crypto but not identity or approval.
    No proposal bytes are applied or executed.
    """
    from .titan_artifacts import public_key_fingerprint
    if type(signature) is not bytes or len(signature)!=64:
        raise PatchDenied("Ed25519 reviewer signature must be exactly 64 bytes")
    if (type(trusted_key_sha256) is not str or
        not HEX64.fullmatch(trusted_key_sha256)):
        raise PatchDenied("Independent trusted reviewer-key SHA256 required")
    key_fingerprint=public_key_fingerprint(reviewer_public_key)
    import hmac
    if not hmac.compare_digest(key_fingerprint,trusted_key_sha256):
        raise PatchDenied("Reviewer key differs from trusted policy fingerprint")
    signed=review_signing_message(root,proposal)
    with tempfile.TemporaryDirectory(prefix="titan-patch-review-") as directory:
        input_path=Path(directory)/"approval.json"
        signature_path=Path(directory)/"signature.bin"
        input_path.write_bytes(signed)
        signature_path.write_bytes(signature)
        args=["openssl","pkeyutl","-verify","-pubin","-inkey",
              str(reviewer_public_key),"-rawin","-in",str(input_path),
              "-sigfile",str(signature_path)]
        try:
            verified=subprocess.run(args,capture_output=True,check=False,
                                    timeout=12,shell=False,
                                    env={"PATH":"/usr/bin:/bin","LC_ALL":"C"})
        except (OSError,subprocess.TimeoutExpired) as exc:
            raise PatchDenied("Offline reviewer signature verification unavailable") from exc
        if verified.returncode!=0:
            raise PatchDenied("Reviewer did not sign this exact inspected patch")
    return {"schema":"osgard.original180.verified-patch-review/1",
            "proposal_sha256":sha256(canonical(proposal)).hexdigest(),
            "reviewer":proposal["reviewer"],"author":proposal["author"],
            "reviewer_key_der_sha256":key_fingerprint,
            "signed_message_sha256":sha256(signed).hexdigest(),
            "ed25519_signature_valid":True,
            "static_policy_passed":True,
            "independent_identity_verified":False,
            "github_review_verified":False,
            "source_owner_approved":False,
            "product_merge_authorized":False,
            "production_deploy_authorized":False}
