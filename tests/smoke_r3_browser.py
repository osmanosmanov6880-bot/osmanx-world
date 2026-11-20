"""R3 Chromium source-injection smoke. Real D1/Cloudflare/OSM delivery is separately gated."""
from pathlib import Path
import asyncio,re,json,base64
from playwright.async_api import async_playwright
ROOT=Path(__file__).resolve().parents[1]
SITE=ROOT/'moscow-1000'
RELEASE={'schemaVersion':3,'status':'published','version':1,'reviewedAt':'2026-11-20T10:00:00Z','method':'Разрешённые обезличенные результаты добровольного интервью','metrics':None,'days':[{'day':1,'summary':'Разрешённое наблюдение о клиентском пути.','lesson':'Нужны дополнительные данные.'}], 'markers':[{'id':'point_test_001','day':1,'title':'Публичный ориентир','lat':55.742,'lng':37.628,'summary':'Опубликовано с разрешением и без личных данных.','episode':1}], 'episodes':[{'day':1,'title':'Проверенный выпуск','videoUrl':'/assets/moscow/01.mp4','publishedAt':'2026-11-20T09:00:00Z'}]}
SCRIPTS=['content.js','geo.js','publication.js','app.js','map.js','public-r2.js','intake.js','public-r3.js']
async def hydrate(page,path,css,scripts):
    html=path.read_text(encoding='utf8');html=re.sub(r'<script[^>]*src="[^"]*"[^>]*></script>','',html);html=re.sub(r'<link[^>]*rel="stylesheet"[^>]*>','',html)
    await page.set_content(html,wait_until='domcontentloaded')
    await page.add_style_tag(content=css.read_text(encoding='utf8'))
    await page.evaluate('''(release)=>{window.history.replaceState=function(){};window.fetch=async(url,opts)=>{const s=String(url);if(s.includes('/public-release'))return {ok:true,json:async()=>release};if(s.includes('/health'))return {ok:true,json:async()=>({leadsEnabled:false,subscriptionEnabled:false})};throw Error('Network mocked');};}''',RELEASE)
    for filename in scripts:await page.add_script_tag(content=(SITE/filename).read_text(encoding='utf8'))
async def main():
    async with async_playwright() as p:
        browser=await p.chromium.launch(headless=True,executable_path='/usr/bin/chromium',args=['--no-sandbox','--disable-dev-shm-usage'])
        errors=[]
        for viewport,label in [({'width':390,'height':844},'mobile'),({'width':1440,'height':900},'desktop')]:
            context=await browser.new_context(viewport=viewport,device_scale_factor=1)
            page=await context.new_page();page.on('pageerror',lambda e:errors.append(str(e)))
            await page.route('https://tile.openstreetmap.org/**',lambda route:route.abort())
            await hydrate(page,SITE/'index.html',SITE/'styles.css',SCRIPTS)
            await page.wait_for_function('window.OSMANX_MAP_TEST_HOOKS?.approvedCount===1')
            await page.wait_for_function('document.querySelectorAll(".map-approved-pin").length===1')
            assert await page.locator('.map-approved-pin').count()==1
            assert await page.locator('#r3-reviewed-points .r3-point-card').count()==1
            assert 'Публичный ориентир' in await page.locator('#r3-reviewed-points').inner_text()
            assert 'Нет данных' in await page.locator('#public-funnel').inner_text()
            assert not await page.locator('#r2-lead-form').is_visible()
            await page.locator('#map-day-list button[data-day="2"]').click()
            await page.wait_for_function('document.querySelectorAll(".map-approved-pin").length===0')
            assert await page.locator('.map-approved-pin').count()==0
            await page.locator('#map-day-list button[data-day="1"]').click()
            await page.wait_for_function('document.querySelectorAll(".map-approved-pin").length===1')
            assert await page.locator('.map-approved-pin').count()==1
            assert await page.evaluate('document.documentElement.scrollWidth<=window.innerWidth+2'),'horizontal overflow '+label
            await page.screenshot(path=str(ROOT/('QA_R3_'+label+'.png')),full_page=True)
            if label=='mobile':
                await hydrate(page,SITE/'episodes/01/index.html',SITE/'styles.css',['content.js','app.js','geo.js','publication.js','public-r2.js','public-r3.js'])
                await page.wait_for_function("document.getElementById('episode-page-status').textContent==='Смотреть выпуск'")
                assert await page.locator('#episode-content video').count()==1
                assert await page.locator('#episode-content video').get_attribute('src')=='/assets/moscow/01.mp4'
                assert 'Разрешённое наблюдение' in await page.locator('#episode-r3').inner_text()
                await page.screenshot(path=str(ROOT/'QA_R3_episode_mobile.png'),full_page=True)
            await context.close()
        # Operator UI: mock signed server responses only for browser behavior; signature tests run in Node with real crypto.
        ctx=await browser.new_context(viewport={'width':390,'height':844})
        page=await ctx.new_page();page.on('pageerror',lambda e:errors.append(str(e)))
        editor=SITE/'editor';html=(editor/'index.html').read_text();html=re.sub(r'<script[^>]*src="[^"]*"[^>]*></script>','',html);html=re.sub(r'<link[^>]*rel="stylesheet"[^>]*>','',html)
        await page.set_content(html,wait_until='domcontentloaded');await page.add_style_tag(content=(editor/'editor.css').read_text())
        await page.evaluate('''()=>{window.__calls=[];window.confirm=()=>true;window.fetch=async(url,opt={})=>{const s=String(url),m=opt.method||'GET';window.__calls.push(m+' '+s);let data={ok:true};if(s.endsWith('/session'))data.actor={email:'editor@example.org',editor:true,approver:true,moderator:true};else if(s.endsWith('/editorial')&&m==='GET')data={ok:true,draft:{revision:0,document:{schemaVersion:3,method:'',metrics:null,days:[],markers:[],episodes:[]}},live:{status:'unpublished'}};else if(s.endsWith('/editorial')&&m==='PUT')data={ok:true,revision:1};else if(s.includes('/leads?'))data={ok:true,leads:[],nextOffset:null};else if(s.endsWith('/campaigns'))data={ok:true,campaigns:[],sendEnabled:false};else if(s.endsWith('/editorial/unpublish'))data={ok:true,status:'unpublished'};return {ok:true,json:async()=>data};};}''')
        await page.add_script_tag(content=(editor/'editor.js').read_text())
        await page.wait_for_function("document.getElementById('console').hidden===false")
        assert await page.locator('#save-draft').is_enabled()
        await page.locator('#method').fill('Методика с добровольными обезличенными данными.')
        await page.locator('#add-day').click()
        assert await page.locator('#days-editor .item').count()==1
        await page.locator('#days-editor textarea').first.fill('Проверенный итог без персональных данных.')
        await page.locator('#save-draft').click()
        await page.wait_for_function("document.getElementById('revision').textContent.includes('Ревизия 1')")
        await page.locator('[data-tab="leads"]').click()
        await page.wait_for_function("document.getElementById('leads-list').textContent.includes('нет обращений')")
        await page.locator('[data-tab="digest"]').click()
        await page.wait_for_function("document.getElementById('digest-info').textContent.includes('выключена')")
        assert await page.evaluate('document.documentElement.scrollWidth<=window.innerWidth+2')
        await page.screenshot(path=str(ROOT/'QA_R3_editor_mobile.png'),full_page=True)
        await ctx.close();await browser.close()
        assert not errors,'Chromium page errors: '+str(errors)
    print('PASS: R3 public + episode + editor Chromium mobile/desktop scripted behavior; all DOM assertions passed. Network services deliberately mocked.')
if __name__=='__main__':asyncio.run(main())
