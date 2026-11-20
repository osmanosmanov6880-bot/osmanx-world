"""Local-only command line setup and server for M193."""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from .runtime import Director193
from .server import serve


def main(argv=None):
    p = argparse.ArgumentParser(description=__doc__)
    sub = p.add_subparsers(dest='action',required=True)
    init = sub.add_parser('init',help='create a NEW local database and owner credential')
    init.add_argument('--db',type=Path,required=True)
    init.add_argument('--tenant',required=True)
    init.add_argument('--actor',default='owner')
    run = sub.add_parser('serve',help='serve local-only CRM studio')
    run.add_argument('--db',type=Path,required=True)
    run.add_argument('--port',type=int,default=8713)
    args = p.parse_args(argv)
    app = Director193(args.db)
    if args.action == 'init':
        if args.db.exists() or args.db.is_symlink():
            p.error('refusing to initialize over an existing database')
        app.initialize()
        token = app.provision(args.tenant,args.actor)
        print(json.dumps({'local_database':str(args.db),'tenant_id':token['tenant_id'],
                          'one_time_owner_token':token['token'],
                          'instructions':'Do not paste token into logs or public issues; no cloud access'},indent=2))
        return 0
    if not args.db.is_file():
        p.error('database not found; run init first')
    if not 0 < args.port < 65536:
        p.error('invalid TCP port')
    app.initialize()  # idempotent migrations for existing M192 databases
    print('M193 local studio: http://127.0.0.1:' + str(args.port) + '/studio/',file=sys.stderr)
    serve(app,args.port)
    return 0

if __name__ == '__main__':
    raise SystemExit(main())
