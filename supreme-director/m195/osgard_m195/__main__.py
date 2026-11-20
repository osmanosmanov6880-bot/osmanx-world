"""Run M195 locally: python -m osgard_m195 init|serve."""
import argparse
import json
import sys
from pathlib import Path
from .runtime import Director195
from .server import serve

def main(argv=None):
    p=argparse.ArgumentParser(description='OSGARD M195: local team work')
    sub=p.add_subparsers(dest='action',required=True)
    setup=sub.add_parser('init');setup.add_argument('--db',type=Path,required=True)
    setup.add_argument('--tenant',required=True);setup.add_argument('--actor',default='owner')
    run=sub.add_parser('serve');run.add_argument('--db',type=Path,required=True)
    run.add_argument('--port',type=int,default=8715)
    args=p.parse_args(argv)
    engine=Director195(args.db)
    if args.action=='init':
        if args.db.exists() or args.db.is_symlink():p.error('refusing overwrite of existing database')
        engine.initialize();identity=engine.provision(args.tenant,args.actor)
        print(json.dumps({'database':str(args.db),'tenant_id':identity['tenant_id'],
                          'one_time_owner_token':identity['token'],
                          'warning':'Keep credential private, no cloud connectivity'},indent=2))
        return 0
    if not args.db.is_file() or args.db.is_symlink():p.error('database missing or symlink')
    if not 0 < args.port < 65536:p.error('invalid port')
    engine.initialize()
    print(f'M195 studio: http://127.0.0.1:{args.port}/studio/',file=sys.stderr)
    serve(engine,args.port)
    return 0

if __name__=='__main__':raise SystemExit(main())
