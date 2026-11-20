"""Optional local real-Chromium smoke for M197 project cards."""
from http.server import ThreadingHTTPServer
from pathlib import Path
from tempfile import TemporaryDirectory
from threading import Thread
from playwright.sync_api import sync_playwright
from osgard_m197.runtime import Director197
from osgard_m197.server import handler_for
import uuid


def key():return 'm197-browser-'+uuid.uuid4().hex

with TemporaryDirectory() as folder:
    db=Director197(Path(folder)/'test.sqlite')
    db.initialize()
    token=db.provision('QA Tenant','qaowner')['token']
    client=db.execute(token,'commerce.customers.create',{'name':'Test Customer','contact':'contact'},key())
    deal=db.execute(token,'commerce.deals.create',{'customer_id':client['id'],'title':'Test Sale','amount_minor':100,'stage':'new'},key())
    project=db.execute(token,'commerce.projects.create',{'deal_id':deal['id'],'title':'QA Project'},key())
    server=ThreadingHTTPServer(('127.0.0.1',0),handler_for(db))
    thread=Thread(target=server.serve_forever,daemon=True);thread.start()
    try:
        with sync_playwright() as playwright:
            browser=playwright.chromium.launch(executable_path='/usr/bin/chromium',headless=True,args=['--no-sandbox'])
            page=browser.new_page(viewport={'width':1280,'height':800})
            issues=[];page.on('pageerror',lambda e:issues.append(str(e)))
            url='http://127.0.0.1:'+str(server.server_port)+'/projects/'
            page.goto(url,wait_until='domcontentloaded',timeout=15000)
            page.locator('#token').fill(token)
            page.get_by_role('button',name='Открыть рабочую область').click()
            page.get_by_role('heading',name='QA Project').wait_for(timeout=10000)
            page.get_by_role('button',name='+ Обязательство').click()
            page.get_by_label('Что обещали клиенту').fill('Первый отчёт')
            page.locator('#editDialog button[type="submit"]').click()
            page.get_by_text('Первый отчёт').wait_for(timeout=10000)
            assert page.get_by_text('Первый отчёт').count()==1
            assert not issues, issues
            page.screenshot(path='/mnt/data/osgard_m197/M197_BROWSER_QA.png',full_page=True)
            print('BROWSER_SMOKE_PASS: authenticated project, create obligation, real UI.')
            browser.close()
    finally:
        server.shutdown();server.server_close()
