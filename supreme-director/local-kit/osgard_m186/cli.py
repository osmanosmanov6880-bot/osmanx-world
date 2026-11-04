"""OSGARD M186 CLI: reference-contract simulator, not six live products."""
from __future__ import annotations
import argparse
import json
from pathlib import Path
import sys

from osgard_m184.storage import DirectorDB
from osgard_m185.review import ReviewDB
from .storage import LabDB
from .api import serve

BASE = Path(__file__).resolve().parents[1]
CATALOG = BASE/'templates/REFERENCE_CONTRACTS_M186.json'


def main(argv=None):
    parser=argparse.ArgumentParser(description='OSGARD M186 LOCAL REFERENCE ONLY / PRODUCTION NO-GO')
    sub=parser.add_subparsers(dest='command',required=True)
    for name in ('init','serve','doctor','summary','catalog','runs','run','inspect'):
        cmd=sub.add_parser(name)
        cmd.add_argument('--db',default=str(BASE/'runtime/m186.sqlite3'))
        cmd.add_argument('--root',default=str(BASE/'runtime/evidence'))
        cmd.add_argument('--catalog',default=str(CATALOG))
        if name=='serve':cmd.add_argument('--port',type=int,default=8765)
        if name=='run':
            cmd.add_argument('--scenario',choices=['LEARNING_PLATFORM','CREATOR_WORKSPACE','CITY_RESEARCH'],default='LEARNING_PLATFORM')
            cmd.add_argument('--operator',default='local-operator')
            cmd.add_argument('--budget-points',type=int,default=1200)
            cmd.add_argument('--inject-fault-at',default=None)
        if name=='inspect':cmd.add_argument('--run-id',required=True)
        if name=='init':
            cmd.add_argument('--plan',default=str(BASE/'docs/M182_WORKPLAN_180_PROPOSED.json'))
            cmd.add_argument('--conflicts',default=str(BASE/'templates/CONFLICTS_PROVISIONAL.json'))
            cmd.add_argument('--contracts',default=str(BASE/'templates/CONTRACTS_PROVISIONAL.json'))
            cmd.add_argument('--trust',default=str(BASE/'templates/TRUSTED_REVIEWERS_EMPTY.json'))
    args=parser.parse_args(argv)
    try:
        if args.command=='init':
            Path(args.db).parent.mkdir(parents=True,exist_ok=True)
            Path(args.root).mkdir(parents=True,exist_ok=True)
            original=DirectorDB(args.db).bootstrap(args.plan,args.conflicts,args.contracts)
            review=ReviewDB(args.db,args.root).review_bootstrap(args.trust)
            result={'parent':original,'review':review,'lab':LabDB(args.db,args.root,args.catalog).lab_bootstrap()}
        elif args.command=='serve':
            http,token=serve(args.db,args.root,args.catalog,BASE/'dashboard/m186',args.port)
            print(f'M186 REFERENCE LAB http://127.0.0.1:{http.server_port}',flush=True)
            print(f'LOCAL BEARER TOKEN: {token}',flush=True)
            print('REAL_INTEGRATIONS=0 / PRODUCTION_NO_GO / Ctrl+C to stop',flush=True)
            try:http.serve_forever(poll_interval=.2)
            except KeyboardInterrupt:pass
            finally:http.server_close()
            return 0
        else:
            db=LabDB(args.db,args.root,args.catalog)
            if args.command=='doctor':result=db.doctor()
            elif args.command=='summary':result=db.summary()
            elif args.command=='catalog':result=db.catalog()
            elif args.command=='runs':result=db.runs()
            elif args.command=='inspect':result=db.run_detail(args.run_id)
            elif args.command=='run':
                result=db.run_reference({'scenario':args.scenario,'operator':args.operator,
                    'budget_points':args.budget_points,'risk_profile':'PUBLIC_DEMO_ONLY',
                    'inject_fault_at':args.inject_fault_at})
            else:raise ValueError('unknown command')
        print(json.dumps(result,indent=2,ensure_ascii=False,sort_keys=True))
        return 2 if args.command=='doctor' and result['health'] != 'LOCAL_INTEGRITY_PASS' else 0
    except (ValueError,OSError,KeyError) as exc:
        print(f'M186 BLOCKED: {type(exc).__name__}: {exc}',file=sys.stderr)
        return 3

if __name__=='__main__':raise SystemExit(main())
