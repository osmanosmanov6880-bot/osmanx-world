"""P0 review gates: canonical CODEOWNERS, isolated team changes, dependencies.

Gate is read-only and cannot approve products, dispatch work, or merge Git.
"""
from __future__ import annotations

import json
from pathlib import Path
import re

from .registry import EvidenceError, TEAMS, git_files, repository_inventory, load_upstreams

OWNER = '@osmanosmanov6880-bot'
REQUIRED_RULES = ('*', '/.github/', '/supreme-director/originals/',
                  '/supreme-director/recovery/', '/supreme-director/campaign180/')
SENSITIVE_RE = re.compile(r'(^|/)(\.env(?:\..*)?|id_rsa|id_ed25519|.*\.(?:pem|p12|pfx|key))$', re.I)


def validate_codeowners(root: Path) -> dict:
    path=Path(root)/'.github/CODEOWNERS'
    if not path.is_file():
        raise EvidenceError('Missing CODEOWNERS')
    items={}
    for i,line in enumerate(path.read_text(encoding='utf-8').splitlines(),1):
        cleaned=line.strip()
        if not cleaned or cleaned.startswith('#'):
            continue
        fields=cleaned.split()
        if len(fields)<2 or not fields[0].startswith(('/', '*')):
            raise EvidenceError('Bad CODEOWNERS line ' + str(i))
        if fields[0] in items:
            raise EvidenceError('Conflicting duplicate CODEOWNERS rule ' + fields[0])
        if OWNER not in fields[1:]:
            raise EvidenceError('Unknown or missing repository owner at line ' + str(i))
        items[fields[0]]=fields[1:]
    if any(x not in items for x in REQUIRED_RULES):
        raise EvidenceError('Required ownership guard missing')
    return {'validated':True,'owner':OWNER,'rules':sorted(items),
            'independent_reviewer_established':False}


def owner_for(path: str) -> str | None:
    parts=Path(path).parts
    if len(parts)>=2 and parts[0]=='sources' and parts[1] in TEAMS:
        return parts[1]
    if len(parts)>=4 and parts[:3]==('supreme-director','local-kit','sources') and parts[3] in TEAMS:
        return parts[3]
    return None


def check_change_set(root: Path, changed_paths: list[str]) -> dict:
    validate_codeowners(root)
    if type(changed_paths) is not list:
        raise EvidenceError('Changed paths must be a list')
    teams=set()
    forbidden=[]
    sensitive=[]
    protected=[]
    for path in changed_paths:
        if not isinstance(path,str) or not path or '\x00' in path:
            raise EvidenceError('Malformed changed file path')
        p=Path(path)
        if p.is_absolute() or '..' in p.parts:
            raise EvidenceError('Path traversal in change set')
        owner=owner_for(path)
        if owner:
            teams.add(owner)
            forbidden.append(path)
        if SENSITIVE_RE.search(path):
            sensitive.append(path)
        if path.startswith(('supreme-director/originals/',
                            'supreme-director/recovery/')):
            protected.append(path)
    issues=[]
    if len(teams)>1:
        issues.append('CROSS_TEAM_WRITE_WITHOUT_INDEPENDENT_REVIEW')
    if forbidden:
        issues.append('UNVERIFIED_UPSTREAM_PRODUCT_SOURCE_WRITE')
    if sensitive:
        issues.append('SENSITIVE_PATH_CHANGE')
    if protected:
        issues.append('ORIGINAL_SOURCE_MODIFICATION_REQUIRES_OWNER_REVIEW')
    return {'schema':'osgard.original180.change-gate/1',
            'changed_files':len(changed_paths),
            'team_source_owners':sorted(teams),
            'issues':sorted(set(issues)),
            'admitted_for_local_nonproduction_development':not issues,
            'independent_product_approval':False,
            'original_task_acceptance_authorized':False,
            'production_deploy_authorized':False}


def dependency_risks(root: Path) -> dict:
    """Read tracked manifests; do not resolve/download/install dependencies."""
    root=Path(root)
    inventory=repository_inventory(root)
    concerns=[]
    manifest_set={x['path'] for x in inventory['dependency_manifests']}
    for path in sorted(manifest_set):
        filename=Path(path).name.lower()
        text=(root/path).read_text(encoding='utf-8')
        if filename.startswith('requirements') and filename.endswith('.txt'):
            for i,line in enumerate(text.splitlines(),1):
                raw=line.strip()
                if not raw or raw.startswith('#') or raw.startswith('-'):
                    continue
                if '==' not in raw and '@' not in raw:
                    concerns.append({'path':path,'line':i,'rule':'UNPINNED_REQUIREMENT'})
        elif filename=='package.json':
            cfg=json.loads(text)
            for bucket in ('dependencies','devDependencies'):
                for dep,ref in cfg.get(bucket,{}).items():
                    if (not isinstance(ref,str) or not re.match(r'^\d+\.\d+\.\d+(?:[-+].+)?$',ref)):
                        concerns.append({'path':path,'dependency':dep,
                                         'rule':'FLOATING_PACKAGE_VERSION'})
    if inventory['tracked_sensitive_path_flags']:
        concerns.append({'rule':'SENSITIVE_TRACKED_FILES',
                         'paths':inventory['tracked_sensitive_path_flags']})
    if not inventory['dependency_manifests']:
        concerns.append({'rule':'NO_TRACKED_PACKAGE_MANIFESTS',
                         'note':'Cannot claim dependency reproducibility'})
    return {'schema':'osgard.original180.dependency-risk/1',
            'manifests_scanned':len(inventory['dependency_manifests']),
            'risks':concerns,'network_installs':False,
            'licenses_independently_verified':False,
            'complete_dependency_recovery_proven':False}


def enforce_local_gate(root: Path, paths: list[str]) -> dict:
    changes=check_change_set(root, paths)
    deps=dependency_risks(root)
    upstreams=load_upstreams(Path(root))
    return {'change_set':changes,'dependency_scan':deps,
            'all_six_upstreams_approved':all(x.get('owner_approved') is True
                        for x in upstreams['teams'].values()),
            'local_ci_can_run':changes['admitted_for_local_nonproduction_development'],
            'product_merge_allowed':False, 'production_allowed':False}
