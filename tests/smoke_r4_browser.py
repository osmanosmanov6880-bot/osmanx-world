"""R4 mobile and desktop Chromium smoke using source injection and explicitly mocked API; NOT a live staging test."""
import asyncio,re,json
from pathlib import Path
from playwright.async_api import async_playwright
ROOT=Path(__file__).resolve().parents[1];SITE=ROOT/'moscow-1000'
UID='a'*32
RELEASE={'schemaVersion':3,'status':'published','version':2,'reviewedAt':'2026-11-20T12:00:00Z','method':'Публикация разрешённых обезличенных материалов','metrics':None,'days':[{'day':1,'summary':'Разрешённый итог','lesson':'Дополнительные данные необходимы'}],'markers':[], 'episodes':[{'day':1,'title':'Реальный утверждённый фильм','videoUrl':'stream:'+UID,'iframeUrl':'https://customer-verifiedcode.cloudflarestream.com/'+UID+'/iframe','posterUrl':'https://customer-verifiedcode.cloudflarestream.com/'+UID+'/thumbnails/thumbnail.jpg','publishedAt':'2026-11-20T11:00:00Z','chapters':[{'second':0,'title':'Вступление'},{'second':60,'title':'Разговор'}]}]}
SCRIPTS=['content.js','geo.js','publication.js','app.js','map.js','public-r2.js','intake.js','public-r3.js']
async def inject(page,p,css,scripts,release=None):
 html=p.read_text(encoding='utf8');html=re.sub(r'<script[^>]*src="[^"]*"[^>]*></script>','',html);html=re.sub(r'<link[^>]*rel="stylesheet"[^>]*>','',html)
 await page.set_content(html,wait_until='domcontentloaded');await page.add_style_tag(content=css.read_text(encoding='utf8'))
 if release is not None:
  await page.evaluate('''(release)=>{window.history.replaceState=function(){};window.fetch=async(url,opts={})=>{const s=String(url);if(s.includes('/public-release'))return {ok:true,json:async()=>release};if(s.includes('/health'))return {ok:true,json:async()=>({leadsEnabled:false,subscriptionEnabled:false})};throw Error('mock network');};}''',release)
 for s in scripts:await page.add_script_tag(content=(SITE/s).read_text(encoding='utf8'))
async def main():
 async with async_playwright() as p:
  browser=await p.chromium.launch(headless=True,executable_path='/usr/bin/chromium',args=['--no-sandbox','--disable-dev-shm-usage'])
  errors=[]
  for size,name in [({'width':390,'height':844},'mobile'),({'width':1440,'height':900},'desktop')]:
   context=await browser.new_context(viewport=size,device_scale_factor=1);page=await context.new_page();page.on('pageerror',lambda e:errors.append(str(e)))
   await page.route('https://tile.openstreetmap.org/**',lambda route:route.abort())
   await inject(page,SITE/'index.html',SITE/'styles.css',SCRIPTS,RELEASE)
   await page.wait_for_function("document.querySelectorAll('#episode-list a.episode.published').length === 1")
   assert 'Нет данных' in await page.locator('#public-funnel').inner_text()
   assert await page.evaluate('document.documentElement.scrollWidth<=innerWidth+3'),name+' horizontal overflow'
   if name=='mobile':
    await inject(page,SITE/'episodes/01/index.html',SITE/'styles.css',['content.js','geo.js','publication.js','app.js','public-r2.js','public-r3.js'],RELEASE)
    await page.wait_for_function("document.querySelector('#episode-content iframe')!==null")
    assert await page.locator('#episode-content iframe').get_attribute('src')==RELEASE['episodes'][0]['iframeUrl']
    assert 'Вступление' in await page.locator('.r4-chapters').inner_text()
    assert await page.evaluate('document.documentElement.scrollWidth<=innerWidth+3')
    await page.screenshot(path=str(ROOT/'QA_R4_episode_mobile.png'),full_page=True)
   await context.close()
  context=await browser.new_context(viewport={'width':390,'height':844});page=await context.new_page();page.on('pageerror',lambda e:errors.append(str(e)))
  editor=SITE/'editor';await inject(page,editor/'index.html',editor/'editor.css',[],None)
  await page.evaluate('''()=>{window.confirm=()=>true;window.prompt=(s)=>s.includes('ID')?'rights_evidence_01':'Запрос на проверку архивного выпуска';window.fetch=async(url,opts={})=>{const s=String(url),m=opts.method||'GET';window.__r4calls=window.__r4calls||[];window.__r4calls.push(m+' '+s);let data={ok:true};if(s.endsWith('/session'))data={ok:true,actor:{email:'editor@example.org',editor:true,approver:true,moderator:true}};else if(s.endsWith('/editorial')&&m==='GET')data={ok:true,draft:{revision:0,document:{schemaVersion:3,method:'',metrics:null,days:[],markers:[],episodes:[]}},live:{status:'unpublished'}};else if(s.endsWith('/media')&&m==='GET')data={ok:true,configured:false,uploadEnabled:false,media:[{id:'11111111-1111-1111-1111-111111111111',day:1,title:'Проверяемый фильм',file_name:'episode.mp4',stream_uid:'${UID}',state:'ready',review_status:'pending',chapters:[]}]};else if(s.endsWith('/calendar')&&m==='GET')data={ok:true,days:[{day:1,title:'План',publish_at:'2026-12-20T12:00:00.000Z',status:'planned',revision:1,updated_by:'editor@example.org',checklist:{synopsis:'Краткий документальный план',checklist:{filmed:true,consents:false,music:true,captions:true,factCheck:true,poster:true}}}]};else if(s.endsWith('/backups')&&m==='GET')data={ok:true,backups:[]};else if(s.endsWith('/versions')&&m==='GET')data={ok:true,versions:[]};else if(s.includes('/media/')&&s.endsWith('/sync'))data={ok:true,state:'ready'};else if(s.includes('/leads'))data={ok:true,leads:[],nextOffset:null};else if(s.includes('/campaigns'))data={ok:true,campaigns:[],sendEnabled:false};return {ok:true,json:async()=>data};};}'''.replace('${UID}',UID))
  await page.add_script_tag(content=(editor/'editor.js').read_text(encoding='utf8'))
  await page.add_script_tag(content=(editor/'media-studio.js').read_text(encoding='utf8'))
  await page.wait_for_function('document.querySelector("#console").hidden===false')
  await page.locator('[data-tab="media"]').click();await page.wait_for_function('document.querySelector("#media-list").textContent.includes("Проверяемый фильм")')
  assert await page.locator('#media-list .r4-item').count()==1
  await page.locator('[data-tab="calendar"]').click();await page.wait_for_function('document.querySelector("#calendar-list").textContent.includes("План")')
  await page.locator('#calendar-list button').first.click();assert await page.locator('#calendar-form input[name="title"]').input_value()=='План'
  await page.locator('[data-tab="backups"]').click();await page.wait_for_function('document.querySelector("#backup-list").textContent.length>0')
  assert await page.evaluate('document.documentElement.scrollWidth<=innerWidth+3'),'editor horizontal overflow'
  await page.screenshot(path=str(ROOT/'QA_R4_editor_mobile.png'),full_page=True)
  await context.close();await browser.close()
  assert not errors,'JS errors: '+str(errors)
  print('PASS: R4 Chromium mobile/desktop + Stream episode iframe/chapters + operator media, calendar, backup tabs. Mocked network.')
asyncio.run(main())
