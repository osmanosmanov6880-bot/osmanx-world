"""Fresh isolated reference-flow acceptance; no real products or external calls."""
from __future__ import annotations
import json
from pathlib import Path
import sys
import tempfile

BASE=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(BASE))
from osgard_m184.storage import DirectorDB
from osgard_m185.review import ReviewDB
from osgard_m186.storage import LabDB


def main():
    with tempfile.TemporaryDirectory() as temp:
        root=Path(temp);evidence=root/'evidence';evidence.mkdir();db=root/'director.sqlite3'
        DirectorDB(db).bootstrap(BASE/'docs/M182_WORKPLAN_180_PROPOSED.json',
            BASE/'templates/CONFLICTS_PROVISIONAL.json',BASE/'templates/CONTRACTS_PROVISIONAL.json')
        ReviewDB(db,evidence).review_bootstrap(BASE/'templates/TRUSTED_REVIEWERS_EMPTY.json')
        studio=LabDB(db,evidence,BASE/'templates/REFERENCE_CONTRACTS_M186.json')
        studio.lab_bootstrap()
        original={'scenario':'LEARNING_PLATFORM','operator':'synthetic-smoke','budget_points':4200,
                  'risk_profile':'PUBLIC_DEMO_ONLY','inject_fault_at':None}
        good=studio.run_reference(original)
        bad=studio.run_reference({**original,'inject_fault_at':'CONTRACT-05'})
        doctor=studio.doctor()
        summary=studio.summary()
        assert good['result']['outcome']=='REFERENCE_FLOW_COMPLETE' and len(good['result']['steps'])==9
        assert bad['result']['outcome']=='BLOCKED_REFERENCE_CONTRACT' and len(bad['result']['steps'])==5
        assert doctor['health']=='LOCAL_INTEGRITY_PASS' and summary['independent_acceptance']==0
        assert summary['real_integrations']==0 and summary['release']=='PRODUCTION_NO_GO'
        out={'schema':'osgard.m186.smoke-qa/1','db_recreated':True,
             'healthy_reference_run_sha256':good['report_sha256'],
             'healthy_reference_contract_steps':len(good['result']['steps']),
             'blocked_reference_run_sha256':bad['report_sha256'],
             'blocked_contract_step':bad['result']['steps'][-1]['contract_id'],
             'local_doctor':doctor['health'],'synthetic_runs':summary['reference_runs'],
             'original_task_acceptance':0,'actual_upstreams':0,
             'production':'NO_GO','outcome':'LOCAL_REFERENCE_STAND_PASS'}
        (BASE/'evidence/m186/M186_FRESH_SMOKE.json').write_text(json.dumps(out,sort_keys=True,indent=2)+'\n')
        print(json.dumps(out,ensure_ascii=False,sort_keys=True))
        return 0

if __name__=='__main__':raise SystemExit(main())
