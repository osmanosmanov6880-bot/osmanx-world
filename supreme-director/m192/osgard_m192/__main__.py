"""CLI entry point. Never enables public bind or production actions."""
from __future__ import annotations
import argparse
import json
import sys
from pathlib import Path
from .runtime import Director, DirectorError
from .server import serve


def main(argv=None):
    parser=argparse.ArgumentParser(prog='osgard_m192',description='OSGARD M192 local reference runtime')
    parser.add_argument('--db',type=Path,default=Path('osgard_m192_local.sqlite'))
    sub=parser.add_subparsers(dest='command',required=True)
    sub.add_parser('init')
    provision=sub.add_parser('provision')
    provision.add_argument('--tenant',required=True)
    provision.add_argument('--actor',required=True)
    provision.add_argument('--ttl',type=int,default=86400)
    issue=sub.add_parser('issue-token')
    issue.add_argument('--owner-token',required=True)
    issue.add_argument('--actor',required=True)
    issue.add_argument('--role',required=True,choices=('owner','operator','viewer'))
    issue.add_argument('--ttl',type=int,default=86400)
    start=sub.add_parser('serve')
    start.add_argument('--port',type=int,default=8712)
    args=parser.parse_args(argv)
    app=Director(args.db)
    try:
        if args.command=='init':
            app.initialize(); output={'ok':True,'mode':'LOCAL_ONLY'}
        elif args.command=='provision':
            app.initialize(); output=app.provision(args.tenant,args.actor,ttl_seconds=args.ttl)
        elif args.command=='issue-token':
            output=app.issue_token(args.owner_token,args.actor,args.role,args.ttl)
        else:
            app.initialize()
            print('M192 local API: http://127.0.0.1:'+str(args.port),file=sys.stderr)
            serve(app,port=args.port)
            return 0
    except (DirectorError,OSError) as err:
        print(json.dumps({'error':str(err)}),file=sys.stderr)
        return 2
    print(json.dumps(output,ensure_ascii=True,indent=2))
    return 0

if __name__=='__main__':
    raise SystemExit(main())
