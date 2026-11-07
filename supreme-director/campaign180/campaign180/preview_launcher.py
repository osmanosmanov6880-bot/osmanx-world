"""Run an isolated OSGARD interactive demo on 127.0.0.1 only.

The token is generated per session and displayed only in the user's local
terminal. No Internet server, background process, remote tunnel or production
database is created.
"""
from __future__ import annotations

import argparse
from io import BytesIO
import json
import os
from pathlib import Path
import secrets
from wsgiref.simple_server import make_server
from wsgiref.util import setup_testing_defaults

from .local_http import LocalConsole, main as local_main

ROOT=Path(__file__).resolve().parent.parent
ACTOR="owner-abc"


def run(argv=None)->int:
    cli=argparse.ArgumentParser(description="OSGARD interactive local-only preview")
    cli.add_argument("--port",type=int,default=8765)
    cli.add_argument("--self-test",action="store_true")
    args=cli.parse_args(argv)
    if not 1024<=args.port<=65535:
        cli.error("Choose an available local port 1024-65535")
    os.umask(0o077)
    data=ROOT/"local-data"
    if data.is_symlink():
        raise ValueError("Local data path cannot be a symlink")
    data.mkdir(exist_ok=True)
    if os.name!="nt":
        data.chmod(0o700)
    db=data/"preview.sqlite3"
    if db.is_symlink() or (db.exists() and not db.is_file()):
        raise ValueError("Invalid local SQLite database path")
    spec=ROOT/"examples"/"demo-site.json"
    site=json.loads(spec.read_text(encoding="utf-8"))
    if not db.exists():
        local_main(["init","--database",str(db),
                    "--spec",str(spec),"--actor",ACTOR])
    token=secrets.token_urlsafe(48)
    app=LocalConsole(
        db,tenant=site["tenant_id"],project_id=site["project_id"],
        actor=ACTOR,token=token,port=args.port)
    if args.self_test:
        env={}
        setup_testing_defaults(env)
        env.update({
            "REQUEST_METHOD":"GET","PATH_INFO":"/api/v1/me",
            "HTTP_HOST":f"127.0.0.1:{args.port}",
            "REMOTE_ADDR":"127.0.0.1","QUERY_STRING":"",
            "HTTP_AUTHORIZATION":"Bearer "+token,
            "wsgi.input":BytesIO(),
        })
        status=[]
        body=b"".join(app(env,lambda code,headers:status.append(code)))
        profile=json.loads(body)
        if not status[0].startswith("200") or profile["role"]!="owner":
            raise RuntimeError("Local API authentication smoke failed")
        print("OSGARD_PREVIEW_SMOKE_PASS: real SQLite/HTTP API; no server opened")
        return 0
    print()
    print("OSGARD — ЛОКАЛЬНЫЙ ИНТЕРАКТИВНЫЙ ПРЕДПРОСМОТР")
    print(f"Откройте на ЭТОМ ЖЕ устройстве: http://127.0.0.1:{args.port}/console")
    print("Вставьте следующий токен в поле авторизации браузера:")
    print(token)
    print("Не делитесь токеном. Он новый для каждого запуска и не сохраняется.")
    print("Для остановки нажмите Ctrl+C. Публичный доступ не включён.")
    with make_server("127.0.0.1",args.port,app) as server:
        server.serve_forever()
    return 0


if __name__=="__main__":
    try:
        raise SystemExit(run())
    except KeyboardInterrupt:
        print("\nOSGARD: локальный сервер остановлен")
