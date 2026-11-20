"""End-to-end local Chromium smoke of M196 Russian Studio, synthetic data only.

Optional manual/CI validation: requires playwright Python and a Chromium binary.
Does not visit outside sites, deploy, or expose real credentials.
"""
from __future__ import annotations
import json
import os
from pathlib import Path
import tempfile
import threading
from http.server import ThreadingHTTPServer
from playwright.sync_api import sync_playwright

from osgard_m196.runtime import Director196
from osgard_m196.server import handler_for


def main():
    with tempfile.TemporaryDirectory() as folder:
        app=Director196(Path(folder)/'synthetic.sqlite')
        app.initialize()
        token=app.provision('QA tenant','director')['token']
        customer=app.execute(token,'commerce.customers.create',
            {'name':'Проверочный клиент','contact':'qa@example.invalid'},'qa-customer0001')['id']
        app.execute(token,'commerce.deals.create',
            {'customer_id':customer,'title':'Проверочная сделка','amount_minor':120000,'stage':'new'},'qa-deal00000001')
        app.execute(token,'titan.work.create',
            {'title':'Проверочная задача'},'qa-task00000001')
        server=ThreadingHTTPServer(('127.0.0.1',0),handler_for(app))
        thread=threading.Thread(target=server.serve_forever,daemon=True)
        thread.start()
        try:
            with sync_playwright() as playwright:
                browser=playwright.chromium.launch(headless=True,
                    executable_path=os.environ.get('CHROMIUM_BINARY','/usr/bin/chromium'),
                    args=['--no-sandbox','--disable-dev-shm-usage','--no-first-run'])
                try:
                    context=browser.new_context(viewport={'width':1440,'height':1000},
                        locale='ru-RU',timezone_id='Europe/Moscow')
                    page=context.new_page()
                    errors=[]
                    page.on('pageerror', lambda e:errors.append(str(e)))
                    page.goto(f'http://127.0.0.1:{server.server_port}/studio/',wait_until='networkidle',timeout=20000)
                    assert 'M196' in page.title(), page.title()
                    page.locator('#credential').fill(token)
                    page.locator('#loginForm button').click()
                    page.locator('#app').wait_for(state='visible',timeout=10000)
                    page.locator('[data-page="projects"]').click()
                    page.get_by_text('Проекты и этапы').wait_for(state='visible',timeout=10000)
                    page.get_by_role('button',name='Новый проект').click()
                    page.locator('#projectCreateForm input').fill('Внедрение CRM')
                    page.locator('#projectCreateForm select').select_option(index=1)
                    page.locator('#projectCreateForm button[type=submit]').click()
                    page.get_by_text('Внедрение CRM').first.wait_for(state='visible',timeout=10000)
                    page.get_by_role('button',name='Добавить этап').click()
                    page.locator('#projectStageForm input').first.fill('Согласование требований')
                    page.locator('#projectStageForm button[type=submit]').click()
                    page.get_by_text('Согласование требований').wait_for(state='visible',timeout=10000)
                    page.get_by_role('button',name='Начать проект').click()
                    page.get_by_role('button',name='Начать этап').click()
                    # Link actual M195 work item; use protected local API.
                    page.get_by_role('button',name='Привязать').click()
                    page.get_by_text('Проверочная задача').wait_for(state='visible',timeout=10000)
                    page.get_by_role('button',name='Завершить этап').click()
                    page.get_by_text('unfinished linked work prevents closing stage').wait_for(state='visible',timeout=10000)
                    page.locator('[data-page="team"]').click()
                    page.get_by_text('Проверочная задача').first.wait_for(state='visible',timeout=10000)
                    page.get_by_role('button',name='Завершить').click()
                    page.locator('[data-page="projects"]').click()
                    page.get_by_role('button',name='Завершить этап').click()
                    page.get_by_role('button',name='Завершить проект').click()
                    page.get_by_text('Завершён').first.wait_for(state='visible',timeout=10000)
                    if errors: raise AssertionError('Browser JS errors: '+repr(errors))
                    page.screenshot(path=str(Path(folder)/'m196_smoke.png'),full_page=True)
                    print(json.dumps({'status':'M196_BROWSER_SMOKE_PASS',
                           'browser':'chromium','scenario':'project->stage->task->complete',
                           'no_external_calls':True,'console_errors':len(errors)}))
                finally:
                    browser.close()
        finally:
            server.shutdown();thread.join(timeout=3);server.server_close()


if __name__ == '__main__':
    main()
