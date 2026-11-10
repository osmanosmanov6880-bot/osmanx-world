"""Real Chromium desktop/mobile offline dashboard QA for M183; no product QA."""
from __future__ import annotations
import json
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
URL = (ROOT / 'dashboard/OSGARD_M183_CONTROL.html').resolve().as_uri()
SIZES = [('desktop', 1440, 900), ('mobile390', 390, 844), ('mobile320', 320, 720)]

def main():
    result = {'scope': 'M183 local offline dashboard only; NOT product UX acceptance',
              'url_type': 'inline standalone HTML via Chromium set_content; file:// blocked by environment administrator', 'checks': [], 'status': 'BLOCKED'}
    with sync_playwright() as p:
        browser=p.chromium.launch(headless=True, executable_path='/usr/bin/chromium', args=['--no-sandbox','--disable-dev-shm-usage'])
        try:
            for name, width, height in SIZES:
                page=browser.new_page(viewport={'width':width,'height':height},device_scale_factor=1)
                error=[]
                page.on('pageerror',lambda exc: error.append(str(exc)))
                page.set_content((ROOT / 'dashboard/OSGARD_M183_CONTROL.html').read_text(encoding='utf-8'), wait_until='load')
                page.wait_for_selector('#repos .record')
                total=page.locator('#repos .record').count()
                world=page.locator('#world').inner_text()
                title=page.locator('h1').inner_text()
                overflow=page.evaluate('document.documentElement.scrollWidth > window.innerWidth')
                page.locator('[data-filter="changed"]').click()
                changed=page.locator('#repos .record').count()
                page.locator('#search').fill('osgard-world')
                searched=page.locator('#repos .record').count()
                screenshot=ROOT/'evidence/m183'/f'DASHBOARD_R2_{name}.png'
                page.screenshot(path=str(screenshot),full_page=True)
                ok=(total==6 and changed==1 and searched==1 and not error and not overflow
                    and world=='0 / 32' and 'мировому уровню' in title)
                result['checks'].append({'viewport':name,'width':width,'height':height,
                    'all_repos':total,'changed_filter':changed,'filtered_search':searched,
                    'horizontal_overflow':overflow,'page_errors':error,'world_readiness':world,
                    'screenshot':str(screenshot.relative_to(ROOT)),'status':'PASS' if ok else 'FAIL'})
                page.close()
            result['status']='PASS' if all(x['status']=='PASS' for x in result['checks']) else 'BLOCKED'
        finally:
            browser.close()
    path=ROOT/'evidence/m183/DASHBOARD_CHROMIUM_QA_R2.json'
    with path.open('x',encoding='utf-8') as f:json.dump(result,f,ensure_ascii=False,indent=2)
    print(json.dumps({'status':result['status'],'viewports':len(result['checks']),
                      'checks':result['checks']},ensure_ascii=False))
    return 0 if result['status']=='PASS' else 1

if __name__=='__main__':
    raise SystemExit(main())
