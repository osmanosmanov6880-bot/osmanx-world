"""python -m osgard_m199 init|serve --db PATH [--tenant NAME]"""
import argparse
import json
from pathlib import Path
from .runtime import Director199
from .server import serve


def main(argv=None):
    parser = argparse.ArgumentParser(description='OSGARD M199 portfolio finance (local only)')
    subs = parser.add_subparsers(dest='action', required=True)
    init = subs.add_parser('init')
    init.add_argument('--db', type=Path, required=True)
    init.add_argument('--tenant', required=True)
    init.add_argument('--actor', default='owner')
    run = subs.add_parser('serve')
    run.add_argument('--db', type=Path, required=True)
    run.add_argument('--port', type=int, default=8719)
    args = parser.parse_args(argv)
    app = Director199(args.db)
    if args.action == 'init':
        if args.db.exists() or args.db.is_symlink():
            parser.error('refusing to overwrite existing SQLite data')
        app.initialize()
        creds = app.provision(args.tenant, args.actor)
        print(json.dumps({'database': str(args.db), 'tenant': creds['tenant_id'],
                          'one_time_token': creds['token'], 'production': False,
                          'warning': 'Do not publish or commit this token.'},
                         ensure_ascii=False, indent=2))
        return 0
    if not args.db.is_file() or args.db.is_symlink() or not 1 <= args.port <= 65535:
        parser.error('existing regular database file and valid port required')
    app.initialize()
    print(f'OSGARD M199 local portfolio: http://127.0.0.1:{args.port}/portfolio/')
    serve(app, port=args.port)
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
