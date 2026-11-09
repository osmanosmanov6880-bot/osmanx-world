"""TITAN-X01: exact, read-only Git source baseline. No guessed upstreams.

An accessible Git checkout is NOT automatically KRAKEN/DevSwarm/Command.
The only canonical identity is the owner-approved registry, with a pinned
40-char source commit and independent reviewer. Missing sources are BLOCKED.
No network, checkout mutation, merge, deployment, or privileged operation.
"""
from __future__ import annotations
import argparse
import json
from pathlib import Path
import re
import subprocess
from .registry import EvidenceError, SHA_RE, load_upstreams, git_files

HEX=re.compile(r"^[a-f0-9]{40}$")
REMOTE=re.compile(r"^(?:https://github\.com/|git@github\.com:)([A-Za-z0-9_.-]+)/([A-Za-z0-9_.-]+?)(?:\.git)?$")

def _git(root:Path,*args:str,allow_missing:bool=False)->str|None:
    try:
        p=subprocess.run(["git","-C",str(root),*args],capture_output=True,
                         text=True,timeout=15,check=False)
    except (OSError,subprocess.TimeoutExpired) as exc:
        raise EvidenceError("Git baseline inspection unavailable") from exc
    if p.returncode:
        if allow_missing:return None
        raise EvidenceError("Git baseline operation failed")
    return p.stdout.strip()

def snapshot(root:Path)->dict:
    root=Path(root).resolve()
    if not root.is_dir():raise EvidenceError("Git working directory missing")
    sha=_git(root,"rev-parse","--verify","HEAD")
    tree=_git(root,"rev-parse","--verify","HEAD^{tree}")
    if not HEX.fullmatch(sha) or not HEX.fullmatch(tree):
        raise EvidenceError("Git SHA/tree not immutable hex-40")
    branch=_git(root,"symbolic-ref","-q","--short","HEAD",allow_missing=True)
    origin=_git(root,"remote","get-url","origin",allow_missing=True)
    # Never print any remote with embedded credentials. Only normalized
    # GitHub paths are returned; other remote formats are unknown/blocked.
    m=REMOTE.fullmatch(origin or "")
    public_remote=(f"https://github.com/{m[1]}/{m[2]}" if m else None)
    tracked=git_files(root)
    tracked_set=set(tracked)
    dirty=_git(root,"status","--porcelain=v1","--untracked-files=no")
    upstream=load_upstreams(root)["teams"]["TITAN"]
    approved=upstream["owner_approved"] is True
    actual=[name for name in ("KRAKEN","DevSwarm","Command")
            if any(p.startswith(name+"/") or p.startswith("sources/TITAN/"+name+"/")
                   for p in tracked_set)]
    matches=(approved and upstream["repository_url"]==public_remote
            and upstream["commit_sha"]==sha and not dirty and
            len(actual)==3)
    blockers=[]
    if not approved:blockers.append("UPSTREAM_OWNER_APPROVAL_MISSING")
    if not public_remote:blockers.append("CANONICAL_GITHUB_REMOTE_UNPROVEN")
    if approved and upstream["repository_url"]!=public_remote:
        blockers.append("APPROVED_REPOSITORY_DIFFERENT_FROM_CHECKOUT")
    if approved and upstream["commit_sha"]!=sha:
        blockers.append("APPROVED_COMMIT_DIFFERENT_FROM_CHECKOUT")
    if dirty:blockers.append("TRACKED_WORKTREE_DIRTY")
    if len(actual)!=3:blockers.append("KRAKEN_DEVSWARM_COMMAND_SOURCES_INCOMPLETE")
    return {"schema":"osgard.original180.titan-git-baseline/1",
            "task_id":"TITAN-X01","checkout_commit":sha,"checkout_tree":tree,
            "checkout_branch":branch,"origin_normalized":public_remote,
            "tracked_files":len(tracked),"source_roots_present":actual,
            "canonical_titan_upstream":upstream["repository_url"] if approved else None,
            "canonical_titan_sha":upstream["commit_sha"] if approved else None,
            "source_dirty":bool(dirty),
            "status":"READY_FOR_REVIEW" if matches else "BLOCKED_UPSTREAM",
            "blockers":sorted(set(blockers)),
            "independently_accepted":False,"production_authorized":False}

def main(argv=None):
    parser=argparse.ArgumentParser(description="Read-only TITAN-X01 Git baseline")
    parser.add_argument("--root",type=Path,default=Path("."))
    parser.add_argument("--output",type=Path)
    opts=parser.parse_args(argv)
    result=snapshot(opts.root)
    if opts.output:
        if opts.output.exists():raise EvidenceError("Refusing baseline overwrite")
        opts.output.write_text(json.dumps(result,indent=2,sort_keys=True)+"\n")
    print(json.dumps(result,sort_keys=True))
    return 0

if __name__=="__main__":
    raise SystemExit(main())
