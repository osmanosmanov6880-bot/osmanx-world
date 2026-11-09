"""TITAN-X03: actual CODEOWNERS path decision + mixed-owner diff gate.

CODEOWNERS names in this checkout establish ONLY local review candidates.
They do not grant canonical upstream ownership, independent approval or
a GitHub branch protection rule. Protected and cross-team paths fail closed.
"""
from __future__ import annotations
import argparse
import fnmatch
import json
from pathlib import Path,PurePosixPath
import re
from .gates import check_change_set,validate_codeowners
from .registry import EvidenceError,load_upstreams

OWNER_RE=re.compile(r"^@[A-Za-z0-9_.-]+$")
SAFE_PATTERN=re.compile(r"^(?:\*|/[A-Za-z0-9_.*?/-]+)$")

def _rules(root:Path)->list[tuple[str,tuple[str,...]]]:
    validate_codeowners(root)
    text=(Path(root)/".github/CODEOWNERS").read_text(encoding="utf-8")
    rules=[]
    for linenum,line in enumerate(text.splitlines(),1):
        line=line.strip()
        if not line or line.startswith("#"):continue
        parts=line.split()
        pattern=parts[0]
        if (not SAFE_PATTERN.fullmatch(pattern) or ".." in PurePosixPath(pattern).parts
            or "//" in pattern or not all(OWNER_RE.fullmatch(p) for p in parts[1:])):
            raise EvidenceError(f"Unsafe CODEOWNERS pattern or owner at {linenum}")
        rules.append((pattern,tuple(parts[1:])))
    return rules

def _applies(pattern:str,path:str)->bool:
    if pattern=="*":return True
    rel=pattern.lstrip("/")
    if rel.endswith("/"):return path.startswith(rel)
    if "*" not in rel and "?" not in rel:
        return path==rel or path.startswith(rel+"/")
    # GitHub's wildcard matching for this bounded subset: '*'/'?' may
    # match within a filename; anchors are always from repository root.
    return fnmatch.fnmatchcase(path,rel)

def inspect_changes(root:Path,changed_paths:list[str])->dict:
    root=Path(root)
    basic=check_change_set(root,changed_paths)
    rules=_rules(root)
    decisions=[]
    all_owners=set()
    for path in changed_paths:
        if (type(path) is not str or not path or "\\" in path or
            path.startswith("/") or "\x00" in path or
            ".." in PurePosixPath(path).parts or
            path.endswith("/") or "//" in path):
            raise EvidenceError("Unsafe changed Git path")
        owners=()
        matching=[]
        for pattern,people in rules:
            if _applies(pattern,path):
                owners=people
                matching.append(pattern)
        if not owners:
            raise EvidenceError("Unowned changed path "+path)
        all_owners.update(owners)
        decisions.append({"path":path,"matched_codeowners":matching,
                          "final_owners":list(owners)})
    independently_approved=False
    issues=set(basic["issues"])
    upstream=load_upstreams(root)["teams"]["TITAN"]
    if not upstream["owner_approved"]:
        issues.add("CANONICAL_TITAN_OWNER_APPROVAL_MISSING")
    if len(all_owners)>1:
        issues.add("MULTIPLE_LOCAL_CODEOWNERS_REQUIRE_REVIEW")
    return {"schema":"osgard.original180.titan-codeowners-review/1",
            "task_id":"TITAN-X03","decisions":decisions,
            "unique_local_owners":sorted(all_owners),
            "change_issues":sorted(issues),
            "local_changes_admissible":basic["admitted_for_local_nonproduction_development"],
            "status":"BLOCKED_UPSTREAM" if not upstream["owner_approved"]
                     else ("IN_PROGRESS" if issues else "READY_FOR_REVIEW"),
            "independent_reviewer_approval":False,
            "branch_protection_enforcement_verified":False,
            "production_authorized":False}

def main(argv=None):
    parser=argparse.ArgumentParser(description="TITAN-X03 scoped CODEOWNERS review")
    parser.add_argument("--root",type=Path,default=Path("."))
    parser.add_argument("--path",action="append",required=True)
    opt=parser.parse_args(argv)
    print(json.dumps(inspect_changes(opt.root,opt.path),sort_keys=True))
    return 0

if __name__=="__main__":
    raise SystemExit(main())
