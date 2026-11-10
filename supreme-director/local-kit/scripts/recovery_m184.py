"""Test a REAL SQLite backup/restore of synthetic local audit state."""
from __future__ import annotations
from contextlib import closing
import hashlib
import json
from pathlib import Path
import sqlite3
import sys
import tempfile

BASE=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(BASE))
from osgard_m184.storage import DirectorDB


def run():
    with tempfile.TemporaryDirectory() as temp:
        root=Path(temp)
        live=DirectorDB(root/'live.sqlite3')
        live.bootstrap(BASE/'docs/M182_WORKPLAN_180_PROPOSED.json',BASE/'templates/CONFLICTS_PROVISIONAL.json',
                       BASE/'templates/CONTRACTS_PROVISIONAL.json',BASE/'docs/m183/CURRENT_GITHUB_DEFAULT_BRANCH_OBSERVATIONS_2026-10-27.json')
        live.add_note('task','M182-TITAN-A01','recovery-qa','synthetic recovery marker')
        live.triage_conflict('M181-CONFLICT-01','TRIAGED','recovery-qa','provisional conflict only')
        assert live.doctor()['health']=='LOCAL_INTEGRITY_PASS'
        with closing(sqlite3.connect(str(live.path))) as src, closing(sqlite3.connect(str(root/'backup.sqlite3'))) as dst:
            src.backup(dst)
        digest=hashlib.sha256((root/'backup.sqlite3').read_bytes()).hexdigest()
        live.path.unlink()  # simulated loss of local synthetic DB, NOT a production DB
        recovered=DirectorDB(root/'backup.sqlite3')
        result=recovered.doctor()
        summary=recovered.summary()
        assert result['health']=='LOCAL_INTEGRITY_PASS'
        assert summary['counts']['notes']==2 and summary['counts']['audit']==3
        assert summary['counts']['tasks']==180 and summary['release']=='PRODUCTION_NO_GO'
        output={'scenario':'SYNTHETIC_SQLITE_BACKUP_RESTORE',
                'state':'PASS','notes_restored':2,'audit_events_restored':3,
                'backup_sha256':digest,'doctor':result,'production_rto_rpo_measured':False,
                'multi_host_restore':False}
    (BASE/'evidence/m184/SQLITE_RECOVERY_TEST.json').write_text(json.dumps(output,indent=2)+'\n')
    print(json.dumps(output))

if __name__=='__main__':run()
