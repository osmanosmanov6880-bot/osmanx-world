"""Read-only M185->M186 source continuity check; separate from original M181."""
from __future__ import annotations
import argparse, hashlib, json
from pathlib import Path
import zipfile

PINNED='9cb812ff6fb4a744c316cc1d5b6e5776849892194db85dcbe3d49b2f265771a3'
ROOT=Path(__file__).resolve().parents[1]
# README is intentionally updated for the next version; M185 code/evidence is frozen.
ALLOWED_MODIFIED={'README.md','scripts/pack_m184.py'}


def verify_archive(parent_zip, root=ROOT):
    parent=Path(parent_zip)
    if not parent.is_file() or parent.is_symlink():raise ValueError('M185 archive unavailable or unsafe')
    with parent.open('rb') as f:
        h=hashlib.file_digest(f,'sha256').hexdigest()
    if h!=PINNED:raise ValueError('M185 archive SHA-256 mismatch')
    with zipfile.ZipFile(parent) as z:
        raw=z.read('MANIFEST.json');manifest=json.loads(raw)
        if manifest.get('schema')!='osgard.m185.local-archive/1' or manifest.get('product_production')!='NO_GO':
            raise ValueError('M185 parent schema not trusted')
        files=manifest['files'];passed=[];expected=[]
        for item in files:
            name=item['path']
            if name in ALLOWED_MODIFIED:continue
            expected.append(name)
            p=Path(root)/name
            if not p.is_file() or p.is_symlink():raise ValueError('missing parent member '+name)
            with p.open('rb') as f:digest=hashlib.file_digest(f,'sha256').hexdigest()
            if digest!=item['sha256']:raise ValueError('modified parent member '+name)
            passed.append(name)
    return {'schema':'osgard.m186.parent-continuity/1','parent_name':parent.name,
            'parent_sha256':h, 'unchanged_parent_members':len(passed),
            'intentional_changed_files':sorted(ALLOWED_MODIFIED),
            'original_m181_verified':False,'six_upstream_integrations':0,
            'production_authorized':False,'result':'M185_PARENT_SOURCE_CONTINUITY_VERIFIED'}


def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('--parent',required=True)
    parser.add_argument('--root',default=str(ROOT))
    args=parser.parse_args()
    print(json.dumps(verify_archive(args.parent,args.root),sort_keys=True,indent=2))

if __name__=='__main__':main()
