"""M203 local startup; preserve the M202 one-shot due CLI contract."""
import argparse
import json
from pathlib import Path
import sys
import uuid

from .runtime import Director203
from .server import serve


def main(argv=None):
    p=argparse.ArgumentParser(description="OSGARD M203 local action plans")
    modes=p.add_subparsers(dest="action",required=True)
    init=modes.add_parser("init")
    init.add_argument("--db",type=Path,required=True)
    init.add_argument("--tenant",required=True)
    init.add_argument("--actor",default="owner")
    run=modes.add_parser("serve")
    run.add_argument("--db",type=Path,required=True)
    run.add_argument("--port",type=int,default=8723)
    due=modes.add_parser("run-due")
    due.add_argument("--db",type=Path,required=True)
    due.add_argument("--token-stdin",action="store_true",required=True)
    args=p.parse_args(argv)
    if args.action=="init":
        if args.db.exists() or args.db.is_symlink():
            p.error("refusing to overwrite an existing database")
        app=Director203(args.db)
        app.initialize()
        creds=app.provision(args.tenant,args.actor)
        print(json.dumps({"database":str(args.db),
            "tenant_id":creds["tenant_id"],
            "one_time_owner_token":creds["token"],
            "bank_verified":False,"production":False},
            ensure_ascii=False,indent=2))
        return 0
    if not args.db.is_file() or args.db.is_symlink():
        p.error("valid local regular SQLite file required")
    app=Director203(args.db)
    app.initialize()
    if args.action=="serve":
        if not 1<=args.port<=65535:
            p.error("port must be from 1 to 65535")
        print(f"Local M203 action center: http://127.0.0.1:{args.port}/actions/")
        serve(app,port=args.port)
        return 0
    token=sys.stdin.readline(256).strip()
    if not token or len(token)>128:
        p.error("one owner bearer token required from standard input")
    status=app.execute(token,"commerce.monitor.schedule.get",{})
    if not status["exists"]:
        p.error("configure M202 monitor before run-due")
    result=app.execute(token,"commerce.monitor.schedule.run_due",
        {"expected_schedule_version":status["version"]},
        "m203-due-"+uuid.uuid4().hex)
    print(json.dumps(result,ensure_ascii=False,sort_keys=True))
    return 0


if __name__=="__main__":
    raise SystemExit(main())
