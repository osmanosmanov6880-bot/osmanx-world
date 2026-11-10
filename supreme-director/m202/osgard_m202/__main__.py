"""M202 local entrypoint: init, serve or one-shot run-due with secret on stdin.

The app does NOT schedule itself. Configure a trusted OS scheduler and pass
the owner token from a protected file through stdin; never via CLI arguments.
"""
import argparse
import json
from pathlib import Path
import sys
import uuid

from .runtime import Director202
from .server import serve


def main(argv=None):
    p=argparse.ArgumentParser(description="OSGARD M202 local monitor")
    commands=p.add_subparsers(dest="action",required=True)
    init=commands.add_parser("init")
    init.add_argument("--db",type=Path,required=True)
    init.add_argument("--tenant",required=True)
    init.add_argument("--actor",default="owner")
    serve_cmd=commands.add_parser("serve")
    serve_cmd.add_argument("--db",type=Path,required=True)
    serve_cmd.add_argument("--port",type=int,default=8722)
    due=commands.add_parser("run-due")
    due.add_argument("--db",type=Path,required=True)
    due.add_argument("--token-stdin",action="store_true",required=True)
    args=p.parse_args(argv)
    if args.action=="init":
        if args.db.exists() or args.db.is_symlink():
            p.error("refusing to overwrite existing local SQLite database")
        app=Director202(args.db)
        app.initialize()
        creds=app.provision(args.tenant,args.actor)
        print(json.dumps({
            "db":str(args.db),"tenant_id":creds["tenant_id"],
            "one_time_owner_token":creds["token"],
            "production":False,
            "security":"Save token securely; never commit to Git.",
        },ensure_ascii=False,indent=2))
        return 0
    if not args.db.is_file() or args.db.is_symlink():
        p.error("regular existing SQLite database required")
    app=Director202(args.db)
    app.initialize()
    if args.action=="serve":
        if not 1<=args.port<=65535:
            p.error("port must be 1..65535")
        print(f"M202 local monitor: http://127.0.0.1:{args.port}/watch/")
        serve(app,port=args.port)
        return 0
    # Trust boundary: no token on process command line, not printed to stdout.
    token=sys.stdin.readline(256).strip()
    if not token or len(token)>128:
        p.error("one owner bearer token required on standard input")
    status=app.execute(token,"commerce.monitor.schedule.get",{})
    if not status["exists"]:
        p.error("configure schedule as tenant owner before running due")
    result=app.execute(token,"commerce.monitor.schedule.run_due",
        {"expected_schedule_version":status["version"]},
        "m202-due-"+uuid.uuid4().hex)
    print(json.dumps(result,ensure_ascii=False,sort_keys=True))
    return 0

if __name__=="__main__":
    raise SystemExit(main())
