"""Optional real-browser smoke. Requires system Chromium + Playwright."""
from __future__ import annotations

from http.server import ThreadingHTTPServer
from pathlib import Path
import tempfile
import threading
import uuid

from playwright.sync_api import sync_playwright
from osgard_m194.runtime import Director194
from osgard_m194.server import handler_for


def main():
    with tempfile.TemporaryDirectory(prefix='osgard-m194-browser-') as folder:
        app = Director194(Path(folder)/'local.sqlite')
        app.initialize()
        owner = app.provision('Browser Test','operator')['token']
        def call(op,p):
            return app.execute(owner,op,p,'browser-'+uuid.uuid4().hex)
        customer=call('commerce.customers.create',{'name':'Тестовый клиент','contact':'test@local.invalid'})
        call('commerce.deals.create',{'customer_id':customer['id'],'title':'Тестовая сделка',
             'amount_minor':250000,'stage':'qualified'})
        activity=call('commerce.crm.activities.create',{'customer_id':customer['id'],
                                                        'kind':'call','details':'Связаться повторно'})
        server=ThreadingHTTPServer(('127.0.0.1',0),handler_for(app))
        thread=threading.Thread(target=server.serve_forever,daemon=True)
        thread.start()
        errors=[]
        try:
            with sync_playwright() as p:
                browser=p.chromium.launch(headless=True, executable_path='/usr/bin/chromium',
                                          args=['--no-sandbox','--disable-dev-shm-usage'])
                context=browser.new_context(accept_downloads=True,viewport={'width':1440,'height':900})
                page=context.new_page()
                page.on('pageerror',lambda e: errors.append(str(e)))
                page.goto(f'http://127.0.0.1:{server.server_port}/studio/',wait_until='load',timeout=15000)
                page.get_by_text('Вход в рабочую область').wait_for(timeout=10000)
                page.locator('#credential').fill(owner)
                page.locator('#loginForm button').click()
                page.get_by_text('Управляйте бизнесом').wait_for(timeout=10000)
                page.locator('[data-page="operations"]').click()
                page.get_by_text('Операционный центр').wait_for(timeout=10000)
                page.get_by_text('Активная воронка').wait_for(timeout=10000)
                page.locator('#opsCsv').fill('name,contact\nНовый клиент,client@example.invalid\n')
                page.get_by_text('Проверить CSV').click()
                page.get_by_text('Всего строк: 1').wait_for(timeout=10000)
                page.get_by_text('Импортировать проверенные записи').click()
                page.get_by_text('Клиенты добавлены').wait_for(timeout=10000)
                assert len(call('commerce.crm.customers.list',{})['customers'])==2
                page.screenshot(path=str(Path(folder)/'m194-browser.png'),full_page=True)
                assert not errors,errors
                context.close();browser.close()
                print('M194_BROWSER_SMOKE_PASS: login, Russian UI, analytics, preview, commit, no JS errors')
        finally:
            server.shutdown();server.server_close();thread.join(timeout=5)

if __name__=='__main__':main()
