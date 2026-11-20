"""M204 local init/serve and retained M202 one-shot monitoring command."""
import argparse
import json
from pathlib import Path
import sys
import uuid

from .runtime import Director204
from .server import serve


def main(argv=None):
    parser=argparse.ArgumentParser(description="OSGARD M204 local economics")
    modes=parser.add_subparsers(dest="action",required=True)
    init=modes.add_parser("init")
    init.add_argument("--db",type=Path,required=True)
    init.add_argument("--tenant",required=True)
    init.add_argument("--actor",default="owner")
    web=modes.add_parser("serve")
    web.add_argument("--db",type=Path,required=True)
    web.add_argument("--port",type=int,default=8724)
    due=modes.add_parser("run-due")
    due.add_argument("--db",type=Path,required=True)
    due.add_argument("--token-stdin",action="store_true",required=True)
    args=parser.parse_args(argv)
    if args.action=="init":
        if args.db.exists() or args.db.is_symlink():
            parser.error("refusing to overwrite an existing SQLite database")
        app=Director204(args.db)
        app.initialize()
        creds=app.provision(args.tenant,args.actor)
        print(json.dumps({
            "database":str(args.db),"tenant_id":creds["tenant_id"],
            "one_time_owner_token":creds["token"],
            "production":False,
            "security":"Never commit owner tokens or share command history.",
        },ensure_ascii=False,indent=2))
        return 0
    if not args.db.is_file() or args.db.is_symlink():
        parser.error("existing regular SQLite file required")
    app=Director204(args.db)
    app.initialize()
    if args.action=="serve":
        if not 1<=args.port<=65535:
            parser.error("port must be in 1..65535")
        print(f"M204 local economics: http://127.0.0.1:{args.port}/economics/")
        serve(app,port=args.port)
        return 0
    token=sys.stdin.readline(256).strip()
    if not token or len(token)>128:
        parser.error("owner token required from standard input")
    schedule=app.execute(token,"commerce.monitor.schedule.get",{})
    if not schedule["exists"]:
        parser.error("configure M202 schedule before one-shot run")
    result=app.execute(token,"commerce.monitor.schedule.run_due",{
        "expected_schedule_version":schedule["version"]},
        "m204-due-"+uuid.uuid4().hex)
    print(json.dumps(result,ensure_ascii=False,sort_keys=True))
    return 0

if __name__=="__main__":
    raise SystemExit(main())
