"""TITAN-X01: signed and pinned read-only Git baseline for THREE real source repositories.

No clone, fetch, execution of source code, release or identity assertion.
An independently pinned Ed25519 key is required to verify the component policy.
Even successful local verification is not independent product acceptance.
"""
from __future__ import annotations
from hashlib import sha1, sha256
import argparse
import hmac
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile
from typing import Mapping

from .contracts import canonical
from .registry import EvidenceError, SHA_RE, CANONICAL_REPO_RE

SCHEMA = "osgard.original180.titan-source-baselines/1"
COMPONENTS = ("KRAKEN", "DevSwarm", "Command")
POLICY_KEYS = {"schema", "approved_by", "independent_reviewer", "components"}
SOURCE_KEYS = {"repository_url", "commit_sha", "tree_sha", "branch"}
ACTOR_RE = re.compile(r"^[a-zA-Z0-9][a-zA-Z0-9._-]{2,79}$")
BRANCH_RE = re.compile(r"^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,99}$")
ORIGIN_RE = re.compile(
    r"^(?:https://github[.]com/|git@github[.]com:)"
    r"([A-Za-z0-9_.-]+)/([A-Za-z0-9_.-]+?)(?:[.]git)?$")
KEY_DER_PREFIX = bytes.fromhex("302a300506032b6570032100")

def _command(args:list[str])->bytes:
    env=dict(os.environ)
    env.update({"GIT_OPTIONAL_LOCKS":"0","GIT_CONFIG_NOSYSTEM":"1",
                "GIT_CONFIG_GLOBAL":os.devnull})
    try:
        result=subprocess.run(args,env=env,capture_output=True,check=False,timeout=20)
    except (OSError,subprocess.TimeoutExpired) as exc:
        raise EvidenceError("Read-only Git/crypto verifier unavailable") from exc
    if result.returncode:
        # Never print stderr, since a configured Git remote can contain a credential.
        raise EvidenceError("Read-only Git/crypto verification failed")
    return result.stdout

def _git(root:Path,*args:str)->bytes:
    return _command(["git","-C",str(root),*args])

def _policy(content:bytes)->dict:
    if type(content) is not bytes or not 0<len(content)<=8192:
        raise EvidenceError("Bounded source policy is required")
    try:
        obj=json.loads(content.decode("utf-8"),
            parse_constant=lambda _: (_ for _ in ()).throw(ValueError()))
    except (UnicodeError,TypeError,ValueError) as exc:
        raise EvidenceError("Invalid signed source JSON") from exc
    if (type(obj) is not dict or set(obj)!=POLICY_KEYS
            or obj["schema"]!=SCHEMA or canonical(obj)!=content):
        raise EvidenceError("Source policy must be canonical and exact")
    owner=obj["approved_by"]
    reviewer=obj["independent_reviewer"]
    if (type(owner) is not str or type(reviewer) is not str
            or not ACTOR_RE.fullmatch(owner) or not ACTOR_RE.fullmatch(reviewer)
            or owner==reviewer):
        raise EvidenceError("Distinct named owner and reviewer required")
    items=obj["components"]
    if type(items) is not dict or set(items)!=set(COMPONENTS):
        raise EvidenceError("All three source identities must be present")
    urls=set()
    for name in COMPONENTS:
        row=items[name]
        if type(row) is not dict or set(row)!=SOURCE_KEYS:
            raise EvidenceError("Missing pinned source fields")
        url,sha,tree,branch=(row[k] for k in
            ("repository_url","commit_sha","tree_sha","branch"))
        if (type(url) is not str or not CANONICAL_REPO_RE.fullmatch(url)
                or url in urls or type(sha) is not str or not SHA_RE.fullmatch(sha)
                or type(tree) is not str or not SHA_RE.fullmatch(tree)
                or type(branch) is not str or not BRANCH_RE.fullmatch(branch)
                or ".." in branch or "//" in branch or branch.endswith((".","/"))):
            raise EvidenceError("Noncanonical or duplicated pinned Git identity")
        urls.add(url)
    return obj

def _public_key_fingerprint(path:Path)->str:
    if path.is_symlink() or not path.is_file() or not 0<path.stat().st_size<=4096:
        raise EvidenceError("Explicit regular Ed25519 key required")
    der=_command(["openssl","pkey","-pubin","-in",str(path),"-outform","DER"])
    if len(der)!=44 or not der.startswith(KEY_DER_PREFIX):
        raise EvidenceError("Only Ed25519 public keys are valid")
    return sha256(der).hexdigest()

def _verify_signature(content:bytes,signature:bytes,key:Path,trust_sha256:str)->str:
    if (type(trust_sha256) is not str or not re.fullmatch(r"[0-9a-f]{64}",trust_sha256)
            or type(signature) is not bytes or len(signature)!=64):
        raise EvidenceError("Independent pinned Ed25519 fingerprint and signature required")
    actual=_public_key_fingerprint(key)
    if not hmac.compare_digest(actual,trust_sha256):
        raise EvidenceError("Untrusted policy signing key")
    with tempfile.TemporaryDirectory(prefix="titan-x01-") as folder:
        message=Path(folder)/"manifest.sha256"
        detached=Path(folder)/"signature.bin"
        message.write_bytes(sha256(content).digest())
        detached.write_bytes(signature)
        _command(["openssl","pkeyutl","-verify","-rawin","-pubin",
                  "-inkey",str(key),"-in",str(message),"-sigfile",str(detached)])
    return actual

def _valid_name(name:str)->bool:
    return (bool(name) and not name.startswith("/") and "\\" not in name
            and not any(ord(ch)<32 for ch in name)
            and all(segment and segment not in (".","..")
                    for segment in name.split("/")))

def inspect_checkout(name:str,root:Path,expected:dict)->dict:
    """Read a real, immutable HEAD tree and hash every checked out tracked file."""
    if name not in COMPONENTS or root.is_symlink() or not root.is_dir():
        raise EvidenceError("Unknown or unavailable component checkout")
    root=root.resolve(strict=True)
    sha=_git(root,"rev-parse","--verify","HEAD").decode("ascii").strip()
    tree=_git(root,"rev-parse","--verify","HEAD^{tree}").decode("ascii").strip()
    branch=_git(root,"symbolic-ref","-q","--short","HEAD").decode("utf-8").strip()
    if (sha!=expected["commit_sha"] or tree!=expected["tree_sha"]
            or branch!=expected["branch"]):
        raise EvidenceError("HEAD, Git tree or branch differs from signed baseline")
    remote=_git(root,"remote","get-url","origin").decode("utf-8").strip()
    found=ORIGIN_RE.fullmatch(remote)
    url="https://github.com/"+found[1]+"/"+found[2] if found else None
    if url!=expected["repository_url"]:
        raise EvidenceError("Git remote differs from signed source identity")
    if _git(root,"status","--porcelain=v1","-z","--untracked-files=all"):
        raise EvidenceError("Dirty or untracked Git checkout")
    raw=_git(root,"ls-tree","-r","-z","--full-tree","HEAD")
    if not 0<len(raw)<=8*1024*1024 or not raw.endswith(b"\0"):
        raise EvidenceError("Invalid Git tree list")
    entries=raw[:-1].split(b"\0")
    if len(entries)>10000:
        raise EvidenceError("Too many source files")
    manifest=[]
    source_count=0
    total=0
    for entry in entries:
        try:
            meta,p=entry.split(b"\t",1)
            mode,kind,object_id=meta.split(b" ")
            name_path=p.decode("utf-8")
            blob_sha=object_id.decode("ascii")
        except (ValueError,UnicodeError) as exc:
            raise EvidenceError("Invalid committed Git entry") from exc
        if (mode not in (b"100644",b"100755") or kind!=b"blob"
                or not SHA_RE.fullmatch(blob_sha) or not _valid_name(name_path)):
            raise EvidenceError("Symlink, submodule or unsafe path in committed tree")
        file=root/name_path
        if file.is_symlink() or not file.is_file():
            raise EvidenceError("Tracked source path is missing or a symlink")
        size=file.stat().st_size
        if size>16*1024*1024 or total+size>128*1024*1024:
            raise EvidenceError("Source exceeds safe inspection limits")
        payload=file.read_bytes()
        if len(payload)!=size:
            raise EvidenceError("Source changed while reading")
        git_blob=sha1(b"blob "+str(size).encode()+b"\0"+payload).hexdigest()
        if not hmac.compare_digest(git_blob,blob_sha):
            raise EvidenceError("Tracked bytes differ from immutable Git blob")
        total+=size
        if file.suffix.lower() in (".py",".ts",".tsx",".js",".jsx",".go",".rs",".c",".cpp",".java"):
            source_count+=1
        manifest.append({"path":name_path,"mode":mode.decode(),
                         "sha256":sha256(payload).hexdigest(),"git_blob":git_blob,
                         "bytes":size})
    if source_count<1:
        raise EvidenceError("No actual source code tracked")
    if (_git(root,"status","--porcelain=v1","-z","--untracked-files=all")
            or _git(root,"rev-parse","--verify","HEAD").decode("ascii").strip()!=sha):
        raise EvidenceError("Git sources changed mid-verification")
    return {"component":name,"repository_url":url,"commit_sha":sha,
            "tree_sha":tree,"branch":branch,"tracked_files":len(manifest),
            "source_files":source_count,"bytes_verified":total,
            "file_manifest_sha256":sha256(canonical(manifest)).hexdigest(),
            "working_tree_clean":True,"remote_verified_online":False}

def verify_canonical_sources(checkouts:Mapping[str,Path],policy:bytes,
                             signature:bytes,*,public_key:Path,
                             trusted_key_sha256:str)->dict:
    """Safe X01 local verification. Never claims product-level acceptance."""
    contract=_policy(policy)
    fingerprint=_verify_signature(policy,signature,Path(public_key),
                                  trusted_key_sha256)
    if not isinstance(checkouts,Mapping) or set(checkouts)!=set(COMPONENTS):
        raise EvidenceError("All three source checkouts are mandatory")
    roots=[]
    for name in COMPONENTS:
        path=Path(checkouts[name])
        if path.is_symlink() or not path.is_dir():
            raise EvidenceError("Missing TITAN source path")
        roots.append(path.resolve(strict=True))
    for i,root in enumerate(roots):
        for j,other in enumerate(roots):
            if i!=j and (root==other or root in other.parents or other in root.parents):
                raise EvidenceError("Source checkouts must be separate and non-nested")
    reports={name:inspect_checkout(name,roots[i],contract["components"][name])
             for i,name in enumerate(COMPONENTS)}
    return {"schema":"osgard.original180.titan-source-evidence/1",
            "task_id":"TITAN-X01",
            "signed_manifest_sha256":sha256(policy).hexdigest(),
            "pinned_ed25519_key_sha256":fingerprint,
            "policy_signature_valid":True,
            "components":reports,"source_bytes_verified":True,
            "owner_identity_verified_externally":False,
            "independently_accepted":False,"production_authorized":False,
            "status":"READY_FOR_INDEPENDENT_REVIEW"}

def main(argv=None)->int:
    ap=argparse.ArgumentParser(description="Read-only signed TITAN source baseline")
    for name in ("policy","signature","public-key","trusted-key-sha256",
                 "kraken","devswarm","command"):
        ap.add_argument("--"+name,required=True)
    options=ap.parse_args(argv)
    try:
        report=verify_canonical_sources(
            {"KRAKEN":Path(options.kraken),"DevSwarm":Path(options.devswarm),
             "Command":Path(options.command)},
            Path(options.policy).read_bytes(),Path(options.signature).read_bytes(),
            public_key=Path(options.public_key),
            trusted_key_sha256=options.trusted_key_sha256)
        print(json.dumps(report,sort_keys=True))
        return 0
    except (EvidenceError,OSError,TypeError) as exc:
        ap.exit(2,"TITAN_X01_FAIL_CLOSED: "+type(exc).__name__+"\n")

if __name__=="__main__":
    raise SystemExit(main())
