from playwright.sync_api import sync_playwright
from pathlib import Path
import subprocess, time, os, signal
ROOT=Path(__file__).resolve().parents[1]
def inline(name):
  source=(ROOT/name).read_text(encoding='utf-8')
  for resource in ['site.css','workspace.css']:
    source=source.replace(f'<link rel="stylesheet" href="/assets/sovereign/{resource}">',f'<style>{(ROOT/"assets/sovereign"/resource).read_text(encoding="utf-8")}</style>')
  for resource in ['site.js','workspace.js']:
    source=source.replace(f'<script defer src="/assets/sovereign/{resource}"></script>',f'<script>{(ROOT/"assets/sovereign"/resource).read_text(encoding="utf-8")}</script>')
  shim="""<script>const __testStorage={};Object.defineProperty(window,'localStorage',{configurable:true,value:{getItem:k=>__testStorage[k]??null,setItem:(k,v)=>{__testStorage[k]=v},removeItem:k=>{delete __testStorage[k]}}});</script>"""
  return source.replace('<head>', '<head>'+shim,1)
try:
  with sync_playwright() as playwright:
    browser=playwright.chromium.launch(headless=True,args=['--no-sandbox','--disable-dev-shm-usage'])
    for width,height in [(1600,920),(390,844)]:
      print('HOME',width,flush=True);page=browser.new_page(viewport={'width':width,'height':height},accept_downloads=True);page.set_default_timeout(4000)
      errors=[];page.on('pageerror',lambda exc:errors.append(str(exc)))
      page.set_content(inline('index.html'),wait_until='domcontentloaded')
      page.get_by_role('heading',name='OSMANX WORLD').wait_for()
      page.screenshot(path=str(ROOT/f'tests/home-{width}.png'),full_page=True)
      assert page.locator('.product-tile').count()==5
      assert page.get_by_role('link',name='Открыть демо',exact=False).count()==3
      assert page.get_by_role('link',name='Открыть полную версию',exact=False).count()==1
      assert page.evaluate('document.documentElement.scrollWidth <= innerWidth + 2'),('horizontal overflow home',width,page.evaluate('document.documentElement.scrollWidth'))
      print('SEARCH',flush=True);page.get_by_role('button',name='Поиск продуктов').click()
      page.locator('#search-query').fill('OmniChat')
      assert page.locator('#search-list a').count()==1
      page.keyboard.press('Escape')
      print('TEAM',flush=True);page.get_by_role('button',name='Команда',exact=True).click()
      page.locator('#team-form input[name=name]').fill('Тестовый сотрудник')
      page.locator('#team-form button[type=submit]').click()
      page.get_by_text('Тестовый сотрудник').wait_for()
      print('ANALYTICS',flush=True);page.get_by_role('button',name='Аналитика').click()
      assert 'Ответы в Retail Demo' in page.locator('#main').inner_text()
      assert not errors, errors
      page.close()
    def work(app):
      print('APP',app,flush=True);page=browser.new_page(viewport={'width':1440,'height':900},accept_downloads=True);page.set_default_timeout(4000)
      errs=[];page.on('pageerror',lambda err:errs.append(str(err)))
      page.goto('about:blank?app='+app)
      page.set_content(inline('assets/sovereign/workspace.html'),wait_until='domcontentloaded')
      page.locator('.ws-banner h1').wait_for()
      return page,errs
    page,err=work('retail')
    page.get_by_role('button',name='Опрос').first.click()
    page.locator('#retail-survey select').select_option('Нет размера')
    page.locator('#retail-survey textarea').fill('Тестовая запись без персональных данных')
    page.locator('#retail-survey button').click()
    assert page.get_by_text('Тестовая запись без персональных данных').count()>=1
    page.get_by_role('button',name='Гипотезы').first.click()
    page.locator('#retail-hyp button').click()
    assert page.locator('.ws-list-item').count()>=1
    page.get_by_role('button',name='Пилоты').first.click()
    page.locator('#retail-pilot input[name=before]').fill('2026-11-01')
    page.locator('#retail-pilot input[name=after]').fill('2026-11-10')
    page.locator('#retail-pilot button').click()
    page.get_by_text('Проверка наличия размеров').first.wait_for()
    page.get_by_role('button',name='Задачи').first.click()
    page.locator('#retail-task button').click()
    assert page.get_by_text('Проверить остатки популярных размеров').count()>=1
    assert not err,err
    page.screenshot(path=str(ROOT/'tests/retail-1440.png'),full_page=True)
    page.close()
    page,err=work('omni')
    page.locator('#omni-send textarea').fill('Проверочный ответ без настоящей отправки')
    page.locator('#omni-send button').first.click()
    assert page.get_by_text('Проверочный ответ без настоящей отправки').count()>=1
    assert not err,err;page.close()
    page,err=work('factory')
    page.get_by_role('button',name='Создать сайт').first.click()
    page.locator('#factory-new input[name=name]').fill('Моя кофейня')
    page.locator('#factory-new button').click()
    page.locator('#factory-preview').wait_for()
    with page.expect_download() as dl:page.get_by_role('button',name='Скачать HTML').click()
    assert dl.value.suggested_filename.endswith('.html')
    assert not err,err;page.close()
    page,err=work('senqard')
    page.locator('#senqard-project input[name=name]').fill('Новый проект')
    page.locator('#senqard-project button').click()
    page.get_by_role('button',name='Задачи').first.click()
    page.locator('#senqard-task button').click()
    assert page.get_by_text('Подготовить список требований').count()>=1
    assert not err,err;page.close()
    browser.close()
    print('PASS: homepage PC/mobile, search, team, analytics; all 4 active workspace demos and real local operations')
finally:
  pass
