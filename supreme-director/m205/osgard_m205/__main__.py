"""M205 safe local init / serve / inherited M202 one-shot scheduled check."""
import argparse
import json
from pathlib import Path
import sys
import uuid

from .runtime import Director205
from .server import serve


def main(argv=None):
    parser=argparse.ArgumentParser(description="OSGARD M205 local cost control")
    commands=parser.add_subparsers(dest="action",required=True)

    init=commands.add_parser("init")
    init.add_argument("--db",type=Path,required=True)
    init.add_argument("--tenant",required=True)
    init.add_argument("--actor",default="owner")

    launch=commands.add_parser("serve")
    launch.add_argument("--db",type=Path,required=True)
    launch.add_argument("--port",type=int,default=8725)

    due=commands.add_parser("run-due")
    due.add_argument("--db",type=Path,required=True)
    due.add_argument("--token-stdin",action="store_true",required=True)

    args=parser.parse_args(argv)
    if args.action=="init":
        if args.db.exists() or args.db.is_symlink():
            parser.error("refusing to overwrite an existing SQLite database")
        app=Director205(args.db)
        app.initialize()
        credentials=app.provision(args.tenant,args.actor)
        print(json.dumps({
            "database":str(args.db),"tenant_id":credentials["tenant_id"],
            "one_time_owner_token":credentials["token"],
            "production":False,
            "security":"Store token privately. Never place it in a Git commit.",
        },ensure_ascii=False,indent=2))
        return 0
    if not args.db.is_file() or args.db.is_symlink():
        parser.error("valid existing local SQLite file required")
    app=Director205(args.db)
    app.initialize()
    if args.action=="serve":
        if not 1<=args.port<=65535:
            parser.error("port out of range")
        print(f"M205 locally: http://127.0.0.1:{args.port}/cost-control/")
        serve(app,port=args.port)
        return 0

    token=sys.stdin.readline(256).strip()
    if not token or len(token)>128:
        parser.error("one owner token required on stdin")
    schedule=app.execute(token,"commerce.monitor.schedule.get",{})
    if not schedule["exists"]:
        parser.error("M202 schedule configuration missing")
    result=app.execute(token,"commerce.monitor.schedule.run_due",{
        "expected_schedule_version":schedule["version"]},
        "m205-due-"+uuid.uuid4().hex)
    print(json.dumps(result,ensure_ascii=False,sort_keys=True))
    return 0


if __name__=="__main__":
    raise SystemExit(main())
