"""Task-by-task original 180 audit, with explicit absence of integration proof."""
from __future__ import annotations

from collections import Counter
from hashlib import sha256
import json
from pathlib import Path

from .registry import EvidenceError, load_original, load_upstreams, root_from_module

HOLD_SCOPE = frozenset(f'EXPERIENCE-X{i:02}' for i in range(13,17))
HOLD_MISSING = frozenset(f'EXPERIENCE-X{i:02}' for i in range(21,25))


def _exists(root: Path, name: str) -> bool:
    p = Path(name)
    return not p.is_absolute() and '..' not in p.parts and (root / p).is_file()


def audit_original(root: Path) -> dict:
    root = Path(root)
    original = load_original(root)
    upstreams = load_upstreams(root)
    mapping_path = root / 'supreme-director/campaign180/data/EVIDENCE_MAP.json'
    mapping = json.loads(mapping_path.read_text(encoding='utf-8'))
    mapped = mapping['related_local_paths']
    ids = {t['id'] for t in original['tasks']}
    if not isinstance(mapped, dict) or any(tid not in ids for tid in mapped):
        raise EvidenceError('Evidence map refers to task not in original master')
    for tid, names in mapped.items():
        if not isinstance(names, list) or not names or len(set(names)) != len(names):
            raise EvidenceError('Evidence map paths must be unique nonempty arrays')
        for name in names:
            if type(name) is not str or not _exists(root, name):
                raise EvidenceError('Evidence path does not exist: ' + tid + ':' + str(name))
    entries = []
    for task in original['tasks']:
        tid = task['id']
        files = mapped.get(tid, [])
        if tid in HOLD_SCOPE:
            status,reason = 'HOLD_SCOPE_EXCLUDED','SkillCred scope excluded in historical handoff.'
        elif tid in HOLD_MISSING:
            status,reason = 'HOLD_SOURCE_MISSING','No verified Noor product upstream source.'
        elif files:
            status,reason = 'RELATED_LOCAL_CODE_NOT_ACCEPTED', (
                'Nearby local source is present but original product integration, '
                'full acceptance criteria and independent review are not proven.')
        else:
            status,reason = 'NO_DIRECT_PROOF', (
                'No verified code-to-task link; canonical upstream and owner consent missing.')
        entries.append({'id':tid,'ordinal':task['ordinal'],'team':task['team'],
                        'priority':task['priority'],'title':task['title'],
                        'original_status':task['original_status'],
                        'original_source_line':task['source_line'],
                        'related_local_paths':files,
                        'implementation_evidence_status':status,
                        'evidence_limit':reason,
                        'upstream_owner_approved': bool(upstreams['teams'][task['team']]['owner_approved']),
                        'independently_accepted':False,
                        'production_accepted':False})
    counts=Counter(x['implementation_evidence_status'] for x in entries)
    if len(entries)!=180 or len(set(x['id'] for x in entries))!=180:
        raise EvidenceError('Audit coverage of original 180 is incomplete')
    return {'schema':'osgard.original180.audit/2',
            'original_master_sha256':original['original_master_sha256'],
            'source_registry':'supreme-director/recovery/ORIGINAL_180_TASKS.json',
            'related_repo':'osmanosmanov6880-bot/osmanx-world',
            'reviewer_assigned':False,
            'counts': {'total':len(entries),'independently_accepted':0,
                       'production_accepted':0,
                       'related_local_unaccepted':counts['RELATED_LOCAL_CODE_NOT_ACCEPTED'],
                       'no_direct_proof':counts['NO_DIRECT_PROOF'],
                       'hold_scope_excluded':counts['HOLD_SCOPE_EXCLUDED'],
                       'hold_source_missing':counts['HOLD_SOURCE_MISSING'],
                       'upstream_approved':sum(1 for t in upstreams['teams'].values()
                                                if t['owner_approved'])},
            'source_readiness':'BLOCKED_SIX_UPSTREAMS',
            'task_ledger':entries}


def report_markdown(report: dict) -> str:
    c=report['counts']
    lines=['# OSGARD SUPREME DIRECTOR - audit of original 180 tasks','',
           'Original master SHA-256: `'+report['original_master_sha256']+'`.','',
           '**Independent acceptance: 0/180. Local evidence is not independent integration acceptance.**','',
           f"Related local code only: {c['related_local_unaccepted']} | No direct proof: {c['no_direct_proof']} | Scope hold: {c['hold_scope_excluded']} | Source hold: {c['hold_source_missing']}",
           '', '| ID | P | Original title | Code evidence | Audit state |',
           '|---|---|---|---|---|']
    for item in report['task_ledger']:
        ev=', '.join('`'+x+'`' for x in item['related_local_paths']) or '-'
        lines.append('| '+item['id']+' | '+item['priority']+' | '+item['title'].replace('|','/')+
                     ' | '+ev+' | '+item['implementation_evidence_status']+' |')
    lines += ['', 'No official task is closed by this report; do not merge or deploy without independent gate.', '']
    return '\n'.join(lines)


def save_reports(root: Path, out_dir: Path) -> dict:
    report=audit_original(root)
    out_dir=Path(out_dir)
    out_dir.mkdir(parents=True,exist_ok=True)
    (out_dir/'audit_180.json').write_text(json.dumps(report,ensure_ascii=False,
                                   sort_keys=True,indent=2)+'\n',encoding='utf-8')
    (out_dir/'audit_180.md').write_text(report_markdown(report),encoding='utf-8')
    return report
