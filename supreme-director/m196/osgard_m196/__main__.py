"""OSGARD Supreme Director M196 local CLI.

python -m osgard_m196 init --db /tmp/osgard-m196.db --tenant 'Example Company'
python -m osgard_m196 serve --db /tmp/osgard-m196.db --port 8716
"""
import argparse
import json
import sys
from pathlib import Path
from .runtime import Director196
from .server import serve

def main(argv=None):
    parser = argparse.ArgumentParser(description='OSGARD M196 project & task delivery studio')
    sub = parser.add_subparsers(dest='action',required=True)
    init = sub.add_parser('init')
    init.add_argument('--db',type=Path,required=True)
    init.add_argument('--tenant',required=True)
    init.add_argument('--actor',default='owner')
    run = sub.add_parser('serve')
    run.add_argument('--db',type=Path,required=True)
    run.add_argument('--port',type=int,default=8716)
    args=parser.parse_args(argv)
    app = Director196(args.db)
    if args.action=='init':
        if args.db.exists() or args.db.is_symlink():
            parser.error('refusing overwrite; use serve on existing database')
        app.initialize()
        credentials = app.provision(args.tenant,args.actor)
        print(json.dumps({'db':str(args.db), 'tenant_id':credentials['tenant_id'],
                          'one_time_owner_token':credentials['token'],
                          'note':'Local only: store token outside repository.'},indent=2))
        return 0
    if not args.db.is_file() or args.db.is_symlink():
        parser.error('database missing or symlink')
    if not 0 < args.port < 65536:
        parser.error('invalid port')
    app.initialize()
    print('M196 local studio: http://127.0.0.1:'+str(args.port)+'/studio/',file=sys.stderr)
    serve(app,args.port)
    return 0

if __name__ == '__main__':
    raise SystemExit(main())
