"""Run real Chromium smoke against local M195 Studio, if browser policy allows."""
import json, threading, tempfile
from pathlib import Path
from http.server import ThreadingHTTPServer
from osgard_m195.runtime import Director195
from osgard_m195.server import handler_for
from playwright.sync_api import sync_playwright

with tempfile.TemporaryDirectory() as d:
    app=Director195(Path(d)/'app.sqlite');app.initialize()
    identity=app.provision('Test Organization','owner')
    app.issue_token(identity['token'],'operator-one','operator')
    server=ThreadingHTTPServer(('127.0.0.1',0),handler_for(app))
    thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
    url=f'http://127.0.0.1:{server.server_port}/studio/'
    try:
        with sync_playwright() as pw:
            browser=pw.chromium.launch(executable_path='/usr/bin/chromium',headless=True,args=['--no-sandbox','--disable-dev-shm-usage'])
            page=browser.new_page(viewport={'width':1280,'height':800})
            errors=[]
            page.on('pageerror',lambda err: errors.append(str(err)))
            page.goto(url,wait_until='networkidle',timeout=15000)
            page.locator('#credential').fill(identity['token'])
            page.locator('#loginForm button').click()
            page.locator('[data-page="team"]').click()
            page.get_by_text('Команда и задачи').wait_for(timeout=10000)
            page.get_by_text('Новая задача').last.click()
            page.locator('#teamForm input').first.fill('Проверка рабочего места')
            page.locator('#teamForm button[type="submit"]').click()
            page.get_by_text('Проверка рабочего места').wait_for(timeout=10000)
            print(json.dumps({'browser':'Chromium','url':url,'task_visible':True,'page_errors':errors},ensure_ascii=False))
            assert not errors,errors
            page.screenshot(path='/mnt/data/osgard_m195/browser-team.png')
            browser.close()
    finally:
        server.shutdown();thread.join();server.server_close()
