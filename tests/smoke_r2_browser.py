"""Chromium DOM smoke, using source injection because sandbox blocks local and remote navigations.
No assertion about real OSM tile loading or deployed Worker is made.
"""
from pathlib import Path
import asyncio, re
from playwright.async_api import async_playwright
ROOT=Path(__file__).resolve().parents[1]
WEB=ROOT/'moscow-1000'
SCRIPTS_HOME=['content.js','geo.js','publication.js','app.js','map.js','public-r2.js','intake.js']
SCRIPTS_EP=['content.js','app.js','geo.js','publication.js','public-r2.js']
async def hydrate(page, htmlpath, scripts):
    text=htmlpath.read_text()
    text=re.sub(r'<script[^>]*src="[^"]*"[^>]*></script>','',text)
    text=re.sub(r'<link[^>]*rel="stylesheet"[^>]*>','',text)
    await page.set_content(text,wait_until='domcontentloaded')
    await page.add_style_tag(content=(WEB/'styles.css').read_text())
    await page.evaluate("""() => { window.__fakeHistory=null; window.history.replaceState=function(a,b,url){window.__fakeHistory=url}; }""")
    for name in scripts:await page.add_script_tag(content=(WEB/name).read_text())
async def main():
    async with async_playwright() as pw:
        browser=await pw.chromium.launch(headless=True,executable_path='/usr/bin/chromium',args=['--no-sandbox','--disable-dev-shm-usage'])
        context=await browser.new_context(viewport={'width':390,'height':844},device_scale_factor=1)
        page=await context.new_page();issues=[];page.on('pageerror',lambda err:issues.append(str(err)))
        await hydrate(page,WEB/'index.html',SCRIPTS_HOME)
        await page.locator('#map-day-list button').first.wait_for()
        assert await page.locator('#map-day-list button').count()==10
        assert await page.locator('#map-anchor-list li').count()==2
        assert await page.locator('.map-pin').count()==2
        assert 'Пятницкая' in await page.locator('#map-anchor-list').inner_text()
        await page.locator('#map-day-list button[data-day="9"]').click()
        assert 'Москва-Сити' in await page.locator('#map-day-title').inner_text()
        assert 'day=9' in (await page.evaluate('window.__fakeHistory'))
        assert await page.locator('#map-episode-link').get_attribute('href')=='/moscow-1000/episodes/09/'
        await page.locator('#map-zoom-in').click()
        assert await page.locator('.osm-tile').count()>0
        assert await page.locator('#r2-lead-form').is_hidden()
        assert await page.locator('#r2-subscribe-form').is_hidden()
        await page.wait_for_function("document.getElementById('r2-service-status').textContent.includes('ещё не подключены')")
        assert 'Нет данных' in await page.locator('#public-funnel').inner_text()
        assert await page.locator('#episode-list .episode').count()==10
        await page.screenshot(path=str(ROOT/'QA_R2_mobile.png'),full_page=True)
        await hydrate(page,WEB/'episodes/09/index.html',SCRIPTS_EP)
        assert 'Москва-Сити' in await page.locator('#episode-r2').inner_text()
        assert 'day=9#map' in (await page.locator('#episode-r2 a').get_attribute('href'))
        assert 'В подготовке' in await page.locator('#episode-page-status').inner_text()
        assert await page.locator('#next-episode-link').is_hidden()
        assert not issues, 'Chromium mobile errors: '+str(issues)
        await context.close()
        ctx=await browser.new_context(viewport={'width':1440,'height':900},device_scale_factor=1)
        desktop=await ctx.new_page();dissues=[];desktop.on('pageerror',lambda err:dissues.append(str(err)))
        await hydrate(desktop,WEB/'index.html',SCRIPTS_HOME)
        await desktop.locator('#map-day-list button').first.wait_for()
        await desktop.screenshot(path=str(ROOT/'QA_R2_desktop.png'),full_page=True)
        assert not dissues, 'Chromium desktop errors: '+str(dissues)
        await ctx.close();await browser.close()
        print('PASS: 18+ Chromium source-injection assertions, mobile and desktop; no JS page errors. Live tile/network not tested.')
if __name__=='__main__': asyncio.run(main())
