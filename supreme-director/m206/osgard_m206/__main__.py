"""M206 local CLI: safe init/serve and inherited M202 one-shot due-run."""
import argparse
import json
from pathlib import Path
import sys
import uuid

from .runtime import Director206
from .server import serve


def main(argv=None):
    parser=argparse.ArgumentParser(description="OSGARD M206 local assurance")
    commands=parser.add_subparsers(dest="action",required=True)
    initialize=commands.add_parser("init")
    initialize.add_argument("--db",type=Path,required=True)
    initialize.add_argument("--tenant",required=True)
    initialize.add_argument("--actor",default="owner")
    launch=commands.add_parser("serve")
    launch.add_argument("--db",type=Path,required=True)
    launch.add_argument("--port",type=int,default=8726)
    due=commands.add_parser("run-due")
    due.add_argument("--db",type=Path,required=True)
    due.add_argument("--token-stdin",action="store_true",required=True)
    args=parser.parse_args(argv)
    if args.action=="init":
        if args.db.exists() or args.db.is_symlink():
            parser.error("database exists; refusing destructive overwrite")
        app=Director206(args.db)
        app.initialize()
        credentials=app.provision(args.tenant,args.actor)
        print(json.dumps({
            "database":str(args.db),"tenant_id":credentials["tenant_id"],
            "one_time_owner_token":credentials["token"],"production":False,
            "security":"Keep the local owner token out of Git and shell history."
        },ensure_ascii=False,indent=2))
        return 0
    if not args.db.is_file() or args.db.is_symlink():
        parser.error("existing regular SQLite database required")
    app=Director206(args.db)
    app.initialize()
    if args.action=="serve":
        if not 1<=args.port<=65535:
            parser.error("port must be integer from 1 to 65535")
        print(f"M206 locally: http://127.0.0.1:{args.port}/assurance/")
        serve(app,port=args.port)
        return 0
    token=sys.stdin.readline(256).strip()
    if not token or len(token)>128:
        parser.error("one owner token required from standard input")
    schedule=app.execute(token,"commerce.monitor.schedule.get",{})
    if not schedule["exists"]:
        parser.error("M202 schedule is not configured")
    result=app.execute(token,"commerce.monitor.schedule.run_due",{
        "expected_schedule_version":schedule["version"]},
        "m206-due-"+uuid.uuid4().hex)
    print(json.dumps(result,ensure_ascii=False,sort_keys=True))
    return 0


if __name__=="__main__":
    raise SystemExit(main())
