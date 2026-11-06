/**
 * Wave 6: dependency-free real Chromium browser acceptance via Chrome DevTools.
 *
 * Requires Node 22+ and installed Google Chrome/Chromium. Runs against a
 * one-user, loopback-only Python API backed by a disposable SQLite database.
 * This test never runs or launches an external production service.
 */
import assert from "node:assert/strict";
import {spawn, spawnSync, execFileSync} from "node:child_process";
import {existsSync, readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync} from "node:fs";
import {tmpdir} from "node:os";
import path from "node:path";
import {randomBytes} from "node:crypto";
import {fileURLToPath} from "node:url";

const thisFile=fileURLToPath(import.meta.url);
const repoRoot=path.resolve(path.dirname(thisFile),"../../..");
const packageRoot=path.join(repoRoot,"supreme-director","campaign180");
const projectId="0b83c3f2-b4ab-4a6f-a83e-a48cb39b9c6f";
const tenant="tenant_demo";
const actor="owner-abc";
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const token=randomBytes(48).toString("base64url");
const scratch=mkdtempSync(path.join(tmpdir(),"osgard-browser-"));
const database=path.join(scratch,"site.sqlite3");
const chromeProfile=path.join(scratch,"chrome-profile");
const port=18200+Math.floor(Math.random()*2400);
const baseUrl="http://127.0.0.1:"+port;
const artifacts=process.env.OSGARD_BROWSER_ARTIFACT_DIR ||
  path.join(scratch,"screenshots");
mkdirSync(artifacts,{recursive:true});
const pyEnv={...process.env,PYTHONPATH:packageRoot};
let pythonServer=null,chrome=null,client=null;

function which(...choices){
  for(const choice of choices){
    const outcome=spawnSync("which",[choice],{encoding:"utf8"});
    if(outcome.status===0 && outcome.stdout.trim())return outcome.stdout.trim();
  }
  return null;
}
const python=which("python3","python");
const chromeBin=which("google-chrome","google-chrome-stable","chromium","chromium-browser");

function seededInit(){
  if(!python)throw Error("Python unavailable");
  execFileSync(python,["-m","campaign180.local_http","init",
    "--database",database,"--spec",
    path.join(packageRoot,"examples","demo-site.json"),"--actor",actor],{
    env:pyEnv,stdio:["ignore","pipe","pipe"],timeout:30000});
}

async function poll(predicate,description,timeout=20000){
  const deadline=Date.now()+timeout;
  let last=null;
  while(Date.now()<deadline){
    try{
      const value=await predicate();
      if(value)return value;
    }catch(error){last=error;}
    await sleep(140);
  }
  let diagnostic="";
  if(client){
    try{
      const state=await client.eval("JSON.stringify({notice:document.querySelector('#notice')?.textContent,revision:document.querySelector('#editor-revision')?.textContent,active:document.querySelector('.panel.active')?.id,visibility:document.querySelector('#connect')?.hidden})");
      diagnostic="; browser state="+state;
    }catch(error){diagnostic="; diagnostic failed="+error.message;}
  }
  throw Error("Browser wait timed out: "+description+(last?": "+last.message:"")+diagnostic);
}

class Devtools{
  constructor(socket){
    this.socket=socket;
    this.count=0;
    this.pending=new Map();
    this.errors=[];
    socket.addEventListener("message",event=>{
      let message;
      try{message=JSON.parse(event.data);}catch{return;}
      if(message.id){
        const waiter=this.pending.get(message.id);
        if(!waiter)return;
        this.pending.delete(message.id);
        if(message.error)waiter.reject(Error("CDP "+message.error.message));
        else waiter.resolve(message.result);
      }else if(message.method==="Runtime.exceptionThrown"){
        this.errors.push(String(message.params?.exceptionDetails?.text||"runtime exception"));
      }
    });
  }

  send(method,params={}){
    const id=++this.count;
    return new Promise((resolve,reject)=>{
      this.pending.set(id,{resolve,reject});
      this.socket.send(JSON.stringify({id,method,params}));
    });
  }

  async eval(expression){
    const result=await this.send("Runtime.evaluate",{
      expression,returnByValue:true,awaitPromise:true});
    if(result.exceptionDetails){
      throw Error("Browser script error: "+result.exceptionDetails.text);
    }
    return result.result.value;
  }

  async screenshot(name){
    const result=await this.send("Page.captureScreenshot",{
      format:"png",captureBeyondViewport:false,fromSurface:true});
    const output=path.join(artifacts,name);
    writeFileSync(output,Buffer.from(result.data,"base64"));
    return output;
  }
}

async function createSession(url){
  if(typeof WebSocket!=="function")
    throw Error("Node 22+ is required for built-in WebSocket");
  const ws=new WebSocket(url);
  await new Promise((resolve,reject)=>{
    ws.addEventListener("open",resolve,{once:true});
    ws.addEventListener("error",reject,{once:true});
  });
  return new Devtools(ws);
}

async function localApi(url,options={}){
  const response=await fetch(baseUrl+url,{
    headers:{"Authorization":"Bearer "+token},...options});
  assert.equal(response.ok,true,url+" returned "+response.status);
  return response.json();
}

async function run(){
  if(!chromeBin)throw Error("Google Chrome/Chromium unavailable on test runner");
  seededInit();
  pythonServer=spawn(python,["-m","campaign180.local_http","serve",
    "--database",database,"--tenant",tenant,"--project-id",projectId,
    "--actor",actor,"--port",String(port)],{
    env:{...pyEnv,OSGARD_LOCAL_API_TOKEN:token},stdio:"ignore"});
  await poll(async()=>{
    try{
      const response=await fetch(baseUrl+"/console");
      return response.ok;
    }catch{return false;}
  },"loopback WSGI startup",30000);

  chrome=spawn(chromeBin,[
    "--headless=new","--no-sandbox","--disable-gpu","--disable-dev-shm-usage",
    "--no-first-run","--no-default-browser-check","--disable-background-networking",
    "--disable-extensions","--remote-allow-origins=*",
    "--remote-debugging-port=0","--user-data-dir="+chromeProfile,
    "--window-size=1440,960","about:blank"
  ],{stdio:"ignore"});
  const activePort=path.join(chromeProfile,"DevToolsActivePort");
  await poll(()=>existsSync(activePort),"Chromium DevToolsActivePort",30000);
  const debugPort=Number(readFileSync(activePort,"utf8").split("\n")[0]);
  assert.ok(debugPort>1024);
  const target=await poll(async()=>{
    const response=await fetch("http://127.0.0.1:"+debugPort+"/json/list");
    const targets=await response.json();
    return targets.find(t=>t.type==="page" && t.webSocketDebuggerUrl);
  },"Chromium page target");
  client=await createSession(target.webSocketDebuggerUrl);
  await client.send("Runtime.enable");
  await client.send("Page.enable");
  await client.send("Page.navigate",{url:baseUrl+"/console"});
  await poll(()=>client.eval("document.readyState==='complete' && !!document.querySelector('#auth-form')"),
             "console DOM ready");
  await client.eval("document.querySelector('#token').value="+JSON.stringify(token)+
                    ";document.querySelector('#auth-form').requestSubmit();true");
  await poll(()=>client.eval("document.querySelector('#connect').hidden && "+
       "document.querySelector('#metric-pages').textContent.trim()==='3'"),
       "authenticated dashboard");
  assert.equal(await client.eval("document.querySelector('#role-pill').textContent"),
               "Роль: owner");
  await client.screenshot("01-dashboard-desktop.png");

  // Add, rename, and preview a REAL page section via UI controls.
  await client.eval("document.querySelector('[data-panel=pages]').click();"+
    "document.querySelector('#new-section-type').value='text';"+
    "document.querySelector('#add-section').click();");
  await poll(()=>client.eval("document.querySelector('#editor-revision').textContent.includes('2')"),
    "structure add revision");
  assert.ok((await client.eval("document.querySelector('#section-count').textContent")).includes("4"));
  await client.eval("document.querySelector('#section-heading').value='Секция из Chromium';"+
    "document.querySelector('#section-text').value='Настоящая браузерная проверка';"+
    "document.querySelector('#page-form').requestSubmit();");
  await poll(()=>client.eval("document.querySelector('#editor-revision').textContent.includes('3')"),
    "page text edit revision");
  await client.eval("document.querySelector('[data-panel=preview]').click();");
  await poll(()=>client.eval("document.querySelector('#preview-frame').srcdoc.includes('Секция из Chromium')"),
    "isolated preview updates");
  await client.screenshot("02-page-preview-desktop.png");

  // Create a customer with actual form input and confirm via authenticated API.
  await client.eval("document.querySelector('[data-panel=records]').click();"+
    "document.querySelector('#field-name').value='Клиент браузерного теста';"+
    "document.querySelector('#row-form').requestSubmit();");
  await poll(()=>client.eval("document.querySelector('#rows-table').textContent.includes('Клиент браузерного теста')"),
    "customer created from UI");
  const rows=await localApi("/api/v1/models/customers");
  const clientRow=rows.rows.find(x=>x.fields.name==="Клиент браузерного теста");
  assert.ok(clientRow && clientRow.row_id);

  // Create manual workflow through visual builder, run it via real button.
  await client.eval("document.querySelector('[data-panel=workflows]').click();"+
    "document.querySelector('#wf-name').value='Заполнить контакт';"+
    "document.querySelector('#wf-action-field').value='email';"+
    "document.querySelector('#wf-action-value').value='manual@example.org';"+
    "document.querySelector('#workflow-form').requestSubmit();");
  await poll(()=>client.eval("document.querySelector('#metric-workflows').textContent.trim()==='1'"),
    "manual workflow from UI");
  await client.eval("document.querySelector('#wf-run-row').value="+JSON.stringify(clientRow.row_id)+
    ";document.querySelector('.workflow-item button.ghost').click();");
  await poll(async()=>{
    const value=await localApi("/api/v1/models/customers");
    return value.rows.some(x=>x.row_id===clientRow.row_id && x.fields.email==="manual@example.org");
  },"manual workflow changed SQLite");

  // Add a genuine automatic rule; new record should trigger it without run button.
  await client.eval("document.querySelector('#wf-name').value='Новый клиент';"+
    "document.querySelector('#wf-trigger').value='record.created';"+
    "document.querySelector('#wf-action-field').value='email';"+
    "document.querySelector('#wf-action-value').value='auto@example.org';"+
    "document.querySelector('#workflow-form').requestSubmit();");
  await poll(()=>client.eval("document.querySelector('#metric-workflows').textContent.trim()==='2'"),
    "automatic rule from UI");
  await client.eval("document.querySelector('[data-panel=records]').click();"+
    "document.querySelector('#new-row').click();"+
    "document.querySelector('#field-name').value='Автоклиент';"+
    "document.querySelector('#row-form').requestSubmit();");
  await poll(async()=>{
    const value=await localApi("/api/v1/models/customers");
    return value.rows.some(x=>x.fields.name==="Автоклиент" &&
                              x.fields.email==="auto@example.org" && x.version===2);
  },"record.created rule automatically fired");
  await client.screenshot("03-data-desktop.png");

  // Wave 7: create a model from the visual schema editor.
  await client.eval("document.querySelector('[data-panel=schema]').click();"+
    "document.querySelector('#schema-model-name').value='vendors';"+
    "document.querySelector('#schema-model-label').value='Поставщики';"+
    "document.querySelector('#schema-model-form').requestSubmit();");
  await poll(()=>client.eval("document.querySelector('#metric-models').textContent.trim()==='3'"),
    "schema model created through browser");
  // Create one real vendor row, then migrate it with a required typed default.
  await client.eval("document.querySelector('[data-panel=records]').click();"+
    "document.querySelector('#model-select').value='vendors';"+
    "document.querySelector('#model-select').dispatchEvent(new Event('change'));");
  await poll(()=>client.eval("document.querySelector('#model-description')?.textContent.includes('1 полей') && "+
    "document.querySelector('#row-fields #field-name')?.disabled===false"),
    "vendor data entry form fully updated");
  await client.eval("document.querySelector('#field-name').value='Поставщик CI';"+
    "document.querySelector('#row-form').requestSubmit();");
  await poll(async()=>{
    const data=await localApi("/api/v1/models/vendors");
    return data.rows.some(row=>row.fields.name==="Поставщик CI");
  },"vendor row created");
  await client.eval("document.querySelector('[data-panel=schema]').click();"+
    "document.querySelector('#schema-select-model').value='vendors';"+
    "document.querySelector('#schema-field-name').value='level';"+
    "document.querySelector('#schema-field-label').value='Уровень';"+
    "document.querySelector('#schema-field-type').value='integer';"+
    "document.querySelector('#schema-field-type').dispatchEvent(new Event('change'));"+
    "document.querySelector('#schema-field-required').checked=true;"+
    "document.querySelector('#schema-default').value='2';"+
    "document.querySelector('#schema-field-form').requestSubmit();");
  await poll(async()=>{
    const data=await localApi("/api/v1/models/vendors");
    return data.rows.some(row=>row.fields.name==="Поставщик CI" &&
      row.fields.level===2 && row.version===2);
  },"typed field migration of existing vendor row");
  const changes=await localApi("/api/v1/schema/migrations");
  assert.ok(changes.migrations.some(x=>x.operation==="ADD_FIELD"&&x.rows_migrated===1));
  // Add a form section generated from the updated typed model.
  await client.eval("document.querySelector('[data-panel=pages]').click();"+
    "document.querySelector('#new-section-type').value='form';"+
    "document.querySelector('#new-section-type').dispatchEvent(new Event('change'));"+
    "document.querySelector('#form-model-select').value='vendors';"+
    "document.querySelector('#add-section').click();");
  await poll(async()=>{
    const spec=await localApi("/api/v1/spec");
    return spec.spec.pages[0].sections.some(x=>x.type==="form"&&x.model==="vendors");
  },"form section saved by editor");
  const serverRendered=await poll(async()=>{
    const result=await localApi("/api/v1/preview/home");
    return result.html.includes('<form class="demo-form">') &&
      result.html.includes('<button type="button" disabled>') &&
      result.production_published===false;
  },"server generated disabled model-backed form");
  await client.eval("document.querySelector('[data-panel=preview]').click();"+
    "document.querySelector('#preview-select').value='home';"+
    "document.querySelector('#refresh-preview').click();");
  await poll(()=>client.eval(`(()=>{
    const src=document.querySelector('#preview-frame').srcdoc;
    const doc=new DOMParser().parseFromString(src,"text/html");
    const form=doc.querySelector("form.demo-form");
    return Boolean(form && form.querySelector('button[type="button"]:disabled')
      && [...form.querySelectorAll("input")].length>=2
      && [...form.querySelectorAll("input")].every(input=>input.disabled));
  })()`),"actual non-submittable form DOM in preview");
  await client.screenshot("04-schema-form-desktop.png");

  // Mobile viewport must not leak navigation or overflow the viewport.
  await client.send("Emulation.setDeviceMetricsOverride",{
    width:390,height:844,deviceScaleFactor:1,mobile:true});
  await poll(()=>client.eval("innerWidth===390"),"mobile viewport");
  const overflow=await client.eval(
    "document.documentElement.scrollWidth-document.documentElement.clientWidth");
  assert.ok(overflow<=2,"mobile horizontal overflow: "+overflow);
  await client.screenshot("05-mobile-390.png");
  assert.deepEqual(client.errors,[],"browser runtime exceptions");
  return {browser:"Chromium",flows:["auth","structure","page-edit","preview",
    "record-create","manual-workflow","automatic-workflow","schema-model","field-migration","form-section","mobile"],
    console_exceptions:client.errors.length,horizontal_overflow:overflow,
    screenshots:5,public_server_started:false,production_deployed:false};
}

try{
  const result=await run();
  console.log("BROWSER_ACCEPTANCE_SUCCESS "+JSON.stringify(result));
}catch(error){
  console.error("BROWSER_ACCEPTANCE_FAILED "+error.message);
  process.exitCode=1;
}finally{
  if(client?.socket)client.socket.close();
  if(chrome){chrome.kill("SIGTERM");await sleep(250);if(chrome.exitCode===null)chrome.kill("SIGKILL");}
  if(pythonServer){pythonServer.kill("SIGTERM");await sleep(250);if(pythonServer.exitCode===null)pythonServer.kill("SIGKILL");}
  if(!process.env.OSGARD_BROWSER_ARTIFACT_DIR)rmSync(scratch,{recursive:true,force:true});
}
