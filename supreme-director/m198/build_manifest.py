"""Reproducibly regenerate M198_SOURCE_MANIFEST.json after source is finalized."""
import hashlib,json
from pathlib import Path
root=Path(__file__).resolve().parent
items={}
for p in sorted(root.rglob('*')):
    if not p.is_file() or '__pycache__' in p.parts or p.name.endswith('.pyc') or p.name=='M198_SOURCE_MANIFEST.json':continue
    items[p.relative_to(root).as_posix()]=hashlib.sha256(p.read_bytes()).hexdigest()
(root/'M198_SOURCE_MANIFEST.json').write_text(json.dumps({'schema':'osgard.m198.source-manifest/1','files':items},indent=2,ensure_ascii=False)+'\n',encoding='utf-8')
print('Written manifest with',len(items),'paths')
