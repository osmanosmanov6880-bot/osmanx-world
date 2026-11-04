"""Real Chromium local E2E, synthetic operator data in temporary database."""
from __future__ import annotations
from contextlib import contextmanager
import json
from pathlib import Path
import http.client
import re
import tempfile
import threading
import time
import sys
BASE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BASE))
from playwright.sync_api import sync_playwright
from osgard_m184.storage import DirectorDB
from osgard_m184.api import serve
OUTPUT = BASE / 'evidence/m184'
OUTPUT.mkdir(parents=True, exist_ok=True)
TOKEN = 'browser-only-session-secret-not-prod-123456789'


def run():
    report = {'suites': [], 'warnings': ['Chromium emulation, not physical devices', 'Temporary synthetic operator interactions only', 'No six-product staging test']}
    with tempfile.TemporaryDirectory() as d:
        db = DirectorDB(Path(d) / 'qa.sqlite3')
        db.bootstrap(BASE/'docs/M182_WORKPLAN_180_PROPOSED.json', BASE/'templates/CONFLICTS_PROVISIONAL.json',
                     BASE/'templates/CONTRACTS_PROVISIONAL.json', BASE/'docs/m183/CURRENT_GITHUB_DEFAULT_BRANCH_OBSERVATIONS_2026-10-27.json')
        srv, _ = serve(db.path, BASE/'dashboard/m184', port=0, token=TOKEN)
        thread = threading.Thread(target=srv.serve_forever, daemon=True); thread.start()
        addr = 'http://127.0.0.1:' + str(srv.server_port)
        try:
            with sync_playwright() as p:
                browser = p.chromium.launch(headless=True, executable_path='/usr/bin/chromium', args=['--no-sandbox','--disable-dev-shm-usage'])
                try:
                    for viewport_idx,(width,height) in enumerate([(1440,900),(390,844),(320,720)]):
                        print('VIEWPORT',width,flush=True)
                        page = browser.new_page(viewport={'width':width,'height':height},device_scale_factor=1)
                        errors=[]
                        page.set_default_timeout(7000)
                        page.on('pageerror', lambda e: errors.append(str(e)))
                        # Browser sandbox rejects localhost navigations by policy.
                        # Render original HTML/CSS/JS and route fetch through a
                        # Python bridge that makes REAL HTTP calls to the local API.
                        html=(BASE/'dashboard/m184/studio.html').read_text(encoding='utf8')
                        html=html.replace('<link rel="stylesheet" href="/assets/studio.css">','')
                        html=html.replace('<script defer src="/assets/studio.js"></script>','')
                        page.set_content(html,wait_until='load')
                        page.add_style_tag(content=(BASE/'dashboard/m184/studio.css').read_text(encoding='utf8'))
                        def http_bridge(_, path, options):
                            method=options.get('method','GET')
                            headers=dict(options.get('headers',{}))
                            body=options.get('body')
                            if body is not None and not isinstance(body,str):
                                body=json.dumps(body)
                            conn=http.client.HTTPConnection('127.0.0.1',srv.server_port,timeout=5)
                            conn.request(method,path,body=body,headers=headers)
                            response=conn.getresponse()
                            output={'status':response.status,'body':response.read().decode('utf8')}
                            conn.close()
                            return output
                        page.expose_binding('__osgard_http',http_bridge)
                        page.evaluate('''() => {
                          window.fetch = async (url, options={}) => {
                            const data=await window.__osgard_http(String(url),options);
                            return new Response(data.body,{status:data.status,headers:{'Content-Type':'application/json'}});
                          };
                        }''')
                        page.add_script_tag(content=(BASE/'dashboard/m184/studio.js').read_text(encoding='utf8'))
                        page.screenshot(path=str(OUTPUT/f'STUDIO_START_{width}.png'),full_page=True)
                        title=page.title()
                        assert 'OSGARD' in title
                        page.locator('#connect-button').click()
                        page.locator('#token-input').fill(TOKEN)
                        page.locator('#token-confirm').click()
                        page.get_by_text('LOCAL DATABASE CONNECTED').wait_for(timeout=5000)
                        assert page.locator('#metric-tasks').inner_text()=='180'
                        assert page.locator('#metric-conflicts').inner_text()=='28'
                        page.screenshot(path=str(OUTPUT/f'STUDIO_CONNECTED_{width}.png'),full_page=True)
                        # Real API calls behind the live interface: note + conflict triage.
                        print('BEFORE '+'page.locator(\'[data-page="tasks"]\').click()', flush=True)
                        page.locator('[data-page="tasks"]').click()
                        print('BEFORE '+"page.locator('#task-team').select_option('TITAN')", flush=True)
                        page.locator('#task-team').select_option('TITAN')
                        assert page.locator('#tasks-table tr').count()==30
                        print('BEFORE '+"page.locator('#tasks-table tr').first.locator('button').click()", flush=True)
                        page.locator('#tasks-table tr').first.locator('button').click()
                        page.locator('#note-actor').fill('qa-chromium')
                        page.locator('#note-text').fill('Source provenance remains unavailable')
                        print('BEFORE '+"page.locator('#note-save').click()", flush=True)
                        page.locator('#note-save').click()
                        page.locator('#note-dialog').wait_for(state='hidden',timeout=5000)
                        print('BEFORE '+'page.locator(\'[data-page="conflicts"]\').click()', flush=True)
                        page.locator('[data-page="conflicts"]').click()
                        print('BEFORE '+"page.locator('.conflict-card').nth(viewport_idx).locator('button').click()", flush=True)
                        page.locator('.conflict-card').nth(viewport_idx).locator('button').click()
                        page.locator('#note-actor').fill('qa-chromium')
                        page.locator('#note-text').fill('Do not merge unknown files')
                        page.locator('#triage-status').select_option('TRIAGED')
                        print('BEFORE '+"page.locator('#note-save').click()", flush=True)
                        page.locator('#note-save').click()
                        page.locator('#note-dialog').wait_for(state='hidden',timeout=5000)
                        assert 'TRIAGED' in page.locator('.conflict-card').nth(viewport_idx).inner_text()
                        print('BEFORE '+'page.locator(\'[data-page="audit"]\').click()', flush=True)
                        page.locator('[data-page="audit"]').click()
                        page.locator('#run-doctor').click()
                        page.locator('#doctor-output').filter(has_text='LOCAL_INTEGRITY_PASS').wait_for(timeout=5000)
                        page.screenshot(path=str(OUTPUT/f'STUDIO_AUDIT_{width}.png'),full_page=True)
                        overflow=page.evaluate('({doc:document.documentElement.scrollWidth,viewport:window.innerWidth})')
                        assert overflow['doc'] <= overflow['viewport'] + 1, overflow
                        assert not errors, errors
                        report['suites'].append({'viewport':[width,height], 'status':'PASS', 'browser_errors':errors,
                                                 'horizontal_overflow_px':max(0,overflow['doc']-overflow['viewport']),
                                                 'transport':'REAL_API_VIA_PYTHON_BRIDGE_BROWSER_LOOPBACK_BLOCKED','tests':['auth','live_summary','30_task_filter','note_write','triage_write','audit_verification','responsive_layout']})
                        page.close()
                finally:
                    browser.close()
        finally:
            srv.shutdown();srv.server_close();thread.join(timeout=3)
        report['final_db_doctor']=db.doctor()
        report['final_summary']=db.summary()
    report['all_pass']=all(x['status']=='PASS' for x in report['suites']) and report['final_db_doctor']['health']=='LOCAL_INTEGRITY_PASS'
    path=OUTPUT/'M184_BROWSER_QA.json'
    path.write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n',encoding='utf8')
    print(json.dumps({'all_pass':report['all_pass'],'viewports':len(report['suites']),
                      'notes':report['final_summary']['counts']['notes'], 'release':report['final_summary']['release']},ensure_ascii=False))
    return 0 if report['all_pass'] else 2

if __name__ == '__main__':
    raise SystemExit(run())
