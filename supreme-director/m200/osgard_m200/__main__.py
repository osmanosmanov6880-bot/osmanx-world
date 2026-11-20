"""Run local M200: python -m osgard_m200 init|serve --db PATH."""
import argparse
import json
from pathlib import Path
from .runtime import Director200
from .server import serve

def main(argv=None):
    p=argparse.ArgumentParser(description='OSGARD M200 cashflow, local only')
    sub=p.add_subparsers(dest='action',required=True)
    init=sub.add_parser('init')
    init.add_argument('--db',type=Path,required=True)
    init.add_argument('--tenant',required=True)
    init.add_argument('--actor',default='owner')
    run=sub.add_parser('serve')
    run.add_argument('--db',type=Path,required=True)
    run.add_argument('--port',type=int,default=8720)
    a=p.parse_args(argv)
    engine=Director200(a.db)
    if a.action=='init':
        if a.db.exists() or a.db.is_symlink():
            p.error('existing database may not be overwritten')
        engine.initialize()
        creds=engine.provision(a.tenant,a.actor)
        print(json.dumps({'db':str(a.db),'tenant_id':creds['tenant_id'],
                          'one_time_token':creds['token'],'production':False},
                         ensure_ascii=False,indent=2))
        return 0
    if not a.db.is_file() or a.db.is_symlink() or not 1<=a.port<=65535:
        p.error('valid existing database and TCP port required')
    engine.initialize()
    print(f'Local cashflow UI: http://127.0.0.1:{a.port}/cashflow/')
    serve(engine,a.port)
    return 0

if __name__=='__main__':
    raise SystemExit(main())
