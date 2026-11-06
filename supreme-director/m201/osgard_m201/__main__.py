"""python -m osgard_m201 init|serve --db PATH, local only."""
import argparse
import json
from pathlib import Path
from .runtime import Director201
from .server import serve

def main(argv=None):
    p=argparse.ArgumentParser(description='OSGARD M201 local financial risk center')
    actions=p.add_subparsers(dest='action',required=True)
    init=actions.add_parser('init')
    init.add_argument('--db',type=Path,required=True)
    init.add_argument('--tenant',required=True)
    init.add_argument('--actor',default='owner')
    run=actions.add_parser('serve')
    run.add_argument('--db',type=Path,required=True)
    run.add_argument('--port',type=int,default=8721)
    a=p.parse_args(argv)
    engine=Director201(a.db)
    if a.action=='init':
        if a.db.exists() or a.db.is_symlink():
            p.error('refusing to overwrite existing database')
        engine.initialize()
        secret=engine.provision(a.tenant,a.actor)
        print(json.dumps({
            'db':str(a.db),'tenant_id':secret['tenant_id'],
            'one_time_owner_token':secret['token'],
            'production':False,'warning':'Keep token outside repository.'
        },ensure_ascii=False,indent=2))
        return 0
    if not a.db.is_file() or a.db.is_symlink() or not 1<=a.port<=65535:
        p.error('expected existing regular SQLite file and port from 1 to 65535')
    engine.initialize()
    print(f'M201 local risk center: http://127.0.0.1:{a.port}/risks/')
    serve(engine,port=a.port)
    return 0

if __name__=='__main__':
    raise SystemExit(main())
