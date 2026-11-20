"""Local-only startup for M194; does not authorize production deployment."""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from .runtime import Director194
from .server import serve


def main(argv=None):
    p = argparse.ArgumentParser(description=__doc__)
    sub = p.add_subparsers(dest='action', required=True)
    init = sub.add_parser('init', help='initialize a new local tenant database')
    init.add_argument('--db', type=Path, required=True)
    init.add_argument('--tenant', required=True)
    init.add_argument('--actor', default='owner')
    run = sub.add_parser('serve', help='start the Russian CRM studio on loopback')
    run.add_argument('--db', type=Path, required=True)
    run.add_argument('--port', type=int, default=8714)
    args = p.parse_args(argv)
    app = Director194(args.db)
    if args.action == 'init':
        if args.db.exists() or args.db.is_symlink():
            p.error('refusing to overwrite an existing database')
        app.initialize()
        credentials = app.provision(args.tenant, args.actor)
        print(json.dumps({'local_database': str(args.db), 'tenant_id': credentials['tenant_id'],
                          'one_time_owner_token': credentials['token'],
                          'warning': 'Keep token private. Local-only service, no production actions.'}, indent=2))
        return 0
    if not args.db.is_file() or args.db.is_symlink():
        p.error('database missing or is a symlink')
    if not 0 < args.port < 65536:
        p.error('port outside 1..65535')
    app.initialize()
    print(f'M194 Russian CRM: http://127.0.0.1:{args.port}/studio/', file=sys.stderr)
    serve(app, args.port)
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
