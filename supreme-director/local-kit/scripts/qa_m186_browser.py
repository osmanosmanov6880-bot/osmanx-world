"""Actual local HTTP roundtrip via controlled Chromium transport bridge.

Environment blocks Chromium loopback navigation. HTML/CSS/JS are real and
requests are forwarded to a real 127.0.0.1 Python API. Not a public E2E.
"""
from __future__ import annotations
import http.client as http_client
import json
from pathlib import Path
import sys
import tempfile
import threading

from playwright.sync_api import sync_playwright

BASE=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(BASE))
from osgard_m184.storage import DirectorDB
from osgard_m185.review import ReviewDB
from osgard_m186.storage import LabDB
from osgard_m186.api import serve
TOKEN='synthetic-browser-m186-local-token-abcdefghijklmnopqrstuvwxyz'
OUT=BASE/'evidence/m186'
OUT.mkdir(parents=True,exist_ok=True)


def run():
    report={'schema':'osgard.m186.browser-qa/1','viewports':[], 'transport':'Chromium fetch bridged into real localhost HTTP by Python',
            'source':'Synthetic local reference adapters only', 'product_acceptance':0,'production':'NO_GO'}
    with sync_playwright() as p:
        browser=p.chromium.launch(headless=True,executable_path='/usr/bin/chromium',args=['--no-sandbox','--disable-dev-shm-usage'])
        try:
            for width,height in [(1440,900),(390,844),(320,720)]:
                with tempfile.TemporaryDirectory() as t:
                    temp=Path(t);evidence=temp/'evidence';evidence.mkdir();dbpath=temp/'m186.sqlite3'
                    DirectorDB(dbpath).bootstrap(BASE/'docs/M182_WORKPLAN_180_PROPOSED.json',
                        BASE/'templates/CONFLICTS_PROVISIONAL.json',BASE/'templates/CONTRACTS_PROVISIONAL.json')
                    ReviewDB(dbpath,evidence).review_bootstrap(BASE/'templates/TRUSTED_REVIEWERS_EMPTY.json')
                    db=LabDB(dbpath,evidence,BASE/'templates/REFERENCE_CONTRACTS_M186.json');db.lab_bootstrap()
                    http,_=serve(dbpath,evidence,BASE/'templates/REFERENCE_CONTRACTS_M186.json',BASE/'dashboard/m186',port=0,token=TOKEN)
                    thread=threading.Thread(target=http.serve_forever,daemon=True);thread.start()
                    try:
                        page=browser.new_page(viewport={'width':width,'height':height},device_scale_factor=1)
                        page.set_default_timeout(12000)
                        errors=[];page.on('pageerror',lambda err:errors.append(str(err)))
                        html=(BASE/'dashboard/m186/studio.html').read_text('utf8').replace('<link rel="stylesheet" href="/assets/studio.css">','').replace('<script defer src="/assets/studio.js"></script>','')
                        page.set_content(html,wait_until='load')
                        page.add_style_tag(content=(BASE/'dashboard/m186/studio.css').read_text('utf8'))
                        def bridge(_,path,options):
                            conn=http_client.HTTPConnection('127.0.0.1',http.server_port,timeout=8)
                            conn.request(options.get('method','GET'),path,body=options.get('body'),headers=options.get('headers',{}))
                            response=conn.getresponse();out={'status':response.status,'body':response.read().decode('utf8')};conn.close();return out
                        page.expose_binding('__osgard_http',bridge)
                        page.evaluate('''() => {window.fetch=async (url,opts={})=> {const r=await window.__osgard_http(String(url),opts);return new Response(r.body,{status:r.status,headers:{'Content-Type':'application/json'}})}}''')
                        page.add_script_tag(content=(BASE/'dashboard/m186/studio.js').read_text('utf8'))
                        page.locator('#connect-button').click();page.locator('#token-input').fill(TOKEN)
                        page.locator('#token-confirm').click();page.get_by_text('LOCAL DATABASE CONNECTED').wait_for()
                        page.locator('[data-page="lab"]').click()
                        page.locator('#lab-scenario').select_option('LEARNING_PLATFORM')
                        page.locator('#lab-budget').fill('2400')
                        page.locator('#lab-execute').click()
                        page.locator('#lab-receipt').filter(has_text='REFERENCE_FLOW_COMPLETE').wait_for(timeout=12000)
                        page.wait_for_function("document.querySelectorAll('#lab-trace .lab-step').length === 9")
                        page.locator('#lab-fault').select_option('CONTRACT-05')
                        page.locator('#lab-execute').click()
                        page.locator('#lab-receipt').filter(has_text='BLOCKED_REFERENCE_CONTRACT').wait_for(timeout=12000)
                        page.wait_for_function("document.querySelectorAll('#lab-trace .lab-step').length === 5")
                        page.locator('#lab-trace .lab-step.failed').filter(has_text='CONTRACT-05').wait_for()
                        assert page.locator('#lab-count').inner_text()=='2'
                        assert page.locator('#lab-complete').inner_text()=='1'
                        assert page.locator('#lab-blocked').inner_text()=='1'
                        page.screenshot(path=str(OUT/f'INTEGRATION_LAB_{width}.png'),full_page=True)
                        overflow=page.evaluate('({scroll:document.documentElement.scrollWidth,width:window.innerWidth})')
                        assert overflow['scroll']<=overflow['width']+1,overflow
                        assert not errors,errors
                        assert db.summary()['independent_acceptance']==0
                        assert db.summary()['real_integrations']==0
                        assert db.doctor()['health']=='LOCAL_INTEGRITY_PASS'
                        report['viewports'].append({'width':width,'height':height,'status':'PASS','real_http_roundtrip':True,
                            'reference_runs':2,'horizontal_overflow_px':max(0,overflow['scroll']-overflow['width']),
                            'js_errors':errors,'production_authorized':False})
                        page.close()
                    finally:
                        http.shutdown();http.server_close();thread.join(timeout=3)
        finally:browser.close()
    report['all_pass']=len(report['viewports'])==3 and all(x['status']=='PASS' for x in report['viewports'])
    (OUT/'M186_BROWSER_QA.json').write_text(json.dumps(report,ensure_ascii=False,sort_keys=True,indent=2)+'\n')
    print(json.dumps({'all_pass':report['all_pass'],'viewports':len(report['viewports'])},ensure_ascii=False))
    return 0 if report['all_pass'] else 2

if __name__=='__main__':raise SystemExit(run())
