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
  // Disposable worker for the browser's strictly non-persistent Wave23 preview.
  const addWorker = "from campaign180.app_runtime import LocalAppRuntime; " +
    "import sys; rt=LocalAppRuntime(sys.argv[1]); " +
    "rt.policy.add_member(tenant='tenant_demo'," +
    "project_id='0b83c3f2-b4ab-4a6f-a83e-a48cb39b9c6f'," +
    "owner_actor='owner-abc',member_actor='operator-abc'," +
    "role='operator',now=1799971201)";
  execFileSync(python,["-c",addWorker,database],{
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
      const state=await client.eval("JSON.stringify({notice:document.querySelector('#notice')?.textContent,revision:document.querySelector('#editor-revision')?.textContent,active:document.querySelector('.panel.active')?.id,visibility:document.querySelector('#connect')?.hidden,ready:document.documentElement.dataset.consoleReady,tokenLength:document.querySelector('#token')?.value.length,formValid:document.querySelector('#auth-form')?.checkValidity(),scripts:[...document.scripts].map(s=>s.src)})");
      diagnostic="; browser state="+state+"; runtime errors="+client.errors.slice(-5).join("|");
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
  await poll(()=>client.eval("document.documentElement.dataset.consoleReady==='1'"),
             "application JavaScript initialized");
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
  await poll(()=>client.eval("document.querySelector('#notice')?.textContent.startsWith('Поле добавлено')"),
    "browser schema migration refresh complete");
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
  await poll(()=>client.eval("document.querySelector('#notice')?.textContent.startsWith('Структура обновлена')"),
    "form section editor UI refresh complete");
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

  // Wave 8: edit actual form properties and select only a typed field.
  await client.eval("document.querySelector('[data-panel=pages]').click();");
  await poll(()=>client.eval("document.querySelector('#form-editor').hidden===false && "+
    "document.querySelector('#edit-form-fields [data-name=level]')!==null"),
    "form properties editor with model fields");
  await client.eval("document.querySelector('#edit-form-heading').value='Заявка поставщика';"+
    "document.querySelector('#edit-form-button').value='Отправить';"+
    "document.querySelector('#edit-form-fields [data-name=name] input').checked=false;"+
    "document.querySelector('#form-editor').requestSubmit();");
  await poll(async()=>{
    const snapshot=await localApi("/api/v1/spec");
    const form=snapshot.spec.pages[0].sections.find(x=>x.type==="form"&&x.model==="vendors");
    return form?.heading==="Заявка поставщика" &&
      JSON.stringify(form.fields)===JSON.stringify(["level"]) &&
      form.button_label==="Отправить";
  },"selected form fields and button saved by UI");

  await poll(()=>client.eval("document.querySelector('#notice')?.textContent.startsWith('Настройки формы сохранены')"),
    "form properties UI refresh complete");
  // Relational records use tenant-bound dropdowns, not raw UUID input.
  await client.eval("document.querySelector('[data-panel=records]').click();"+
    "document.querySelector('#model-select').value='requests';"+
    "document.querySelector('#model-select').dispatchEvent(new Event('change'));");
  await poll(()=>client.eval("document.querySelector('#field-customer')?.tagName==='SELECT'"+
    " && !document.querySelector('#field-customer').disabled "+
    " && document.querySelector('#field-customer').options.length>=2"),
    "reference options loaded within tenant");
  await client.eval("document.querySelector('#field-customer').value="+JSON.stringify(clientRow.row_id)+
    ";document.querySelector('#field-summary').value='Связанная заявка из Chromium';"+
    "document.querySelector('#row-form').requestSubmit();");
  await poll(async()=>{
    const data=await localApi("/api/v1/models/requests");
    return data.rows.some(x=>x.fields.summary==="Связанная заявка из Chromium"
      && x.fields.customer===clientRow.row_id);
  },"relational record persisted via dropdown");
  await poll(()=>client.eval("document.querySelector('#notice')?.textContent.startsWith('Запись сохранена')"),
    "related record editor refresh complete");
  await client.screenshot("05-reference-editor-desktop.png");

  // Schema rename must preserve actual vendor data and selected form fields.
  await client.eval("document.querySelector('[data-panel=schema]').click();"+
    "document.querySelector('#schema-rename-model').value='vendors';"+
    "document.querySelector('#schema-rename-model').dispatchEvent(new Event('change'));"+
    "document.querySelector('#schema-rename-source').value='level';"+
    "document.querySelector('#schema-rename-target').value='tier';"+
    "document.querySelector('#schema-rename-approve').checked=true;"+
    "document.querySelector('#schema-rename-form').requestSubmit();");
  await poll(async()=>{
    const [vendors,spec]=await Promise.all([
      localApi("/api/v1/models/vendors"),localApi("/api/v1/spec")]);
    const row=vendors.rows.find(x=>x.fields.name==="Поставщик CI");
    const form=spec.spec.pages[0].sections.find(x=>x.type==="form"&&x.model==="vendors");
    return row?.fields.tier===2 && !Object.hasOwn(row.fields,"level") &&
      row.version===3 && JSON.stringify(form?.fields)===JSON.stringify(["tier"]);
  },"atomic field rename rewrote row and form metadata");
  await poll(()=>client.eval("document.querySelector('#notice')?.textContent.startsWith('Поле переименовано')"),
    "field rename visual refresh complete");
  await client.eval("document.querySelector('[data-panel=preview]').click();"+
    "document.querySelector('#preview-select').value='home';"+
    "document.querySelector('#refresh-preview').click();");
  await poll(()=>client.eval(
    "(()=>{const src=document.querySelector('#preview-frame').srcdoc;"+
    "const doc=new DOMParser().parseFromString(src,'text/html');"+
    "const form=doc.querySelector('form.demo-form');"+
    "return !!form && form.querySelectorAll('input[type=number]:disabled').length===1"+
    " && form.querySelectorAll('input').length===1"+
    " && form.querySelector('button[type=button]:disabled')!==null;})()"),
    "migrated form remains non-submittable");
  await client.screenshot("06-renamed-form-desktop.png");

  // Wave 9: visual reference-field migration preserves a real linked request.
  await client.eval("document.querySelector('[data-panel=schema]').click();"+
    "document.querySelector('#link-rename-model').value='requests';"+
    "document.querySelector('#link-rename-model').dispatchEvent(new Event('change'));"+
    "document.querySelector('#link-rename-field').value='customer';"+
    "document.querySelector('#link-new-name').value='client_ref';"+
    "document.querySelector('#link-rename-confirm').checked=true;"+
    "document.querySelector('#link-rename-form').requestSubmit();");
  await poll(async()=>{
    const rows=await localApi("/api/v1/models/requests");
    return rows.rows.some(row=>row.fields.summary==="Связанная заявка из Chromium"
      && row.fields.client_ref===clientRow.row_id && row.version===2
      && !Object.hasOwn(row.fields,"customer"));
  },"relation rename preserved actual row value and revision");
  await poll(()=>client.eval(
    "document.querySelector('#notice')?.textContent.startsWith('Поле-связь мигрировано')"),
    "reference migration editor refreshed");
  await client.screenshot("07-relation-migration-desktop.png");

  // An *unused* relation can change target without rewriting any existing data.
  await client.eval("document.querySelector('#schema-select-model').value='vendors';"+
    "document.querySelector('#schema-field-name').value='assignee';"+
    "document.querySelector('#schema-field-label').value='Связанная заявка';"+
    "document.querySelector('#schema-field-type').value='reference';"+
    "document.querySelector('#schema-field-type').dispatchEvent(new Event('change'));"+
    "document.querySelector('#schema-reference-model').value='customers';"+
    "document.querySelector('#schema-field-required').checked=false;"+
    "document.querySelector('#schema-field-form').requestSubmit();");
  await poll(async()=>{
    const spec=await localApi("/api/v1/spec");
    const field=spec.spec.models.find(x=>x.name==="vendors")?.fields.find(x=>x.name==="assignee");
    return field?.type==="reference"&&field.references==="customers";
  },"unused relation field declared");
  await poll(()=>client.eval(
    "document.querySelector('#notice')?.textContent.startsWith('Поле добавлено')"),
    "reference field declaration UI refreshed");
  await client.eval("document.querySelector('#link-retarget-model').value='vendors';"+
    "document.querySelector('#link-retarget-model').dispatchEvent(new Event('change'));"+
    "document.querySelector('#link-retarget-field').value='assignee';"+
    "document.querySelector('#link-target-model').value='requests';"+
    "document.querySelector('#link-retarget-confirm').checked=true;"+
    "document.querySelector('#link-retarget-form').requestSubmit();");
  await poll(async()=>{
    const spec=await localApi("/api/v1/spec");
    const field=spec.spec.models.find(x=>x.name==="vendors")?.fields.find(x=>x.name==="assignee");
    return field?.references==="requests";
  },"empty reference retargeted with schema revision");
  await poll(()=>client.eval(
    "document.querySelector('#notice')?.textContent.startsWith('Целевая модель изменена')"),
    "empty reference retarget UI refreshed");

  // A page-only revision change permits a data-preserving, inspect-first restore.
  const beforePageEdit=await localApi("/api/v1/spec");
  const oldTitle=beforePageEdit.spec.pages.find(x=>x.slug==="home").title;
  await client.eval("document.querySelector('[data-panel=pages]').click();"+
    "document.querySelector('#page-select').value='home';"+
    "document.querySelector('#page-select').dispatchEvent(new Event('change'));"+
    "document.querySelector('#page-title').value='Временное название Wave 9';"+
    "document.querySelector('#page-form').requestSubmit();");
  await poll(async()=>{
    const spec=await localApi("/api/v1/spec");
    return spec.revision===beforePageEdit.revision+1 &&
      spec.spec.pages.find(x=>x.slug==="home").title==="Временное название Wave 9";
  },"temporary page title persisted");
  await poll(()=>client.eval(
    "document.querySelector('#notice')?.textContent.startsWith('Новая ревизия')"),
    "page title visual editor refreshed");
  await client.eval("document.querySelector('[data-panel=history]').click();");
  await poll(()=>client.eval("document.querySelector('#history-revision')?.options.length>0"),
    "historical revision options displayed");
  await client.eval("document.querySelector('#history-revision').value="+
    JSON.stringify(String(beforePageEdit.revision))+";"+
    "document.querySelector('#history-revision').dispatchEvent(new Event('change'));"+
    "document.querySelector('#history-inspect-form').requestSubmit();");
  await poll(()=>client.eval("document.querySelector('#history-plan').hidden===false "+
    "&& document.querySelector('#history-plan-summary').textContent.includes('"+
    "v"+beforePageEdit.revision+"')"),
    "restore preview with exact historical revision");
  await client.eval("document.querySelector('#history-approve').checked=true;"+
    "document.querySelector('#history-approve').dispatchEvent(new Event('change'));"+
    "document.querySelector('#history-apply').click();");
  await poll(async()=>{
    const [spec,requests,vendors]=await Promise.all([
      localApi("/api/v1/spec"),localApi("/api/v1/models/requests"),
      localApi("/api/v1/models/vendors")]);
    return spec.revision===beforePageEdit.revision+2 &&
      spec.spec.pages.find(x=>x.slug==="home").title===oldTitle &&
      requests.rows.some(x=>x.fields.client_ref===clientRow.row_id) &&
      vendors.rows.some(x=>x.fields.name==="Поставщик CI"&&x.fields.tier===2);
  },"approved page restore creates new revision and preserves business rows");
  await poll(()=>client.eval(
    "document.querySelector('#notice')?.textContent.startsWith('Создана новая версия')"),
    "restore UI refreshed after committing snapshot");
  await client.screenshot("08-restore-confirmation-desktop.png");

  // Wave 10: map the existing live relation to an explicitly chosen vendor.
  const vendorsForMap=await localApi("/api/v1/models/vendors");
  const vendorTarget=vendorsForMap.rows.find(x=>x.fields.name==="Поставщик CI");
  assert.ok(vendorTarget?.row_id,"vendor target must exist for explicit mapping");
  await client.eval("document.querySelector('[data-panel=schema]').click();"+
    "document.querySelector('#map-model').value='requests';"+
    "document.querySelector('#map-model').dispatchEvent(new Event('change'));"+
    "document.querySelector('#map-field').value='client_ref';"+
    "document.querySelector('#map-target-model').value='vendors';"+
    "document.querySelector('#map-options-form').requestSubmit();");
  await poll(()=>client.eval("document.querySelectorAll('#map-rows .mapped-row').length===1 "+
    "&& document.querySelector('#map-review-form').hidden===false"),
    "mapped migration wizard loaded one old source value");
  await client.eval("document.querySelector('#map-rows .mapped-row select').value="+
    JSON.stringify(vendorTarget.row_id)+";"+
    "document.querySelector('#map-rows .mapped-row select').dispatchEvent(new Event('change'));"+
    "document.querySelector('#map-review-form').requestSubmit();");
  await poll(()=>client.eval("document.querySelector('#map-approval').hidden===false "+
    "&& document.querySelector('#map-plan-digest').textContent.includes('SHA-256')"),
    "mapping preview and SHA-256 generated");
  await client.eval("document.querySelector('#map-approve').checked=true;"+
    "document.querySelector('#map-approve').dispatchEvent(new Event('change'));"+
    "document.querySelector('#map-apply').click();");
  await poll(async()=>{
    const [rows,spec]=await Promise.all([
      localApi("/api/v1/models/requests"),localApi("/api/v1/spec")]);
    const target=spec.spec.models.find(m=>m.name==="requests")
      ?.fields.find(f=>f.name==="client_ref")?.references;
    return target==="vendors" && rows.rows.some(r=>
      r.fields.summary==="Связанная заявка из Chromium" &&
      r.fields.client_ref===vendorTarget.row_id && r.version===3);
  },"live foreign key remapped and link schema updated");
  await poll(()=>client.eval("document.querySelector('#notice')?.textContent.startsWith('Связи перенесены')"),
    "mapping wizard UI refreshed");
  await client.screenshot("09-approved-live-remap-desktop.png");

  // Owner-only metadata check: the full recovery archive must never be sent over HTTP.
  await client.eval("document.querySelector('[data-panel=history]').click();"+
    "document.querySelector('#recovery-inspect').click();");
  await poll(()=>client.eval("document.querySelector('#recovery-summary').textContent.includes('SQLite ok') "+
    "&& document.querySelector('#recovery-summary').textContent.includes('SHA ')"),
    "project recovery integrity summary");
  const recovery=await localApi("/api/v1/recovery/inspect");
  assert.ok(recovery.records>=4);
  assert.ok(recovery.links>=1);
  assert.equal(recovery.plaintext_exported,false);
  assert.equal(recovery.includes_roles,false);
  await client.screenshot("10-recovery-integrity-desktop.png");
  await client.eval("document.querySelector('#recovery-drill').click();");
  await poll(()=>client.eval(
    "document.querySelector('#recovery-drill-summary')?.textContent.startsWith('PASS')"),
    "verified isolated recovery drill");
  const afterDrill=await localApi("/api/v1/recovery/inspect");
  assert.equal(afterDrill.bundle_sha256,recovery.bundle_sha256);
  await client.screenshot("11-drill-desktop.png");

  // Wave 15: a configured model-backed form now submits a REAL SQLite row
  // from the interactive console, while static iframe preview stays inert.
  await client.eval("document.querySelector('[data-panel=pages]').click();"+
    "document.querySelector('#page-select').value='home';"+
    "document.querySelector('#page-select').dispatchEvent(new Event('change'));"+
    "document.querySelector('#new-section-type').value='form';"+
    "document.querySelector('#new-section-type').dispatchEvent(new Event('change'));"+
    "document.querySelector('#form-model-select').value='customers';"+
    "document.querySelector('#add-section').click();");
  await poll(()=>client.eval(
    "document.querySelector('#live-form').hidden===false "+
    "&& document.querySelector('#live-name')!==null"),
    "Wave 15 active form is visible in the existing console");
  await client.eval("document.querySelector('#live-name').value='Заявка из формы Wave 15';"+
    "document.querySelector('#live-form').requestSubmit();");
  await poll(async()=>{
    const rows=await localApi("/api/v1/models/customers");
    return rows.rows.some(r=>r.fields.name==="Заявка из формы Wave 15");
  },"Wave 15 browser form persisted an actual SQLite customer");
  await poll(()=>client.eval(
    "document.querySelector('#live-form-status').textContent.includes('Сохранено в SQLite')"),
    "Wave 15 submission receipt displayed in Russian UI");
  await client.screenshot("14-live-form-submission-desktop.png");

  // Wave 16: casefold-aware search, inspected CSV file and transactional import
  // from the real browser UI; new rows must exist in the loopback SQLite service.
  await client.eval("document.querySelector('[data-panel=records]').click();"+
    "document.querySelector('#model-select').value='customers';"+
    "document.querySelector('#model-select').dispatchEvent(new Event('change'));");
  await poll(()=>client.eval(
    "document.querySelector('#model-select').value==='customers' && "+
    "document.querySelector('#record-page-info').textContent.includes('Показаны')"),
    "Wave 16 model query initialized");
  await client.eval("document.querySelector('#record-search').value='wAvE 15';"+
    "document.querySelector('#record-find').click();");
  await poll(()=>client.eval(
    "document.querySelector('#record-page-info').textContent.includes('из 1') && "+
    "document.querySelector('#rows-table').textContent.includes('Wave 15')"),
    "Wave 16 casefold-aware real model search");
  await client.eval("(()=>{"+
    "const csv='name,email\\nКлиент Wave 16,wave16@example.org\\n';"+
    "const file=new File([csv],'wave16.csv',{type:'text/csv'});"+
    "const transfer=new DataTransfer();transfer.items.add(file);"+
    "const input=document.querySelector('#record-csv-file');"+
    "input.files=transfer.files;input.dispatchEvent(new Event('change',{bubbles:true}));"+
    "document.querySelector('#record-csv-inspect').click();return true;})()");
  await poll(()=>client.eval(
    "document.querySelector('#record-csv-summary').textContent.includes('Проверено: 1') "+
    "&& !document.querySelector('#record-csv-approve').disabled"),
    "Wave 16 CSV inspection returned deterministic plan digest");
  await client.eval("document.querySelector('#record-csv-approve').checked=true;"+
    "document.querySelector('#record-csv-approve').dispatchEvent(new Event('change'));"+
    "document.querySelector('#record-csv-apply').click();");
  await poll(async()=>{
    const data=await localApi("/api/v1/models/customers");
    // The existing record.created workflow normalizes the email during import.
    return data.rows.some(x=>x.fields.name==="Клиент Wave 16" &&
                              x.fields.email==="auto@example.org" && x.version===2);
  },"Wave 16 CSV apply persisted an actual SQLite row");
  await poll(()=>client.eval(
    "document.querySelector('#notice').textContent.includes('Импортировано в SQLite: 1')"),
    "Wave 16 CSV import receipt visible in UI");
  await client.eval("document.querySelector('#record-search').value='wAvE 16';"+
    "document.querySelector('#record-find').click();");
  await poll(()=>client.eval(
    "document.querySelector('#rows-table').textContent.includes('Клиент Wave 16') "+
    "&& document.querySelector('#record-page-info').textContent.includes('из 1')"),
    "Wave 16 imported row is searchable");
  await client.eval("document.querySelector('#record-export').click();");
  await poll(()=>client.eval(
    "document.querySelector('#notice').textContent.includes('CSV подготовлен: 1')"),
    "Wave 16 local UTF-8 CSV export completes");
  await client.screenshot("15-records-import-export-desktop.png");

  // Wave 17: edit an existing SQLite record through the real multi-select
  // and verify immutable journal + guarded forward-revision undo from the UI.
  await poll(()=>client.eval(
    "document.querySelector('#rows-table input[data-batch-row-id]')!==null "+
    "&& document.querySelector('#batch-field')?.options.length>=2"),
    "Wave 17 checkable model rows and typed field control");
  await client.eval("document.querySelector('#rows-table input[data-batch-row-id]').click();"+
    "document.querySelector('#batch-field').value='name';"+
    "document.querySelector('#batch-field').dispatchEvent(new Event('change'));"+
    "document.querySelector('#batch-value').value='Изменение Wave 17';"+
    "document.querySelector('#batch-inspect').click();");
  await poll(()=>client.eval(
    "document.querySelector('#batch-summary').textContent.includes('Проверено: 1') "+
    "&& !document.querySelector('#batch-approve').disabled"),
    "Wave 17 multi-edit inspection returned one SHA-256 plan");
  await client.eval("document.querySelector('#batch-approve').checked=true;"+
    "document.querySelector('#batch-approve').dispatchEvent(new Event('change'));"+
    "document.querySelector('#batch-apply').click();");
  await poll(async()=>{
    const result=await localApi("/api/v1/models/customers");
    return result.rows.some(r=>r.fields.name==="Изменение Wave 17");
  },"Wave 17 confirmed batch update persisted in SQLite");
  await poll(()=>client.eval(
    "document.querySelector('#batch-history-list').textContent.includes('Изменение') "+
    "&& document.querySelector('#notice').textContent.includes('Массовое изменение сохранено')"),
    "Wave 17 immutable journal listed in browser");
  await client.eval("document.querySelector('#batch-history-list button:not([disabled])').click();");
  await poll(()=>client.eval(
    "document.querySelector('#batch-restore-review').hidden===false "+
    "&& document.querySelector('#batch-restore-summary').textContent.includes('Готов откат 1')"),
    "Wave 17 rollback inspection uses the live row versions");
  await client.eval("document.querySelector('#batch-restore-approve').checked=true;"+
    "document.querySelector('#batch-restore-approve').dispatchEvent(new Event('change'));"+
    "document.querySelector('#batch-restore-apply').click();");
  await poll(async()=>{
    const rows=await localApi("/api/v1/models/customers");
    return rows.rows.some(r=>r.fields.name==="Клиент Wave 16" && r.version>=3);
  },"Wave 17 forward-version undo restored original customer data");
  await poll(()=>client.eval(
    "document.querySelector('#notice').textContent.includes('Откат выполнен: 1') "+
    "&& document.querySelector('#batch-history-list').textContent.includes('Откат')"),
    "Wave 17 rollback journal remains visible");
  await client.screenshot("16-batch-edit-undo-desktop.png");

  // Wave 18: create a real assigned SQLite task via the manager UI,
  // inspect actual metrics, advance status and verify immutable event history.
  await client.eval("document.querySelector('[data-panel=tasks]').click();");
  await poll(()=>client.eval(
    "document.querySelector('#tasks').classList.contains('active') "+
    "&& !document.querySelector('#task-form').hidden "+
    "&& [...document.querySelector('#task-assignee').options].some(x=>x.value==='owner-abc')"),
    "Wave 18 manager task board loaded with real active member");
  await client.eval("document.querySelector('#task-title').value='Поручение из Chromium';"+
    "document.querySelector('#task-description').value='Проверить рабочий процесс';"+
    "document.querySelector('#task-priority').value='high';"+
    "document.querySelector('#task-assignee').value='owner-abc';"+
    "document.querySelector('#task-due').value='2027-11-06';"+
    "document.querySelector('#task-form').requestSubmit();");
  await poll(async()=>{
    const data=await localApi("/api/v1/tasks/summary");
    return data.metrics.total===1 && data.metrics.priority_high_open===1 &&
           data.metrics.todo===1;
  },"Wave 18 task saved durably with assignee and high priority");
  await poll(()=>client.eval(
    "document.querySelector('#task-list').textContent.includes('Поручение из Chromium') "+
    "&& document.querySelector('#tasks-total').textContent==='1'"),
    "Wave 18 task list and manager KPIs update");
  await client.eval("document.querySelector('#task-list .task-actions select').value='in_progress';"+
    "document.querySelector('#task-list .task-actions button').click();");
  await poll(async()=>{
    const data=await localApi("/api/v1/tasks/summary");
    return data.metrics.total===1 && data.metrics.in_progress===1;
  },"Wave 18 real status transition persisted");
  await poll(()=>client.eval(
    "document.querySelector('#task-list').textContent.includes('Поручение из Chromium') "+
    "&& document.querySelector('#tasks-progress').textContent==='1'"),
    "Wave 18 refreshed status card after transition");
  await client.eval("document.querySelector('#task-list .task-actions button:last-child').click();");
  await poll(()=>client.eval(
    "document.querySelector('#task-events-panel').hidden===false "+
    "&& document.querySelectorAll('#task-events-list .task-event').length===2"),
    "Wave 18 two immutable task history events displayed");
  await client.screenshot("17-manager-tasks-desktop.png");
  // Wave 19: comments, checklist, manager workload and due filters work
  // through the same authenticated UI and disposable SQLite database.
  await client.eval("([...document.querySelectorAll('#task-list .task-item')]"+
    ".find(x=>x.textContent.includes('Поручение из Chromium'))"+
    ".querySelector('.task-collab-open')).click();");
  await poll(()=>client.eval(
    "document.querySelector('#task-collaboration').hidden===false "+
    "&& document.querySelector('#task-collaboration-title').textContent.includes('Поручение')"),
    "Wave 19 active task discussion opened");
  await client.eval("document.querySelector('#task-checklist-title').value='Проверить критерий';"+
    "document.querySelector('#task-checklist-form').requestSubmit();");
  await poll(()=>client.eval(
    "document.querySelector('#task-checklist-count').textContent==='0/1' "+
    "&& document.querySelector('#task-checklist-list').textContent.includes('Проверить критерий')"),
    "Wave 19 checklist persisted in actual SQLite");
  await client.eval("document.querySelector('#task-checklist-list input[type=checkbox]').click();");
  await poll(()=>client.eval(
    "document.querySelector('#task-checklist-count').textContent==='1/1'"),
    "Wave 19 checklist CAS change acknowledged in UI");
  await client.eval("document.querySelector('#task-comment-text').value='Готово, результат проверен';"+
    "document.querySelector('#task-comment-form').requestSubmit();");
  await poll(()=>client.eval(
    "document.querySelector('#task-comment-list').textContent.includes('Готово, результат проверен')"),
    "Wave 19 immutable task comment saved and displayed");
  await poll(()=>client.eval(
    "document.querySelector('#team-workload-list').textContent.includes('owner-abc') "+
    "&& document.querySelector('#team-workload-list').textContent.includes('Открыты')"),
    "Wave 19 manager workload renders live SQLite");
  await client.eval("document.querySelector('#task-due-filter').value='undated';"+
    "document.querySelector('#task-due-filter').dispatchEvent(new Event('change'));");
  await poll(()=>client.eval(
    "document.querySelector('#task-count').textContent.includes('Задач пока нет')"),
    "Wave 19 due-date filter excludes dated tasks");
  await client.eval("document.querySelector('#task-due-filter').value='';"+
    "document.querySelector('#task-due-filter').dispatchEvent(new Event('change'));");
  await poll(()=>client.eval(
    "document.querySelector('#task-list').textContent.includes('Поручение из Chromium')"),
    "Wave 19 manager list recovers after filter clear");
  await client.screenshot("20-task-collaboration-desktop.png");
  // Wave 20: create two real tasks and a prerequisite through the Russian UI.
  // Verify calendar metrics and that the status API refuses premature closure.
  const tomorrow=await client.eval(
    "new Date(Date.now()+86400000).toISOString().slice(0,10)");
  await client.eval("document.querySelector('#task-title').value='Подготовка Wave 20';"+
    "document.querySelector('#task-due').value="+JSON.stringify(tomorrow)+";"+
    "document.querySelector('#task-priority').value='normal';"+
    "document.querySelector('#task-form').requestSubmit();");
  await poll(()=>client.eval(
    "document.querySelector('#task-list').textContent.includes('Подготовка Wave 20')"),
    "Wave 20 prerequisite created in real SQLite");
  await client.eval("document.querySelector('#task-title').value='Запуск Wave 20';"+
    "document.querySelector('#task-due').value="+JSON.stringify(tomorrow)+";"+
    "document.querySelector('#task-priority').value='urgent';"+
    "document.querySelector('#task-form').requestSubmit();");
  await poll(()=>client.eval(
    "document.querySelector('#task-list').textContent.includes('Запуск Wave 20') "+
    "&& document.querySelector('#task-calendar-list').textContent.includes('Запуск Wave 20')"),
    "Wave 20 future urgent task is visible in real calendar");
  await client.eval("([...document.querySelectorAll('#task-list .task-item')]"+
    ".find(x=>x.textContent.includes('Запуск Wave 20'))"+
    ".querySelector('.task-collab-open')).click();");
  await poll(()=>client.eval(
    "document.querySelector('#task-dependency-editor').hidden===false "+
    "&& document.querySelector('#task-dependency-candidate').options.length>1"),
    "Wave 20 editor loaded allowed predecessor tasks");
  await client.eval("document.querySelector('#task-dependency-candidate').value="+
    "[...document.querySelectorAll('#task-list .task-item')].find(x=>x.textContent.includes('Подготовка Wave 20')).dataset.taskId;"+
    "document.querySelector('#task-dependency-add').click();");
  await poll(()=>client.eval(
    "document.querySelector('#task-dependency-count').textContent.includes('1 связей') "+
    "&& document.querySelector('#calendar-blocked').textContent==='1'"),
    "Wave 20 DAG link persisted and calendar flags blocked dependent");
  await client.eval("(()=>{const row=[...document.querySelectorAll('#task-list .task-item')]"+
    ".find(x=>x.textContent.includes('Запуск Wave 20'));"+
    "row.querySelector('.task-actions select').value='done';"+
    "row.querySelector('.task-actions button').click();})()");
  await poll(()=>client.eval(
    "document.querySelector('#notice').textContent.includes('INVALID_OPERATION') "+
    "&& [...document.querySelectorAll('#task-list .task-item')].some(x=>x.textContent.includes('Запуск Wave 20')&&x.dataset.taskStatus==='todo')"),
    "Wave 20 API rejects premature completion without exposing sensitive details");
  await client.eval("(()=>{const row=[...document.querySelectorAll('#task-list .task-item')]"+
    ".find(x=>x.textContent.includes('Подготовка Wave 20'));"+
    "row.querySelector('.task-actions select').value='done';"+
    "row.querySelector('.task-actions button').click();})()");
  await poll(()=>client.eval(
    "[...document.querySelectorAll('#task-list .task-item')].some(x=>x.textContent.includes('Подготовка Wave 20')&&x.dataset.taskStatus==='done') "+
    "&& document.querySelector('#calendar-blocked').textContent==='0' "+
    "&& document.querySelector('#task-calendar-list').textContent.includes('Запуск Wave 20')"),
    "Wave 20 finishing prerequisite clears calendar dependency risk");
  await poll(()=>client.eval(
    "document.querySelector('#calendar-critical').textContent==='1'"),
    "Wave 20 real urgent deadline remains visible after predecessor completes");
  await client.screenshot("23-agenda-dependency-desktop.png");
  // Wave 21: real stage/milestone planning and immutable baseline checks.
  const today=await client.eval("new Date().toISOString().slice(0,10)");
  const shifted=await client.eval(
    "new Date(Date.parse("+JSON.stringify(tomorrow)+
    "+'T12:00:00Z')+4*86400000).toISOString().slice(0,10)");
  await client.eval("document.querySelector('#delivery-phase-name').value='Этап Wave 21';"+
    "document.querySelector('#delivery-phase-start').value="+JSON.stringify(today)+";"+
    "document.querySelector('#delivery-phase-end').value="+JSON.stringify(tomorrow)+";"+
    "document.querySelector('#delivery-phase-form').requestSubmit();");
  await poll(()=>client.eval(
    "document.querySelector('#delivery-phases-count').textContent==='1' "+
    "&& document.querySelector('#delivery-phase-list').textContent.includes('Этап Wave 21')"),
    "Wave 21 baseline phase saved in SQLite");
  await client.eval("document.querySelector('#delivery-milestone-name').value='Релиз Wave 21';"+
    "document.querySelector('#delivery-milestone-due').value="+JSON.stringify(tomorrow)+";"+
    "document.querySelector('#delivery-milestone-task').value="+
      "[...document.querySelectorAll('#task-list .task-item')]"+
      ".find(x=>x.textContent.includes('Запуск Wave 20')).dataset.taskId;"+
    "document.querySelector('#delivery-milestone-form').requestSubmit();");
  await poll(()=>client.eval(
    "document.querySelector('#delivery-done').textContent==='0 / 1' "+
    "&& document.querySelector('#delivery-phase-list').textContent.includes('Релиз Wave 21')"),
    "Wave 21 real milestone linked to unfinished task");
  await client.eval("document.querySelector('.delivery-phase>.delivery-actions input').value="+
    JSON.stringify(shifted)+";"+
    "document.querySelector('.delivery-phase>.delivery-actions button').click();");
  await poll(()=>client.eval(
    "document.querySelector('#delivery-phases-late').textContent==='1' "+
    "&& document.querySelector('.delivery-phase-meta').textContent.includes("+JSON.stringify(shifted)+")"),
    "Wave 21 stage forecast revised while baseline remains unchanged");
  await client.eval("document.querySelector('.delivery-milestone .delivery-actions input').value="+
    JSON.stringify(shifted)+";"+
    "document.querySelector('.delivery-milestone .delivery-actions button').click();");
  await poll(()=>client.eval(
    "document.querySelector('.delivery-milestone-dates').textContent.includes('Прогноз: "+shifted+"') "+
    "&& document.querySelector('#delivery-summary').textContent.includes('прогноз сдвинут: 1')"),
    "Wave 21 milestone forecast revision stored and variance recalculated");
  await client.eval("document.querySelector('.delivery-milestone .delivery-actions button:nth-of-type(2)').click();");
  await poll(()=>client.eval(
    "document.querySelector('#notice').textContent.includes('INVALID_OPERATION') "+
    "&& document.querySelector('#delivery-done').textContent==='0 / 1'"),
    "Wave 21 cannot confirm milestone while linked task remains unfinished");
  await client.eval("(()=>{const row=[...document.querySelectorAll('#task-list .task-item')]"+
    ".find(x=>x.textContent.includes('Запуск Wave 20'));"+
    "row.querySelector('.task-actions select').value='done';"+
    "row.querySelector('.task-actions button').click();})()");
  await poll(()=>client.eval(
    "[...document.querySelectorAll('#task-list .task-item')]"+
    ".some(x=>x.textContent.includes('Запуск Wave 20')&&x.dataset.taskStatus==='done')"),
    "Wave 21 linked task completed in real SQLite");
  await client.eval("document.querySelector('.delivery-milestone .delivery-actions button:nth-of-type(2)').click();");
  await poll(()=>client.eval(
    "document.querySelector('#delivery-done').textContent==='1 / 1' "+
    "&& document.querySelector('.delivery-phase-heading').textContent.includes('Все вехи завершены')"),
    "Wave 21 actual milestone completion persisted and phase progress is 100 percent");
  await client.eval("document.querySelector('.delivery-milestone .delivery-actions button').click();");
  await poll(()=>client.eval(
    "document.querySelector('#delivery-history-panel').hidden===false "+
    "&& document.querySelectorAll('#delivery-history-list .delivery-audit-row').length===3"),
    "Wave 21 immutable delivery audit includes baseline, forecast and actual");
  await client.screenshot("26-delivery-plan-desktop.png");
  // Wave 22: all hours are entered via real UI, never guessed by the service.
  await poll(()=>client.eval(
    "document.querySelector('#resource-forecast-panel').hidden===false "+
    "&& document.querySelector('#forecast-unknown').textContent!=='—'"),
    "Wave 22 manager resource planner opens");
  await client.eval("document.querySelector('#forecast-worker').value='owner-abc';"+
    "document.querySelector('#forecast-worker').dispatchEvent(new Event('change'));"+
    "document.querySelector('#forecast-hours-per-day').value='4';"+
    "document.querySelector('#forecast-capacity-form').requestSubmit();");
  await poll(async()=>{
    const result=await localApi("/api/v1/forecast");
    return result.capacities.some(x=>x.worker==="owner-abc"&&x.hours_per_day===4);
  },"Wave 22 real employee capacity saved in SQLite");
  await client.eval("(()=>{const select=document.querySelector('#forecast-task');"+
    "const option=[...select.options].find(x=>x.textContent.includes('Поручение из Chromium'));"+
    "if(!option)throw Error('Original assigned task not in forecast editor');"+
    "select.value=option.value;select.dispatchEvent(new Event('change'));"+
    "document.querySelector('#forecast-effort-hours').value='16';"+
    "document.querySelector('#forecast-effort-form').requestSubmit();})()");
  await poll(async()=>{
    const result=await localApi("/api/v1/forecast");
    return result.tasks.some(x=>x.title==="Поручение из Chromium"&&
           x.state==="scheduled"&&x.estimated_workdays===4);
  },"Wave 22 16h task scheduled across four 4h workdays");
  await poll(()=>client.eval(
    "document.querySelector('#forecast-task-list').textContent.includes('Поручение из Chromium') "+
    "&& document.querySelector('#forecast-task-list').textContent.includes('Расчёт:')"),
    "Wave 22 non-fabricated task finish visible in Russian UI");
  await client.eval("document.querySelector('#forecast-worker').value='owner-abc';"+
    "document.querySelector('#forecast-worker').dispatchEvent(new Event('change'));"+
    "document.querySelector('#forecast-hours-per-day').value='8';"+
    "document.querySelector('#forecast-capacity-form').requestSubmit();");
  await poll(async()=>{
    const result=await localApi("/api/v1/forecast");
    return result.capacities.some(x=>x.worker==="owner-abc"&&x.version===2)&&
           result.tasks.some(x=>x.title==="Поручение из Chromium"&&
           x.estimated_workdays===2);
  },"Wave 22 changing capacity recalculates forecast and increments revision");
  await client.eval("document.querySelector('#forecast-audit-open').click();");
  await poll(()=>client.eval(
    "document.querySelector('#forecast-history-panel').hidden===false "+
    "&& document.querySelectorAll('#forecast-history-list .forecast-audit-item').length===3"),
    "Wave 22 immutable resource input audit displayed");
  await client.screenshot("29-resource-forecast-desktop.png");
  // Wave 23: enter realistic demand, then compare one reassignment without
  // changing any assignment, version or forecast-input journal in SQLite.
  await client.eval("document.querySelector('#task-title').value='Задача перераспределения Wave 23';"+
    "document.querySelector('#task-assignee').value='owner-abc';"+
    "document.querySelector('#task-due').value='2027-11-06';"+
    "document.querySelector('#task-form').requestSubmit();");
  await poll(()=>client.eval(
    "document.querySelector('#task-list').textContent.includes('Задача перераспределения Wave 23')"),
    "Wave 23 second owner task persisted in SQLite");
  await client.eval("(()=>{const select=document.querySelector('#forecast-task');"+
    "const option=[...select.options].find(x=>x.textContent.includes('Задача перераспределения Wave 23'));"+
    "if(!option)throw Error('Wave 23 task not in effort input');"+
    "select.value=option.value;select.dispatchEvent(new Event('change'));"+
    "document.querySelector('#forecast-effort-hours').value='32';"+
    "document.querySelector('#forecast-effort-form').requestSubmit();})()");
  await poll(async()=>{
    const forecast=await localApi("/api/v1/forecast");
    return forecast.efforts.some(x=>x.effort_hours===32);
  },"Wave 23 32 productive hours were explicitly estimated");
  await client.eval("document.querySelector('#forecast-worker').value='operator-abc';"+
    "document.querySelector('#forecast-worker').dispatchEvent(new Event('change'));"+
    "document.querySelector('#forecast-hours-per-day').value='8';"+
    "document.querySelector('#forecast-capacity-form').requestSubmit();");
  await poll(async()=>{
    const forecast=await localApi("/api/v1/forecast");
    return forecast.capacities.some(x=>x.worker==='operator-abc'&&x.hours_per_day===8);
  },"Wave 23 alternative worker capacity explicitly saved");
  await poll(()=>client.eval(
    "document.querySelector('#scenario-panel').hidden===false "+
    "&& [...document.querySelector('#scenario-worker').options]"+
    ".some(x=>x.value==='operator-abc') "+
    "&& [...document.querySelector('#scenario-task').options]"+
    ".some(x=>x.textContent.includes('Задача перераспределения Wave 23'))"),
    "Wave 23 scenario builder populated from current SQLite data");
  // The added saved-plan fetch makes initial GETs more concurrent; wait until
  // the mounted scenario view has the SAME authoritative input digest.
  await client.eval("document.querySelector('#scenario-refresh').click();");
  await poll(async()=>{
    const real=await localApi("/api/v1/scenarios/workload");
    const visible=await client.eval(
      "document.querySelector('#scenario-panel').dataset.sourceSnapshot");
    return visible===real.input_snapshot;
  },"Wave 23 scenario source fully refreshed before staging an alternative");
  const sourceBeforeScenario=await localApi("/api/v1/forecast");
  const unchangedTask=sourceBeforeScenario.tasks.find(x=>
    x.title==="Задача перераспределения Wave 23");
  assert.equal(unchangedTask.assignee,"owner-abc");
  await client.eval("(()=>{const select=document.querySelector('#scenario-task');"+
    "const option=[...select.options].find(x=>x.textContent.includes('Задача перераспределения Wave 23'));"+
    "select.value=option.value;document.querySelector('#scenario-worker').value='operator-abc';"+
    "document.querySelector('#scenario-add').click();})()");
  await poll(()=>client.eval(
    "document.querySelector('#scenario-moves').textContent.includes('operator-abc') "+
    "&& !document.querySelector('#scenario-compare').disabled"),
    "Wave 23 hypothetical move staged only in UI");
  await client.eval("document.querySelector('#scenario-compare').click();");
  await poll(()=>client.eval(
    "document.querySelector('#scenario-results').hidden===false "+
    "&& document.querySelector('#scenario-comparison').textContent.includes('Альтернатива') "+
    "&& document.querySelector('#scenario-comparison').textContent.includes('Текущий план')"),
    "Wave 23 real baseline and alternative rendered from same snapshot");
  const afterScenario=await localApi("/api/v1/forecast");
  assert.equal(afterScenario.tasks.find(x=>x.task_id===unchangedTask.task_id).assignee,
               "owner-abc","Wave 23 preview must NOT reassign real tasks");
  assert.equal(afterScenario.input_snapshot,sourceBeforeScenario.input_snapshot,
               "Wave 23 preview must NOT change any stored input");
  await client.screenshot("32-reassignment-simulation-desktop.png");
  // Wave 24 — two saved variants persist; selecting never mutates tasks;
  // explicit owner confirmation applies only the approved variant atomically.
  await client.eval("document.querySelector('#scenario-save-title').value='Вариант Альфа';"+
    "document.querySelector('#scenario-save-form').requestSubmit();");
  await poll(async()=>{
    const data=await localApi("/api/v1/scenarios/saved");
    return data.variants.length===1&&data.variants[0].status==="draft";
  },"Wave 24 first named scenario saved in real SQLite");
  await poll(()=>client.eval(
    "document.querySelector('#scenario-library-list').textContent.includes('Вариант Альфа')"),
    "Wave 24 saved variant visible in library");
  await client.eval("document.querySelector('#scenario-save-title').value='Вариант Бета';"+
    "document.querySelector('#scenario-save-title').dispatchEvent(new Event('input'));"+
    "document.querySelector('#scenario-save-form').requestSubmit();");
  await poll(async()=>{
    const data=await localApi("/api/v1/scenarios/saved");
    return data.variants.length===2&&data.variants.every(x=>x.status==="draft");
  },"Wave 24 two independent draft variants saved");
  assert.equal((await localApi("/api/v1/forecast")).tasks.find(x=>
    x.task_id===unchangedTask.task_id).assignee,"owner-abc",
    "Saving plans must never reassign tasks");
  await client.eval("(()=>{const card=[...document.querySelectorAll('.scenario-saved-card')]"+
    ".find(x=>x.textContent.includes('Вариант Альфа'));"+
    "card.querySelector('.scenario-saved-actions button:last-child').click();})()");
  await poll(async()=>{
    const data=await localApi("/api/v1/scenarios/saved");
    return data.variants.find(x=>x.title==="Вариант Альфа")?.status==="approved";
  },"Wave 24 owner selects first plan without applying");
  assert.equal((await localApi("/api/v1/forecast")).tasks.find(x=>
    x.task_id===unchangedTask.task_id).assignee,"owner-abc",
    "First approval must not change real task");
  await client.eval("(()=>{const card=[...document.querySelectorAll('.scenario-saved-card')]"+
    ".find(x=>x.textContent.includes('Вариант Бета'));"+
    "card.querySelector('.scenario-saved-actions button:last-child').click();})()");
  await poll(async()=>{
    const data=await localApi("/api/v1/scenarios/saved");
    return data.variants.find(x=>x.title==="Вариант Альфа")?.status==="superseded"&&
      data.variants.find(x=>x.title==="Вариант Бета")?.status==="approved";
  },"Wave 24 new choice supersedes first, only one approved");
  await poll(()=>client.eval(
    "[...document.querySelectorAll('.scenario-saved-card')]"+
    ".some(x=>x.textContent.includes('Вариант Бета')&&x.dataset.status==='approved')"),
    "Wave 24 approved card rendered with guarded control");
  await client.eval("(()=>{const card=[...document.querySelectorAll('.scenario-saved-card')]"+
    ".find(x=>x.textContent.includes('Вариант Бета'));"+
    "const guard=card.querySelector('.scenario-apply-guard');"+
    "if(!guard)throw Error('Missing explicit apply guard');"+
    "guard.querySelector('input[type=checkbox]').click();"+
    "const phrase=guard.querySelector('input[type=text]');"+
    "phrase.value='ПРИМЕНИТЬ';phrase.dispatchEvent(new Event('input'));"+
    "guard.querySelector('button').click();})()");
  await poll(async()=>{
    const forecast=await localApi("/api/v1/forecast");
    const saved=await localApi("/api/v1/scenarios/saved");
    return forecast.tasks.find(x=>x.task_id===unchangedTask.task_id)?.assignee===
      "operator-abc"&&
      saved.variants.find(x=>x.title==="Вариант Бета")?.status==="applied";
  },"Wave 24 confirmed owner decision atomically assigns real task");
  const postApply=await localApi("/api/v1/forecast");
  assert.notEqual(postApply.input_snapshot,sourceBeforeScenario.input_snapshot,
    "Real owner-approved application must update authoritative snapshot");
  const decisionList=await localApi("/api/v1/scenarios/saved");
  const applied=decisionList.variants.find(x=>x.title==="Вариант Бета");
  const decisions=await localApi("/api/v1/scenarios/saved/"+
    encodeURIComponent(applied.scenario_id)+"/history",{
      method:"POST",
      headers:{"Authorization":"Bearer "+token,"Content-Type":"application/json"},
      body:JSON.stringify({limit:30})});
  assert.deepEqual(new Set(decisions.events.map(x=>x.action)),
                   new Set(["SAVE","APPROVE","APPLY"]),
                   "Decision audit must cover each signed stage");
  await client.screenshot("35-saved-plan-applied-desktop.png");
  // Wave 25 — verify actual immutable application record, then guarded
  // owner-only atomic rollback restores the previous real assignment.
  const detailUrl="/api/v1/scenarios/saved/"+
    encodeURIComponent(applied.scenario_id)+"/outcome";
  const appliedOutcome=await localApi(detailUrl);
  assert.equal(appliedOutcome.application.task_changes.length,1,
    "The approved one-task scenario must have one factual application change");
  assert.equal(appliedOutcome.application.task_changes[0].before_assignee,"owner-abc");
  assert.equal(appliedOutcome.application.task_changes[0].after_assignee,"operator-abc");
  assert.equal(appliedOutcome.application.snapshot_after,postApply.input_snapshot);
  assert.equal(appliedOutcome.rollback_ready,true);
  // Wave 26: five functional monitoring features over the actual
  // applied Wave24 task, before owner executes the guarded rollback.
  const monitorBase="/api/v1/scenarios/saved/"+
    encodeURIComponent(applied.scenario_id)+"/monitor";
  await client.eval("(()=>{const card=[...document.querySelectorAll('.scenario-saved-card')]"+
    ".find(x=>x.textContent.includes('Вариант Бета'));"+
    "const open=[...card.querySelectorAll('button')]"+
    ".find(x=>x.textContent==='Контроль исполнения');"+
    "if(!open)throw Error('Wave 26 monitor action missing');open.click();})()");
  await poll(()=>client.eval(
    "document.querySelector('#scenario-monitor-panel').hidden===false "+
    "&& document.querySelector('#monitor-task-list').textContent.includes('Задача перераспределения Wave 23') "+
    "&& document.querySelector('#monitor-done').textContent==='0 / 1'"),
    "Wave 26 actual task monitoring dashboard renders real SQLite state");
  const monitorBefore=await localApi(monitorBase);
  assert.equal(monitorBefore.affected_tasks.length,1);
  assert.equal(monitorBefore.checkpoint_count,0);
  assert.equal(monitorBefore.history_chain_verified,true);
  await client.eval("document.querySelector('#monitor-note').value='Проверка исполнения 1';"+
    "document.querySelector('#monitor-checkpoint-form').requestSubmit();");
  await poll(async()=>{
    const r=await localApi(monitorBase);
    return r.checkpoint_count===1;
  },"Wave 26 first immutable SQLite checkpoint saved through real browser UI");
  await poll(()=>client.eval(
    "document.querySelector('#monitor-history-list').textContent.includes('Замер №1')"),
    "Wave 26 verified checkpoint history visible in Russian UI");
  await client.eval("document.querySelector('#monitor-note').value='Проверка исполнения 2';"+
    "document.querySelector('#monitor-note').dispatchEvent(new Event('input'));"+
    "document.querySelector('#monitor-checkpoint-form').requestSubmit();");
  await poll(async()=>{
    const r=await localApi(monitorBase);
    return r.checkpoint_count===2 && r.series.length===2;
  },"Wave 26 second digest-chained checkpoint captured without task mutation");
  const monitoring=await localApi(monitorBase);
  assert.equal(monitoring.affected_progress.total,1);
  assert.equal(monitoring.affected_progress.done,0);
  assert.equal(monitoring.projected_finish_shift_calendar_days,0);
  assert.equal(monitoring.history_chain_verified,true);
  const csv=await localApi(monitorBase+"/export");
  assert.equal(csv.verified_history,true);
  assert.equal(csv.rows,3,"Two checkpoints plus one actual task");
  assert.equal(csv.csv.charCodeAt(0),65279,"UTF-8 BOM present");
  assert.ok(csv.csv.includes('task_current'));
  assert.ok(csv.csv.includes('checkpoint'));
  assert.ok(csv.csv.includes('Задача перераспределения Wave 23'));
  await client.screenshot("41-actual-outcomes-desktop.png");

  await client.eval("(()=>{const card=[...document.querySelectorAll('.scenario-saved-card')]"+
    ".find(x=>x.textContent.includes('Вариант Бета'));"+
    "const open=[...card.querySelectorAll('button')]"+
    ".find(x=>x.textContent==='Фактический результат');"+
    "if(!open)throw Error('Application outcome button absent');open.click();})()");
  await poll(()=>client.eval(
    "document.querySelector('#scenario-outcome-report').hidden===false "+
    "&& document.querySelector('#scenario-outcome-body').textContent.includes('Фактические назначения')"),
    "Wave 25 factual pre/post application and task receipt rendered");
  await client.eval("(()=>{const guard=document.querySelector('.scenario-rollback-guard');"+
    "if(!guard)throw Error('Rollback consent panel missing');"+
    "const button=guard.querySelector('button');"+
    "if(!button.disabled)throw Error('Rollback must start disabled');"+
    "guard.querySelector('input[type=checkbox]').click();"+
    "const phrase=guard.querySelector('input[type=text]');"+
    "phrase.value='ОТКАТИТЬ';phrase.dispatchEvent(new Event('input'));"+
    "if(button.disabled)throw Error('Complete owner confirmation not accepted');"+
    "button.click();})()");
  await poll(async()=>{
    const state=await localApi(detailUrl);
    const forecast=await localApi("/api/v1/forecast");
    return state.effective_status==="rolled_back"&&
      state.rollback?.task_changes.length===1&&
      forecast.tasks.find(x=>x.task_id===unchangedTask.task_id)?.assignee==="owner-abc";
  },"Wave 25 real SQLite assignment restored atomically after guarded confirmation");
  const afterRollback=await localApi(detailUrl);
  assert.equal(afterRollback.application.sha256,
    appliedOutcome.application.sha256,
    "Rollback must preserve immutable original application history");
  assert.equal(afterRollback.rollback.application_sha256,
    appliedOutcome.application.sha256);
  assert.equal(afterRollback.rollback.metrics_after.potential_finish,
    appliedOutcome.application.metrics_before.potential_finish,
    "Rollback metrics must restore the baseline deterministic schedule");
  const rollbackDecisions=await localApi(
    "/api/v1/scenarios/saved/"+encodeURIComponent(applied.scenario_id)+
    "/history",{method:"POST",headers:{
      Authorization:"Bearer "+token,"Content-Type":"application/json"},
      body:JSON.stringify({limit:30})});
  assert.deepEqual(new Set(rollbackDecisions.events.map(x=>x.action)),
    new Set(["SAVE","APPROVE","APPLY","ROLLBACK"]),
    "Unified scenario decision journal must include verified rollback");
  await client.screenshot("38-scenario-rollback-desktop.png");
  const afterRollbackMonitor=await localApi(monitorBase);
  assert.equal(afterRollbackMonitor.effective_status,"rolled_back");
  assert.equal(afterRollbackMonitor.checkpoint_count,2);
  assert.equal(afterRollbackMonitor.risks.length,0,
    "Rolled-back historical plans must not present stale active alerts");








  // Use a genuine touch-enabled device viewport and reload so Chromium
  // recomputes meta viewport and responsive layout from navigation start.
  await client.send("Emulation.setDeviceMetricsOverride",{
    width:390,height:844,screenWidth:390,screenHeight:844,
    deviceScaleFactor:1,mobile:true});
  await client.send("Emulation.setTouchEmulationEnabled",{
    enabled:true,maxTouchPoints:5});
  await client.send("Page.reload",{ignoreCache:true});
  await poll(()=>client.eval(
    "document.readyState==='complete' && !!document.querySelector('#auth-form')"),
    "mobile browser navigation");
  await poll(()=>client.eval(
    "innerWidth===390 && document.documentElement.clientWidth===390 "+
    "&& matchMedia('(max-width: 800px)').matches"),
    "mobile viewport and responsive CSS");
  await client.eval("document.querySelector('#token').value="+JSON.stringify(token)+
    ";document.querySelector('#auth-form').requestSubmit();true");
  await poll(()=>client.eval(
    "document.querySelector('#connect').hidden && "+
    "document.querySelector('#metric-pages').textContent.trim()==='3'"),
    "mobile authentication");
  await client.eval("document.querySelector('[data-panel=history]').click();");
  await poll(()=>client.eval("document.querySelector('#history').classList.contains('active')"),
    "mobile recovery panel");
  const overflow=await client.eval(
    "document.documentElement.scrollWidth-document.documentElement.clientWidth");
  await client.screenshot("12-mobile-390.png");
  if(overflow>2){
    const offending=await client.eval(`JSON.stringify(
      [...document.querySelectorAll('body *')]
        .map(el=>{const r=el.getBoundingClientRect();return {
          tag:el.tagName.toLowerCase(),id:el.id,cls:String(el.className||'').slice(0,100),
          left:Math.round(r.left),right:Math.round(r.right),width:Math.round(r.width)};})
        .filter(x=>x.right>document.documentElement.clientWidth+2
                && x.width>0 && x.left<document.documentElement.clientWidth+2)
        .sort((a,b)=>b.right-a.right).slice(0,16))`);
    console.error("OSGARD_MOBILE_LAYOUT_OFFENDERS "+offending);
  }
  assert.ok(overflow<=2,"mobile horizontal overflow: "+overflow);
  await client.eval("document.querySelector('[data-panel=tasks]').click();");
  await poll(()=>client.eval(
    "document.querySelector('#tasks').classList.contains('active') "+
    "&& document.querySelector('#task-list').textContent.includes('Поручение из Chromium')"),
    "Wave 18 mobile 390px task board populated");
  const taskOverflow390=await client.eval(
    "document.documentElement.scrollWidth-document.documentElement.clientWidth");
  assert.ok(taskOverflow390<=2,"390px task board horizontal overflow: "+taskOverflow390);
  await client.screenshot("18-mobile-390-tasks.png");
  await client.eval("([...document.querySelectorAll('#task-list .task-item')]"+
    ".find(x=>x.textContent.includes('Поручение из Chromium'))"+
    ".querySelector('.task-collab-open')).click();");
  await poll(()=>client.eval(
    "document.querySelector('#task-collaboration').hidden===false "+
    "&& document.querySelector('#task-checklist-list').textContent.includes('Проверить критерий') "+
    "&& document.querySelector('#task-comment-list').textContent.includes('Готово, результат проверен')"),
    "Wave 19 390px task discussion and checklist loaded");
  const collabOverflow390=await client.eval(
    "document.documentElement.scrollWidth-document.documentElement.clientWidth");
  assert.ok(collabOverflow390<=2,
    "390px task discussion horizontal overflow: "+collabOverflow390);
  await client.screenshot("21-mobile-390-task-discussion.png");
  await poll(()=>client.eval(
    "document.querySelector('#task-calendar-summary').textContent.includes('0 задач') "+
    "&& document.querySelector('#calendar-critical').textContent==='0' "+
    "&& document.querySelector('#calendar-in-window').textContent==='0'"),
    "Wave 20 390px real calendar data loaded");
  const wave20CalendarOverflow390=await client.eval(
    "document.documentElement.scrollWidth-document.documentElement.clientWidth");
  assert.ok(wave20CalendarOverflow390<=2,
    "390px task calendar overflow: "+wave20CalendarOverflow390);
  await client.screenshot("24-mobile-390-calendar.png");
  await poll(()=>client.eval(
    "document.querySelector('#delivery-panel').hidden===false "+
    "&& document.querySelector('#delivery-done').textContent==='1 / 1' "+
    "&& document.querySelector('#delivery-phase-list').textContent.includes('Этап Wave 21')"),
    "Wave 21 390px delivery board loaded from SQLite");
  const deliveryOverflow390=await client.eval(
    "document.documentElement.scrollWidth-document.documentElement.clientWidth");
  assert.ok(deliveryOverflow390<=2,
    "390px delivery board horizontal overflow: "+deliveryOverflow390);
  await client.screenshot("27-delivery-mobile-390.png");
  await poll(()=>client.eval(
    "document.querySelector('#resource-forecast-panel').hidden===false "+
    "&& document.querySelector('#forecast-task-list').textContent.includes('Поручение из Chromium') "+
    "&& document.querySelector('#forecast-scheduled').textContent==='2 / 2'"),
    "Wave 22 390px resource planning content loaded");
  const forecastOverflow390=await client.eval(
    "document.documentElement.scrollWidth-document.documentElement.clientWidth");
  assert.ok(forecastOverflow390<=2,
    "390px forecast panel horizontal overflow: "+forecastOverflow390);
  await client.screenshot("30-resource-forecast-390.png");
  await poll(()=>client.eval(
    "document.querySelector('#scenario-panel').hidden===false "+
    "&& document.querySelector('#scenario-worker-list').textContent.includes('owner-abc') "+
    "&& document.querySelector('#scenario-moves').textContent.includes('Сценарий пуст')"),
    "Wave 23 390px scenario management visible and unchanged");
  const scenarioOverflow390=await client.eval(
    "document.documentElement.scrollWidth-document.documentElement.clientWidth");
  assert.ok(scenarioOverflow390<=2,
    "390px scenario planner horizontal overflow: "+scenarioOverflow390);
  await client.screenshot("33-scenario-mobile-390.png");
  await poll(()=>client.eval(
    "document.querySelector('#scenario-library-list').textContent.includes('Вариант Бета') "+
    "&& [...document.querySelectorAll('.scenario-saved-card')]"+
    ".some(x=>x.dataset.status==='rolled_back')"),
    "Wave 24 390px saved decisions survive reload");
  const scenarioLibraryOverflow390=await client.eval(
    "document.documentElement.scrollWidth-document.documentElement.clientWidth");
  assert.ok(scenarioLibraryOverflow390<=2,
    "390px saved variants horizontal overflow: "+scenarioLibraryOverflow390);
  await client.screenshot("36-saved-plans-390.png");
  await client.eval("(()=>{const card=[...document.querySelectorAll('.scenario-saved-card')]"+
    ".find(x=>x.textContent.includes('Вариант Бета'));"+
    "const open=[...card.querySelectorAll('button')]"+
    ".find(x=>x.textContent==='Фактический результат');"+
    "if(!open)throw Error('Outcome action missing on 390px');open.click();})()");
  await poll(()=>client.eval(
    "document.querySelector('#scenario-outcome-report').hidden===false "+
    "&& document.querySelector('#scenario-outcome-body').textContent.includes('Назначения возвращены')"),
    "Wave 25 390px immutable rollback details shown");
  const outcomeOverflow390=await client.eval(
    "document.documentElement.scrollWidth-document.documentElement.clientWidth");
  assert.ok(outcomeOverflow390<=2,
    "390px factual rollback report horizontal overflow: "+outcomeOverflow390);
  await client.screenshot("39-rollback-outcome-mobile-390.png");
  await client.eval("(()=>{const card=[...document.querySelectorAll('.scenario-saved-card')]"+
    ".find(x=>x.textContent.includes('Вариант Бета'));"+
    "const open=[...card.querySelectorAll('button')]"+
    ".find(x=>x.textContent==='Контроль исполнения');"+
    "if(!open)throw Error('Wave 26 monitor 390px missing');open.click();})()");
  await poll(()=>client.eval(
    "document.querySelector('#scenario-monitor-panel').hidden===false "+
    "&& document.querySelector('#monitor-checkpoints').textContent==='2' "+
    "&& document.querySelector('#monitor-history-status').textContent.includes('SHA-256')"),
    "Wave 26 390px verified persisted monitoring timeline");
  const monitorOverflow390=await client.eval(
    "document.documentElement.scrollWidth-document.documentElement.clientWidth");
  assert.ok(monitorOverflow390<=2,
    "390px Wave 26 monitor horizontal overflow: "+monitorOverflow390);
  await client.screenshot("42-monitor-mobile-390.png");
  // Narrow 320px devices must also display the recovery action without
  // clipping; this is a separate responsive breakpoint from 390px.
  await client.send("Emulation.setDeviceMetricsOverride",{
    width:320,height:700,screenWidth:320,screenHeight:700,
    deviceScaleFactor:1,mobile:true});
  // Chrome's layout viewport may remain cached when transitioning between
  // two mobile device sizes; force a fresh navigation and auth handshake.
  await client.send("Page.reload",{ignoreCache:true});
  await poll(()=>client.eval(
    "document.readyState==='complete' && !!document.querySelector('#auth-form')"),
    "narrow mobile navigation");
  await poll(()=>client.eval(
    "innerWidth===320 && document.documentElement.clientWidth===320"+
    " && matchMedia('(max-width:560px)').matches"),
    "narrow mobile device viewport");
  await client.eval("document.querySelector('#token').value="+JSON.stringify(token)+
    ";document.querySelector('#auth-form').requestSubmit();true");
  await poll(()=>client.eval(
    "document.querySelector('#connect').hidden && "+
    "document.querySelector('#metric-pages').textContent.trim()==='3'"),
    "narrow mobile authenticated dashboard");
  await client.eval("document.querySelector('[data-panel=history]').click();");
  await poll(()=>client.eval("document.querySelector('#history').classList.contains('active')"),
    "narrow mobile recovery panel");
  const overflow320=await client.eval(
    "document.documentElement.scrollWidth-document.documentElement.clientWidth");
  await client.screenshot("13-mobile-320.png");
  if(overflow320>2){
    const offenders=await client.eval(`JSON.stringify(
      [...document.querySelectorAll('body *')]
        .map(e=>{const r=e.getBoundingClientRect();return {
          id:e.id,tag:e.tagName.toLowerCase(),cls:String(e.className||'').slice(0,65),
          left:Math.round(r.left),right:Math.round(r.right),width:Math.round(r.width)};})
        .filter(x=>x.right>document.documentElement.clientWidth+2&&x.width>0
                && x.left<document.documentElement.clientWidth+2)
        .sort((a,b)=>b.right-a.right).slice(0,12))`);
    console.error("OSGARD_320_LAYOUT_OFFENDERS "+offenders);
  }
  assert.ok(overflow320<=2,"320px mobile horizontal overflow: "+overflow320);
  await client.eval("document.querySelector('[data-panel=tasks]').click();");
  await poll(()=>client.eval(
    "document.querySelector('#tasks').classList.contains('active') "+
    "&& document.querySelector('#task-list').textContent.includes('Поручение из Chromium')"),
    "Wave 18 mobile 320px task board populated");
  const taskOverflow320=await client.eval(
    "document.documentElement.scrollWidth-document.documentElement.clientWidth");
  assert.ok(taskOverflow320<=2,"320px task board horizontal overflow: "+taskOverflow320);
  await client.screenshot("19-mobile-320-tasks.png");
  await client.eval("([...document.querySelectorAll('#task-list .task-item')]"+
    ".find(x=>x.textContent.includes('Поручение из Chromium'))"+
    ".querySelector('.task-collab-open')).click();");
  await poll(()=>client.eval(
    "document.querySelector('#task-collaboration').hidden===false "+
    "&& document.querySelector('#task-checklist-list').textContent.includes('Проверить критерий') "+
    "&& document.querySelector('#task-comment-list').textContent.includes('Готово, результат проверен')"),
    "Wave 19 320px task discussion and checklist loaded");
  const collabOverflow320=await client.eval(
    "document.documentElement.scrollWidth-document.documentElement.clientWidth");
  assert.ok(collabOverflow320<=2,
    "320px task discussion horizontal overflow: "+collabOverflow320);
  await client.screenshot("22-mobile-320-task-discussion.png");
  await poll(()=>client.eval(
    "document.querySelector('#task-calendar-summary').textContent.includes('0 задач') "+
    "&& document.querySelector('#calendar-critical').textContent==='0' "+
    "&& document.querySelector('#calendar-in-window').textContent==='0'"),
    "Wave 20 320px real calendar data loaded");
  const wave20CalendarOverflow320=await client.eval(
    "document.documentElement.scrollWidth-document.documentElement.clientWidth");
  assert.ok(wave20CalendarOverflow320<=2,
    "320px task calendar overflow: "+wave20CalendarOverflow320);
  await client.screenshot("25-mobile-320-calendar.png");
  await poll(()=>client.eval(
    "document.querySelector('#delivery-panel').hidden===false "+
    "&& document.querySelector('#delivery-done').textContent==='1 / 1' "+
    "&& document.querySelector('#delivery-phase-list').textContent.includes('Этап Wave 21')"),
    "Wave 21 320px delivery board loaded from SQLite");
  const deliveryOverflow320=await client.eval(
    "document.documentElement.scrollWidth-document.documentElement.clientWidth");
  assert.ok(deliveryOverflow320<=2,
    "320px delivery board horizontal overflow: "+deliveryOverflow320);
  await client.screenshot("28-delivery-mobile-320.png");
  await poll(()=>client.eval(
    "document.querySelector('#resource-forecast-panel').hidden===false "+
    "&& document.querySelector('#forecast-task-list').textContent.includes('Поручение из Chromium') "+
    "&& document.querySelector('#forecast-scheduled').textContent==='2 / 2'"),
    "Wave 22 320px resource planning content loaded");
  const forecastOverflow320=await client.eval(
    "document.documentElement.scrollWidth-document.documentElement.clientWidth");
  assert.ok(forecastOverflow320<=2,
    "320px forecast panel horizontal overflow: "+forecastOverflow320);
  await client.screenshot("31-resource-forecast-320.png");
  await poll(()=>client.eval(
    "document.querySelector('#scenario-panel').hidden===false "+
    "&& document.querySelector('#scenario-worker-list').textContent.includes('owner-abc') "+
    "&& document.querySelector('#scenario-moves').textContent.includes('Сценарий пуст')"),
    "Wave 23 320px scenario management visible and unchanged");
  const scenarioOverflow320=await client.eval(
    "document.documentElement.scrollWidth-document.documentElement.clientWidth");
  assert.ok(scenarioOverflow320<=2,
    "320px scenario planner horizontal overflow: "+scenarioOverflow320);
  await client.screenshot("34-scenario-mobile-320.png");
  await poll(()=>client.eval(
    "document.querySelector('#scenario-library-list').textContent.includes('Вариант Бета') "+
    "&& [...document.querySelectorAll('.scenario-saved-card')]"+
    ".some(x=>x.dataset.status==='rolled_back')"),
    "Wave 24 320px saved decisions survive reload");
  const scenarioLibraryOverflow320=await client.eval(
    "document.documentElement.scrollWidth-document.documentElement.clientWidth");
  assert.ok(scenarioLibraryOverflow320<=2,
    "320px saved variants horizontal overflow: "+scenarioLibraryOverflow320);
  await client.screenshot("37-saved-plans-320.png");
  await client.eval("(()=>{const card=[...document.querySelectorAll('.scenario-saved-card')]"+
    ".find(x=>x.textContent.includes('Вариант Бета'));"+
    "const open=[...card.querySelectorAll('button')]"+
    ".find(x=>x.textContent==='Фактический результат');"+
    "if(!open)throw Error('Outcome action missing on 320px');open.click();})()");
  await poll(()=>client.eval(
    "document.querySelector('#scenario-outcome-report').hidden===false "+
    "&& document.querySelector('#scenario-outcome-body').textContent.includes('Назначения возвращены')"),
    "Wave 25 320px immutable rollback details shown");
  const outcomeOverflow320=await client.eval(
    "document.documentElement.scrollWidth-document.documentElement.clientWidth");
  assert.ok(outcomeOverflow320<=2,
    "320px factual rollback report horizontal overflow: "+outcomeOverflow320);
  await client.screenshot("40-rollback-outcome-mobile-320.png");
  await client.eval("(()=>{const card=[...document.querySelectorAll('.scenario-saved-card')]"+
    ".find(x=>x.textContent.includes('Вариант Бета'));"+
    "const open=[...card.querySelectorAll('button')]"+
    ".find(x=>x.textContent==='Контроль исполнения');"+
    "if(!open)throw Error('Wave 26 monitor 320px missing');open.click();})()");
  await poll(()=>client.eval(
    "document.querySelector('#scenario-monitor-panel').hidden===false "+
    "&& document.querySelector('#monitor-checkpoints').textContent==='2' "+
    "&& document.querySelector('#monitor-history-status').textContent.includes('SHA-256')"),
    "Wave 26 320px verified persisted monitoring timeline");
  const monitorOverflow320=await client.eval(
    "document.documentElement.scrollWidth-document.documentElement.clientWidth");
  assert.ok(monitorOverflow320<=2,
    "320px Wave 26 monitor horizontal overflow: "+monitorOverflow320);
  await client.screenshot("43-monitor-mobile-320.png");
  assert.deepEqual(client.errors,[],"browser runtime exceptions");
  return {browser:"Chromium",flows:["auth","structure","page-edit","preview",
    "record-create","manual-workflow","automatic-workflow","schema-model","field-migration","form-section","form-edit","reference-select","field-rename","relation-rename","reference-retarget","page-restore","mapped-live-relations","recovery-integrity","restore-drill","real-form-submit","record-search","csv-inspect","csv-batch-apply","csv-export","batch-inspect","batch-apply","batch-journal","batch-undo","task-create","task-manager-kpi","task-status","task-audit","mobile-390","mobile-320","task-mobile-390","task-mobile-320","task-comment","task-checklist","task-workload","task-due-filter","task-collab-mobile-390","task-collab-mobile-320","calendar-deadlines","dependency-add","dependency-guard","dependency-release","calendar-mobile-390","calendar-mobile-320","phase-baseline","milestone-create","stage-reforecast","milestone-reforecast","milestone-guard","milestone-complete","delivery-audit","delivery-mobile-390","delivery-mobile-320","resource-capacity","resource-effort","resource-recalculate","resource-audit","resource-mobile-390","resource-mobile-320","scenario-prepare","scenario-stage","scenario-compare","scenario-no-write","scenario-mobile-390","scenario-mobile-320","scenario-save-multiple","scenario-select","scenario-supersede","scenario-owner-confirm","scenario-apply-atomic","scenario-decision-audit","saved-plans-mobile-390","saved-plans-mobile-320","factual-apply-receipt","guarded-rollback","rollback-audit","rollback-mobile-390","rollback-mobile-320","monitor-dashboard","monitor-checkpoint-one","monitor-checkpoint-chain","monitor-variance","monitor-risk-rules","monitor-csv","monitor-rollback-history","monitor-mobile-390","monitor-mobile-320"],
    console_exceptions:client.errors.length,horizontal_overflow:overflow,
    screenshots:43,public_server_started:false,production_deployed:false};
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
