"""Run local finance studio: python -m osgard_m198 init|serve."""
import argparse
import json
import sys
from pathlib import Path
from .runtime import Director198
from .server import serve


def main(argv=None):
    parser=argparse.ArgumentParser(description='OSGARD M198 local project finance')
    sub=parser.add_subparsers(dest='action',required=True)
    init=sub.add_parser('init',help='Initialize new local database and issue one-time token')
    init.add_argument('--db',type=Path,required=True)
    init.add_argument('--tenant',required=True)
    init.add_argument('--actor',default='owner')
    run=sub.add_parser('serve',help='Start localhost-only finance studio')
    run.add_argument('--db',type=Path,required=True)
    run.add_argument('--port',type=int,default=8718)
    args=parser.parse_args(argv)
    app=Director198(args.db)
    if args.action=='init':
        if args.db.exists() or args.db.is_symlink():
            parser.error('refusing to overwrite an existing SQLite database')
        app.initialize();credentials=app.provision(args.tenant,args.actor)
        print(json.dumps({'database':str(args.db),'tenant':credentials['tenant_id'],
                          'one_time_token':credentials['token'],'production':False,
                          'notice':'Do not commit or share the token.'},ensure_ascii=False,indent=2))
        return 0
    if not args.db.is_file() or args.db.is_symlink() or not 1<=args.port<=65535:
        parser.error('database must be existing regular file; valid TCP port required')
    app.initialize()
    print(f'OSGARD M198 local finance: http://127.0.0.1:{args.port}/finance/',file=sys.stderr)
    serve(app,port=args.port)
    return 0

if __name__=='__main__':raise SystemExit(main())
