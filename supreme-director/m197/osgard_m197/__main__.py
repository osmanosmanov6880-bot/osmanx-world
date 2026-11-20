"""CLI: python -m osgard_m197 init|serve --db path."""
import argparse
import json
import sys
from pathlib import Path
from .runtime import Director197
from .server import serve


def main(argv=None):
    parser = argparse.ArgumentParser(description='OSGARD M197 local project cards')
    sub = parser.add_subparsers(dest='action',required=True)
    init=sub.add_parser('init')
    init.add_argument('--db',type=Path,required=True)
    init.add_argument('--tenant',required=True)
    init.add_argument('--actor',default='owner')
    run=sub.add_parser('serve')
    run.add_argument('--db',type=Path,required=True)
    run.add_argument('--port',type=int,default=8717)
    args=parser.parse_args(argv)
    app=Director197(args.db)
    if args.action=='init':
        if args.db.exists() or args.db.is_symlink():
            parser.error('refusing to overwrite an existing database')
        app.initialize()
        creds=app.provision(args.tenant,args.actor)
        print(json.dumps({'db':str(args.db),'tenant_id':creds['tenant_id'],
                          'one_time_owner_token':creds['token'],
                          'production':False,'notice':'Do not commit credentials.'},indent=2))
        return 0
    if not args.db.is_file() or args.db.is_symlink():
        parser.error('database missing or symlink')
    if not 0<args.port<65536:
        parser.error('invalid port')
    app.initialize()
    print('M197 local studio: http://127.0.0.1:'+str(args.port)+'/studio/',file=sys.stderr)
    serve(app,port=args.port)
    return 0

if __name__=='__main__':
    raise SystemExit(main())
