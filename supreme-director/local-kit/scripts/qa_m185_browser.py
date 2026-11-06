"""Chromium M185 visual + real HTTP API bridge E2E. Synthetic reviewer key only."""
from __future__ import annotations
import base64
import hashlib
import http.client as http_client
import json
from pathlib import Path
import tempfile
import threading
import sys
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from playwright.sync_api import sync_playwright

BASE = Path(__file__).resolve().parents[1]
sys.path.insert(0,str(BASE))
from osgard_m184.storage import DirectorDB, encode
from osgard_m185.review import ReviewDB
from osgard_m185.api import serve
OUT = BASE/'evidence/m185'
OUT.mkdir(parents=True,exist_ok=True)
TOKEN='synthetic-browser-local-token-abcdefghijklmnopqrstuvwxyz'


def run():
    report={'schema':'osgard.m185.browser-qa/1','synthetic_test_reviewers':True,
      'transport_note':'Chromium localhost request blocked by environment; JavaScript fetch bridged into real 127.0.0.1 HTTP API via Python',
      'not_real_hardware':True,'not_external_review':True,'not_product_acceptance':True,'viewports':[]}
    with sync_playwright() as p:
        browser=p.chromium.launch(headless=True,executable_path='/usr/bin/chromium',args=['--no-sandbox','--disable-dev-shm-usage'])
        try:
            for width,height in [(1440,900),(390,844),(320,720)]:
                with tempfile.TemporaryDirectory() as t:
                    temp=Path(t);root=temp/'proofs';root.mkdir()
                    dbpath=temp/'m185.sqlite3'
                    DirectorDB(dbpath).bootstrap(BASE/'docs/M182_WORKPLAN_180_PROPOSED.json',
                        BASE/'templates/CONFLICTS_PROVISIONAL.json',BASE/'templates/CONTRACTS_PROVISIONAL.json')
                    private=Ed25519PrivateKey.generate()
                    raw=private.public_key().public_bytes(serialization.Encoding.Raw,serialization.PublicFormat.Raw)
                    trust=temp/'trust.json'
                    trust.write_text(json.dumps({'schema':'osgard.m185.trusted-reviewers/1','reviewers':[{
                        'id':'qa-independent','role':'QA_REVIEWER','ed25519_public_key_b64':base64.b64encode(raw).decode()}]}))
                    db=ReviewDB(dbpath,root);db.review_bootstrap(trust)
                    asset=root/'synthetic-evidence.json'
                    asset.write_text(json.dumps({'scope':'synthetic-review','viewport':width,'release':'NO_GO'}))
                    sha=hashlib.sha256(asset.read_bytes()).hexdigest()
                    http,_=serve(dbpath,root,BASE/'dashboard/m185',port=0,token=TOKEN)
                    th=threading.Thread(target=http.serve_forever,daemon=True);th.start()
                    try:
                        page=browser.new_page(viewport={'width':width,'height':height},device_scale_factor=1)
                        page.set_default_timeout(9000)
                        errors=[];page.on('pageerror',lambda error:errors.append(str(error)))
                        html=(BASE/'dashboard/m185/studio.html').read_text('utf8').replace('<link rel="stylesheet" href="/assets/studio.css">','').replace('<script defer src="/assets/studio.js"></script>','')
                        page.set_content(html,wait_until='load')
                        page.add_style_tag(content=(BASE/'dashboard/m185/studio.css').read_text('utf8'))
                        def bridge(_,path,options):
                            conn=http_client.HTTPConnection('127.0.0.1',http.server_port,timeout=7)
                            data=options.get('body')
                            conn.request(options.get('method','GET'),path,body=data,headers=options.get('headers',{}))
                            response=conn.getresponse();out={'status':response.status,'body':response.read().decode('utf8')};conn.close();return out
                        page.expose_binding('__osgard_http',bridge)
                        page.evaluate('''() => {window.fetch=async (url,opts={})=> {const r=await window.__osgard_http(String(url),opts); return new Response(r.body,{status:r.status,headers:{'Content-Type':'application/json'}})}}''')
                        page.add_script_tag(content=(BASE/'dashboard/m185/studio.js').read_text('utf8'))
                        page.locator('#connect-button').click();page.locator('#token-input').fill(TOKEN)
                        page.locator('#token-confirm').click()
                        page.get_by_text('LOCAL DATABASE CONNECTED').wait_for()
                        page.locator('[data-page="reviews"]').click()
                        page.locator('[name="target"]').fill('M181-CONFLICT-01')
                        page.locator('[name="relative_path"]').fill(asset.name)
                        page.locator('[name="sha256"]').fill(sha)
                        page.locator('#review-evidence-form [name="actor"]').fill('author-local')
                        page.get_by_role('button',name='Register checked artifact').click()
                        page.locator('#review-evidence-list').get_by_text('#1 / M181-CONFLICT-01').wait_for()
                        page.locator('[name="evidence_id"]').fill('1')
                        page.locator('[name="proposer"]').fill('author-local')
                        page.locator('[name="description"]').fill('Synthetic local evidence for E2E proof, not original M181')
                        page.get_by_role('button',name='Create locked review case').click()
                        page.locator('#vote-case option').nth(1).wait_for(state='attached')
                        page.locator('#vote-reviewer').select_option('qa-independent')
                        page.locator('#vote-verdict').select_option('PASS_LOCAL_EVIDENCE')
                        page.locator('#vote-reason').fill('This synthetic artifact matches the local SHA only')
                        page.locator('#prepare-challenge').click()
                        page.wait_for_function("document.querySelector('#vote-challenge').value.includes('LOCAL_EVIDENCE_ONLY')",timeout=9000)
                        challenge=json.loads(page.locator('#vote-challenge').input_value())
                        assert challenge['production_authorized'] is False
                        assert challenge['independent_product_acceptance'] is False
                        signature=base64.b64encode(private.sign(encode(challenge).encode('utf8'))).decode()
                        page.locator('#vote-signature').fill(signature)
                        page.locator('#submit-vote').click()
                        page.get_by_text('SIGNED LOCAL REVIEW',exact=True).first.wait_for(timeout=9000)
                        page.locator('[data-page="audit"]').click();page.locator('#run-doctor').click()
                        page.locator('#doctor-output').filter(has_text='LOCAL_INTEGRITY_PASS').wait_for(timeout=9000)
                        page.locator('[data-page="reviews"]').click()
                        page.screenshot(path=str(OUT/f'REVIEW_DESK_{width}.png'),full_page=True)
                        overflow=page.evaluate('({scroll:document.documentElement.scrollWidth,width:window.innerWidth})')
                        assert overflow['scroll'] <= overflow['width']+1,overflow
                        assert not errors,errors
                        assert db.summary()['independent_acceptance']==0
                        assert db.doctor()['health']=='LOCAL_INTEGRITY_PASS'
                        report['viewports'].append({'width':width,'height':height,'status':'PASS','horizontal_overflow_px':max(0,overflow['scroll']-overflow['width']),
                            'real_http_roundtrip':True,'synthetic_signed_local_reviews':db.summary()['signed_local_reviews'],
                            'production_authorized':False,'js_errors':errors})
                        page.close()
                    finally:
                        http.shutdown();http.server_close();th.join(timeout=3)
        finally:browser.close()
    report['all_pass']=len(report['viewports'])==3 and all(x['status']=='PASS' for x in report['viewports'])
    (OUT/'M185_BROWSER_QA.json').write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n')
    print(json.dumps({'all_pass':report['all_pass'],'viewports':len(report['viewports'])},ensure_ascii=False))
    return 0 if report['all_pass'] else 2

if __name__=='__main__':raise SystemExit(run())
