"""Validate all static and dynamic Russian Studio labels."""
from pathlib import Path
import json
import re

BASE=Path(__file__).resolve().parent/'osgard_m193/web'
js=(BASE/'app.js').read_text(encoding='utf-8')
html=(BASE/'index.html').read_text(encoding='utf-8')
ru=json.loads((BASE/'ru.json').read_text(encoding='utf-8'))
used=set(re.findall(r"tr\('([A-Za-z][A-Za-z0-9]*)'\)",js))
used.update(re.findall(r'data-t="([A-Za-z][A-Za-z0-9]*)"',html))
used.update('new qualified proposal won lost call email meeting note open done titan nexus experience genesis orbital'.split())
missing=sorted(used-set(ru))
if missing:raise SystemExit('M193 missing RU keys: '+', '.join(missing))
if sum(1 for k in used if any('\u0400'<=c<='\u04ff' for c in ru[k]))<len(used)*0.8:
    raise SystemExit('M193 Russian locale contains untranslated labels')
print('M193_RU_TRANSLATION_PASS',len(used),'labels')
