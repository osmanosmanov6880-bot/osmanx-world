"""R4 real static HTTP routing smoke. Uses local ephemeral server; no Cloudflare service claims."""
from pathlib import Path
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
import threading, asyncio
from playwright.async_api import async_playwright, Error as PlaywrightError
ROOT=Path(__file__).resolve().parents[1]
class Quiet(SimpleHTTPRequestHandler):
 def log_message(self,format,*args):pass
async def main():
 server=ThreadingHTTPServer(('127.0.0.1',0),partial(Quiet,directory=str(ROOT)))
 thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
 try:
  base=f'http://127.0.0.1:{server.server_port}'
  async with async_playwright() as p:
   browser=await p.chromium.launch(headless=True,executable_path='/usr/bin/chromium',args=['--no-sandbox','--disable-dev-shm-usage'])
   for width,height in [(390,844),(1440,900)]:
    context=await browser.new_context(viewport={'width':width,'height':height});page=await context.new_page()
    errors=[];page.on('pageerror',lambda e:errors.append(str(e)))
    await page.route('https://tile.openstreetmap.org/**',lambda route:route.abort())
    # API not on static server: public page must degrade to unpublished without inventing outcomes.
    assert (await page.goto(base+'/moscow-1000/',wait_until='domcontentloaded')).status==200
    await page.wait_for_timeout(350)
    assert await page.locator('h1').count()>0
    assert 'Нет данных' in await page.locator('#public-funnel').inner_text()
    assert await page.evaluate('document.documentElement.scrollWidth<=innerWidth+3')
    assert (await page.goto(base+'/moscow-1000/episodes/01/',wait_until='domcontentloaded')).status==200
    assert await page.locator('#episode-page-status').inner_text()=='В подготовке'
    assert await page.locator('#episode-content iframe').count()==0
    assert (await page.goto(base+'/moscow-1000/editor/',wait_until='domcontentloaded')).status==200
    await page.wait_for_timeout(200)
    assert 'Кабинет недоступен' in await page.locator('#session').inner_text()
    assert await page.locator('#console').is_hidden()
    assert not errors,f'JS runtime errors: {errors}'
    await context.close()
   await browser.close()
  print('PASS: R4 static HTTP paths, CSS/JS loaded in Chromium, fail-closed unpublished and private editor states, 390/1440px.')
 finally:
  server.shutdown();thread.join(timeout=3);server.server_close()
try:
 asyncio.run(main())
except PlaywrightError as e:
 if 'ERR_BLOCKED_BY_ADMINISTRATOR' in str(e):
  print('SKIP: browser policy blocked 127.0.0.1; source-injection smoke is separately checked.')
 else:
  raise
