"""CLI: python -m campaign180 audit|inventory|gate --root..."""
import argparse
import json
from pathlib import Path
import sys

from .registry import EvidenceError, root_from_module, repository_inventory
from .audit import save_reports
from .gates import enforce_local_gate


def main(argv=None):
    cli=argparse.ArgumentParser(description='Original OSGARD 180 audit, no release actions')
    cli.add_argument('command',choices=('audit','inventory','gate'))
    cli.add_argument('--root',type=Path,default=root_from_module())
    cli.add_argument('--output',type=Path)
    cli.add_argument('--change',action='append',default=[])
    args=cli.parse_args(argv)
    try:
        if args.command=='audit':
            target=args.output or args.root/'audit-output'
            result=save_reports(args.root,target)
            print(json.dumps(result['counts'],sort_keys=True))
        elif args.command=='inventory':
            result=repository_inventory(args.root)
            if args.output:
                args.output.parent.mkdir(parents=True,exist_ok=True)
                args.output.write_text(json.dumps(result,sort_keys=True,indent=2)+'\n',encoding='utf-8')
            print(json.dumps({'sha':result['repository_commit'],'files':result['file_count'],
                              'upstreams':result['upstream_approved_count']},sort_keys=True))
        else:
            result=enforce_local_gate(args.root,args.change)
            print(json.dumps(result,sort_keys=True))
            if not result['local_ci_can_run']:
                return 3
    except (EvidenceError,ValueError,OSError) as exc:
        print('FAIL_CLOSED: '+str(exc),file=sys.stderr)
        return 2
    return 0


if __name__=='__main__':
    raise SystemExit(main())
