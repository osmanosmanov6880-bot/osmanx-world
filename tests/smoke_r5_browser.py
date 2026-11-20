"""R5 Chromium UI smoke with explicitly mocked Cloudflare calls. NOT public HTTPS or real uploads."""
import asyncio,re
from pathlib import Path
from playwright.async_api import async_playwright
ROOT=Path(__file__).resolve().parents[1]; E=ROOT/'moscow-1000/editor'
MOCK="""()=>{
 window.__upload={offset:0,patches:0,interrupted:false,requestKinds:[]};
 window.confirm=()=>true;window.prompt=()=> 'rights-verified';
 const uid='aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
 const response=(data,status=200)=>({ok:status>=200&&status<300,status,json:async()=>data});
 window.fetch=async(url,opts={})=>{
  const s=String(url),method=opts.method||'GET',u=window.__upload;u.requestKinds.push(method+' '+(s.startsWith('https:')?'stream':'api'));
  if(s.includes('upload.videodelivery.net')){
   if(method==='HEAD')return new Response(null,{status:200,headers:{'Upload-Offset':String(u.offset)}});
   if(method==='PATCH'){
    u.patches++;
    if(u.patches===2&&!u.interrupted){u.interrupted=true;throw new Error('network interrupted');}
    const before=Number(opts.headers['Upload-Offset']);if(before!==u.offset)throw Error('Repeated or incorrect offset');
    u.offset+=opts.body.size;return new Response(null,{status:204,headers:{'Upload-Offset':String(u.offset)}});
   }
  }
  if(s.endsWith('/session'))return response({ok:true,actor:{email:'editor@osmanx.example',editor:true,approver:true,moderator:true}});
  if(s.endsWith('/editorial')&&method==='GET')return response({ok:true,draft:{revision:0,document:{schemaVersion:3,method:'',metrics:null,days:[],markers:[],episodes:[]}},live:{status:'unpublished'}});
  if(s.endsWith('/media')&&method==='GET')return response({ok:true,configured:true,uploadEnabled:true,media:[]});
  if(s.endsWith('/media/tus')&&method==='POST')return response({ok:true,id:'11111111-1111-1111-1111-111111111111',uploadURL:'https://upload.videodelivery.net/'+uid,streamUid:uid,protocol:'tus-1.0.0'},201);
  if(s.endsWith('/calendar')&&method==='GET')return response({ok:true,days:[]});
  if(s.endsWith('/backups')&&method==='GET')return response({ok:true,backups:[]});
  if(s.endsWith('/versions')&&method==='GET')return response({ok:true,versions:[]});
  if(s.includes('/leads'))return response({ok:true,leads:[]});
  if(s.includes('/campaigns'))return response({ok:true,campaigns:[]});
  throw new Error('Unexpected mocked path '+s);
 }
}"""
async def one(browser,size,label):
 ctx=await browser.new_context(viewport=size,device_scale_factor=1);page=await ctx.new_page();errors=[];page.on('pageerror',lambda exc:errors.append(str(exc)))
 html=(E/'index.html').read_text();html=re.sub(r'<script[^>]*src="[^"]*"[^>]*></script>','',html);html=re.sub(r'<link[^>]*rel="stylesheet"[^>]*>','',html)
 await page.set_content(html,wait_until='domcontentloaded');await page.add_style_tag(content=(E/'editor.css').read_text());await page.evaluate(MOCK)
 for f in ['editor.js','tus-client.js','media-studio.js']:await page.add_script_tag(content=(E/f).read_text());
 await page.wait_for_function('document.querySelector("#console").hidden===false')
 await page.locator('[data-tab="media"]').click();await page.wait_for_function('document.querySelector("#media-status").textContent.length>0')
 assert await page.locator('#media-upload-pause').is_disabled()
 await page.locator('#media-upload-form input[name="title"]').fill('Интеграционный тест видео')
 await page.locator('#media-upload-form input[type="file"]').set_input_files({'name':'synthetic.mp4','mimeType':'video/mp4','buffer':bytes(13*1024*1024)})
 await page.locator('#media-upload-start').click()
 await page.wait_for_function('document.querySelector("#media-upload-resume").disabled===false',timeout=15000)
 assert await page.evaluate('window.__upload.offset')==8*1024*1024
 assert 'network interrupted' in (await page.locator('#media-status').inner_text()).lower()
 await page.locator('#media-upload-resume').click();await page.wait_for_function('document.querySelector("#media-upload-percent").textContent==="100%"')
 assert await page.evaluate('window.__upload.offset')==13*1024*1024
 assert await page.evaluate('window.__upload.patches')==3
 assert await page.evaluate('document.documentElement.scrollWidth<=window.innerWidth+3'),label+' horizontal overflow'
 await page.screenshot(path=str(ROOT/('QA_R5_'+label+'.png')),full_page=True)
 assert not errors,errors
 await ctx.close();return {'viewport':label,'tusPatches':3,'replayed':False,'noJsErrors':True}
async def main():
 async with async_playwright() as p:
  browser=await p.chromium.launch(headless=True,executable_path='/usr/bin/chromium',args=['--no-sandbox','--disable-dev-shm-usage']);results=[]
  for sz,name in [({'width':390,'height':844},'mobile'),({'width':1440,'height':900},'desktop')]:results.append(await one(browser,sz,name))
  await browser.close();print('PASS R5 Chromium UI source-injection mocks:',results)
asyncio.run(main())
