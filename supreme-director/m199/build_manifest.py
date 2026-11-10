"""Build immutable inventory for authored M199 source (manifest excludes itself)."""
import hashlib
import json
from pathlib import Path
root=Path(__file__).resolve().parent
files={p.relative_to(root).as_posix():hashlib.sha256(p.read_bytes()).hexdigest()
       for p in sorted(root.rglob('*')) if p.is_file() and p.name!='M199_SOURCE_MANIFEST.json'
       and '__pycache__' not in p.parts and p.suffix!='.pyc'}
(root/'M199_SOURCE_MANIFEST.json').write_text(json.dumps({'schema':'osgard.m199.source-manifest/1',
   'files':files},ensure_ascii=False,indent=2,sort_keys=True)+'\n',encoding='utf-8')
print('M199 manifest entries:',len(files))
