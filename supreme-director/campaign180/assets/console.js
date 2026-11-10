(() => {
"use strict";
const $ = id => document.getElementById(id);
const state = {token:"",me:null,spec:null,revision:0,workflows:[],rows:[],model:null,selectedRow:null,restorePlan:null,mappedPlan:null,mappedPayload:null};
const panels = ["dashboard","pages","records","schema","history","workflows","preview"];
const names = {dashboard:"Обзор",pages:"Страницы",records:"Данные",schema:"Модели и формы",history:"Версии и откат",workflows:"Автоматизация",preview:"Предпросмотр"};
const show = (message, error=false) => {
  const el=$("notice"); el.textContent=message || ""; el.classList.toggle("error",error);
};
const can = permission => Boolean(state.me && state.me.capabilities.includes(permission));
const node = (tag,text,cls) => {
  const el=document.createElement(tag);
  if(text!==undefined && text!==null) el.textContent=String(text);
  if(cls) el.className=cls;
  return el;
};
const option = (value,label) => {const o=node("option",label);o.value=value;return o;};
function pick(select,values) {
  select.replaceChildren(...values.map(([v,t])=>option(v,t)));
}
function safeId(){return crypto.randomUUID();}
async function api(path,{method="GET",body=null}={}){
  if(!state.token) throw Error("Сначала подключи локальный токен");
  const headers={"Authorization":"Bearer "+state.token};
  if(body!==null) headers["Content-Type"]="application/json";
  const response=await fetch(path,{method,headers,body:body===null?undefined:JSON.stringify(body),
                                   credentials:"omit",cache:"no-store",redirect:"error"});
  let data;
  try{data=await response.json();}catch{throw Error("Сервер вернул неверный ответ");}
  if(!response.ok){if(response.status===401) state.token="";throw Error("Операция отклонена: "+(data.error||response.status));}
  return data;
}
function model(){return state.spec?.models.find(m=>m.name===state.model);}
function typed(field,raw) {
  if(field.type==="boolean") return Boolean(raw);
  if(raw===null || raw==="") {
    if(field.required) throw Error("Заполни обязательное поле: "+field.label);
    return null;
  }
  if(field.type==="integer") {
    if(!/^-?\d+$/.test(String(raw))) throw Error("Поле «"+field.label+"» должно быть целым числом");
    const n=Number(raw);
    if(!Number.isSafeInteger(n))throw Error("Слишком большое число");
    return n;
  }
  return String(raw);
}
function switchPanel(name){
  for(const p of panels)$(p).classList.toggle("active",p===name);
  document.querySelectorAll(".nav-link").forEach(b=>b.classList.toggle("is-active",b.dataset.panel===name));
  $("crumb").textContent=names[name];
  if(name==="preview" && state.spec) refreshPreview();
  if(name==="schema" && state.spec) refreshMigrationHistory().catch(e=>show(e.message,true));
  if(name==="history" && state.spec) refreshRevisions().catch(e=>show(e.message,true));
}
document.querySelectorAll(".nav-link").forEach(b=>b.addEventListener("click",()=>switchPanel(b.dataset.panel)));
async function sync(){
  const [me,result,workflows]=await Promise.all([
    api("/api/v1/me"),api("/api/v1/spec"),api("/api/v1/workflows")]);
  state.me=me;state.spec=result.spec;state.revision=result.revision;
  state.restorePlan=null;
  clearMapPlan(true);
  $("history-plan").hidden=true;
  $("history-empty").hidden=false;
  $("history-approve").checked=false;
  $("history-apply").disabled=true;
  state.workflows=workflows.workflows;
  $("role-pill").textContent="Роль: "+me.role;
  $("metric-pages").textContent=result.spec.pages.length;
  $("metric-models").textContent=result.spec.models.length;
  $("metric-workflows").textContent=state.workflows.filter(w=>w.enabled).length;
  $("metric-version").textContent=result.revision;
  $("editor-revision").textContent="Версия "+result.revision;
  $("project-name").textContent=result.spec.title;
  $("project-description").textContent=result.spec.description||"Без описания";
  $("save-page").disabled=!can("spec.write");
  for(const id of ["add-section","move-section-up","move-section-down","remove-section"]){
    $(id).disabled=!can("spec.write");
  }

  for(const id of ["schema-create-model","schema-add-field","schema-save-label","schema-rename-submit",
                   "link-rename-submit","link-retarget-submit"]){
    $(id).disabled=!can("spec.write")||!can("record.write");
  }
  $("save-row").disabled=!can("record.write");
  $("delete-row").disabled=!can("record.write");
  $("wf-create").disabled=!can("workflow.manage");
  $("history-inspect").disabled=!can("spec.write");
  $("recovery-inspect").disabled=!can("members.manage");
  $("recovery-drill").disabled=!can("members.manage");
  $("map-load-options").disabled=!can("spec.write")||!can("record.read");
  renderPages();renderModels();renderSchema();renderWorkflows();
  await refreshRows();
}
$("auth-form").addEventListener("submit",async ev=>{
  ev.preventDefault();
  const candidate=$("token").value.trim();
  if(!candidate)return;
  state.token=candidate;
  $("token").value="";
  try{await sync();$("connect").hidden=true;show("Локальная сессия подключена. Изменения сохраняются только на этом компьютере.");}
  catch(e){state.token="";$("connect").hidden=false;show(e.message,true);}
});
function renderPages(){
  pick($("page-select"),state.spec.pages.map(p=>[p.slug,p.title]));
  pick($("preview-select"),state.spec.pages.map(p=>[p.slug,p.title]));
  pageChanged();
}
function pageChanged(){
  const page=state.spec.pages.find(p=>p.slug===$("page-select").value);
  if(!page)return;
  $("page-title").value=page.title;
  pick($("section-select"),page.sections.map((s,i)=>[String(i),(i+1)+". "+s.heading]));
  $("section-count").textContent=page.sections.length+" секций на странице";
  sectionChanged();
}
function sectionChanged(){
  const page=state.spec.pages.find(p=>p.slug===$("page-select").value);
  const section=page?.sections[Number($("section-select").value)];
  if(!section)return;
  $("section-heading").value=section.heading;
  $("section-text").value=section.text||"";
  $("section-text").disabled=!Object.hasOwn(section,"text") || !can("spec.write");
  $("section-heading").disabled=!can("spec.write");
  renderFormProperties(section);
  $("page-title").disabled=!can("spec.write");
}
function renderFormProperties(section){
  const root=$("form-editor");
  const isForm=section.type==="form";
  root.hidden=!isForm;
  if(!isForm)return;
  $("edit-form-heading").value=section.heading;
  $("edit-form-button").value=section.button_label||"Сохранить";
  pick($("edit-form-model"),state.spec.models.map(m=>[m.name,m.label]));
  $("edit-form-model").value=section.model;
  $("edit-form-heading").disabled=!can("spec.write");
  $("edit-form-button").disabled=!can("spec.write");
  $("edit-form-model").disabled=!can("spec.write");
  $("save-form").disabled=!can("spec.write");
  fillFormFields(section.fields||null);
}
function fillFormFields(original){
  const chosen=$("edit-form-model").value;
  const model=state.spec.models.find(m=>m.name===chosen);
  const root=$("edit-form-fields");
  root.replaceChildren();
  if(!model)return;
  const names=original===null?model.fields.map(f=>f.name):original;
  const ordered=[...names.filter(n=>model.fields.some(f=>f.name===n)),
    ...model.fields.filter(f=>!names.includes(f.name)).map(f=>f.name)];
  for(const name of ordered){
    const field=model.fields.find(f=>f.name===name);
    const item=node("div",null,"form-field-row");
    item.dataset.name=name;
    const label=node("label",null,"form-field-label");
    const check=node("input");
    check.type="checkbox";check.checked=names.includes(name);
    check.disabled=!can("spec.write");
    label.append(check,node("span",field.label+" · "+field.type));
    const up=node("button","↑","ghost");
    up.type="button";up.title="Выше";up.disabled=!can("spec.write");
    up.addEventListener("click",()=>{
      if(item.previousElementSibling)root.insertBefore(item,item.previousElementSibling);
    });
    const down=node("button","↓","ghost");
    down.type="button";down.title="Ниже";down.disabled=!can("spec.write");
    down.addEventListener("click",()=>{
      if(item.nextElementSibling)root.insertBefore(item.nextElementSibling,item);
    });
    item.append(label,up,down);
    root.append(item);
  }
}
$("edit-form-model").addEventListener("change",()=>fillFormFields(null));
$("form-editor").addEventListener("submit",async ev=>{
  ev.preventDefault();
  try{
    if(!can("spec.write"))throw Error("Нет прав на изменение формы");
    const fields=[...$("edit-form-fields").children]
      .filter(item=>item.querySelector("input[type=checkbox]").checked)
      .map(item=>item.dataset.name);
    if(!fields.length)throw Error("Выбери хотя бы одно поле для формы");
    const page=$("page-select").value;
    const index=Number($("section-select").value);
    const result=await api("/api/v1/pages/"+page+"/form",{method:"PATCH",
      body:{expected_revision:state.revision,section_index:index,
        model:$("edit-form-model").value,heading:$("edit-form-heading").value,
        button_label:$("edit-form-button").value,fields}});
    await sync();
    $("page-select").value=page;pageChanged();
    $("section-select").value=String(index);sectionChanged();
    show("Настройки формы сохранены · ревизия "+result.revision);
  }catch(err){show(err.message,true);}
});
function sectionTemplate(type){
  if(type==="text")return {type:"text",heading:"Новый текстовый раздел",text:"Добавьте описание раздела."};
  if(type==="hero")return {type:"hero",heading:"Новая обложка",text:"Опишите ключевую идею."};
  if(type==="features")return {type:"features",heading:"Новые преимущества",items:["Первое преимущество"]};
  if(type==="stats")return {type:"stats",heading:"Новые показатели",items:[{label:"Показатель",value:"—"}]};
  if(type==="form"){
    const m=state.spec.models.find(m=>m.name===$("form-model-select").value);
    if(!m)throw Error("Сначала создай модель для формы");
    return {type:"form",heading:"Форма: "+m.label,model:m.name,
            button_label:"Сохранить",fields:m.fields.map(f=>f.name)};
  }
  throw Error("Неизвестный тип раздела");
}
async function modifyStructure(operation,targetIndex=null){
  if(!can("spec.write"))throw Error("Недостаточно прав для изменения структуры");
  const slug=$("page-select").value;
  const page=state.spec.pages.find(p=>p.slug===slug);
  const index=Number($("section-select").value);
  const params={expected_revision:state.revision,operation,index};
  if(operation==="add"){
    params.index=index+1;
    params.section=sectionTemplate($("new-section-type").value);
  }
  if(operation==="move"){
    params.target_index=targetIndex;
  }
  const out=await api("/api/v1/pages/"+slug+"/structure",{method:"POST",body:params});
  await sync();
  $("page-select").value=slug;
  pageChanged();
  $("section-select").value=String(Math.min(
    operation==="add"?index+1:operation==="remove"?Math.max(index-1,0):
    operation==="move"?targetIndex:index,
    state.spec.pages.find(p=>p.slug===slug).sections.length-1));
  sectionChanged();
  show("Структура обновлена · ревизия "+out.revision);
}
$("add-section").addEventListener("click",()=>modifyStructure("add").catch(e=>show(e.message,true)));
$("move-section-up").addEventListener("click",()=>{
  const i=Number($("section-select").value);
  if(i>0)modifyStructure("move",i-1).catch(e=>show(e.message,true));
});
$("move-section-down").addEventListener("click",()=>{
  const page=state.spec.pages.find(p=>p.slug===$("page-select").value);
  const i=Number($("section-select").value);
  if(i<page.sections.length-1)modifyStructure("move",i+1).catch(e=>show(e.message,true));
});
$("remove-section").addEventListener("click",()=>{
  if(confirm("Удалить выбранный раздел? История версий сохранится.")){
    modifyStructure("remove").catch(e=>show(e.message,true));
  }
});
async function managePage(operation,direction=0){
  if(!can("spec.write"))throw Error("Недостаточно прав для изменения страниц");
  const selected=$("page-select").value;
  const current=state.spec.pages.find(p=>p.slug===selected);
  if(!current)throw Error("Сначала выбери страницу");
  const newSlug=$("page-new-slug").value.trim();
  const newTitle=$("page-new-title").value.trim();
  const params={expected_revision:state.revision,operation,slug:selected};
  if(operation==="add"||operation==="duplicate"||operation==="rename"){
    if(!/^[a-z][a-z0-9-]{0,39}$/.test(newSlug))
      throw Error("Адрес: латинские строчные буквы, цифры и дефисы");
    if(operation==="add"){params.slug=newSlug;params.title=newTitle;}
    else{params.target_slug=newSlug;if(newTitle)params.title=newTitle;}
  }
  if(operation==="move"){
    const index=state.spec.pages.findIndex(p=>p.slug===selected);
    const target=index+direction;
    if(target<0||target>=state.spec.pages.length)return;
    params.target_index=target;
  }
  if(operation==="remove"){
    if(selected==="home")throw Error("Главную страницу удалить нельзя");
    if(!confirm("Удалить страницу «"+current.title+"»? История останется доступной."))return;
  }
  const out=await api("/api/v1/pages/manage",{method:"POST",body:params});
  await sync();
  const next=operation==="remove"?"home":operation==="rename"||
    operation==="duplicate"||operation==="add"?newSlug:selected;
  $("page-select").value=next;
  pageChanged();
  $("page-new-slug").value="";
  $("page-new-title").value="";
  show("Страницы обновлены · ревизия "+out.revision+" · "+out.page_count+" страниц");
}
for(const [id,op,dir] of [
  ["page-create","add",0],["page-duplicate","duplicate",0],
  ["page-rename","rename",0],["page-up","move",-1],
  ["page-down","move",1],["page-remove","remove",0]
]){
  $(id).addEventListener("click",()=>managePage(op,dir).catch(e=>show(e.message,true)));
}
$("page-select").addEventListener("change",pageChanged);
$("section-select").addEventListener("change",sectionChanged);
$("page-form").addEventListener("submit",async ev=>{
  ev.preventDefault();
  try{
    const page=state.spec.pages.find(p=>p.slug===$("page-select").value);
    const index=Number($("section-select").value);
    const section=page.sections[index];
    const changes={heading:$("section-heading").value};
    if(Object.hasOwn(section,"text"))changes.text=$("section-text").value;
    const response=await api("/api/v1/pages/"+page.slug,{method:"PATCH",
      body:{expected_revision:state.revision,title:$("page-title").value,
            section_index:index,changes}});
    show("Новая ревизия: "+response.revision);await sync();
  }catch(e){show(e.message,true);}
});
function renderSchema(){
  if(!state.spec)return;
  const models=state.spec.models;
  const options=models.map(m=>[m.name,m.label]);
  pick($("schema-select-model"),options);
  pick($("schema-reference-model"),options);
  pick($("form-model-select"),options);
  pick($("schema-rename-model"),options);
  pick($("link-rename-model"),options);
  pick($("link-retarget-model"),options);
  pick($("link-target-model"),options);
  pick($("map-model"),options);
  pick($("map-target-model"),options);
  populateMapFields();
  populateRenameFields();
  updateReferenceTargets();
  const labels=[];
  for(const m of models){
    labels.push(["model:"+m.name,"Модель · "+m.label]);
    for(const f of m.fields)labels.push(["field:"+m.name+":"+f.name,"Поле · "+m.label+" / "+f.label]);
  }
  pick($("schema-label-target"),labels);
  if(labels.length)$("schema-label-value").value="";
  updateSchemaFieldType();
  updateNewSectionFormType();
}
function clearMapPlan(clearChoices=false){
  state.mappedPlan=null;
  state.mappedPayload=null;
  $("map-approval").hidden=true;
  $("map-approve").checked=false;
  $("map-apply").disabled=true;
  if(clearChoices){
    $("map-review-form").hidden=true;
    $("map-rows").replaceChildren();
  }
}
function populateMapFields(){
  const m=state.spec?.models.find(model=>model.name===$("map-model").value);
  const fields=(m?.fields||[]).filter(f=>f.type==="reference");
  pick($("map-field"),fields.map(f=>[f.name,f.label+" → "+f.references]));
  clearMapPlan(true);
}
for(const id of ["map-model","map-field","map-target-model"]){
  $(id).addEventListener("change",()=>{
    if(id==="map-model")populateMapFields();
    clearMapPlan(true);
  });
}
$("map-options-form").addEventListener("submit",async ev=>{
  ev.preventDefault();
  clearMapPlan(true);
  try{
    const payload={model:$("map-model").value,field:$("map-field").value,
                   new_target_model:$("map-target-model").value};
    const result=await api("/api/v1/references/map/options",{method:"POST",body:payload});
    if(result.too_many_for_browser)
      throw Error("Больше 100 вариантов. Используй проверяемый локальный план, а не интерфейс.");
    if(!result.sources.length || !result.targets.length)
      throw Error("Нет записей для переноса или отсутствуют новые целевые записи");
    const root=$("map-rows");
    root.replaceChildren();
    for(const source of result.sources){
      const row=node("div",null,"mapped-row");
      row.dataset.sourceId=source.id;
      const label=node("label",source.label+" · "+source.id.slice(0,8));
      const pickTarget=node("select");
      pickTarget.setAttribute("aria-label","Новая запись для "+source.label);
      pick(pickTarget,[["","Выбери новую запись"],
        ...result.targets.map(r=>[r.id,r.label+" · "+r.id.slice(0,8)])]);
      pickTarget.addEventListener("change",()=>clearMapPlan());
      row.append(label,pickTarget);
      root.append(row);
    }
    $("map-review-form").hidden=false;
    show("Загружено "+result.sources.length+" старых ссылок. Сопоставь каждую вручную.");
  }catch(err){show(err.message,true);}
});
$("map-review-form").addEventListener("submit",async ev=>{
  ev.preventDefault();
  clearMapPlan();
  try{
    if(!can("spec.write")||!can("record.write"))throw Error("Недостаточно прав");
    const entries=[...$("map-rows").children].map(row=>({
      from_id:row.dataset.sourceId,to_id:row.querySelector("select").value}));
    if(entries.some(x=>!x.to_id))throw Error("Для каждого старого ID нужно выбрать новый");
    if(new Set(entries.map(x=>x.to_id)).size!==entries.length)
      throw Error("Каждой старой связи должна соответствовать отдельная новая запись");
    const payload={expected_revision:state.revision,model:$("map-model").value,
      field:$("map-field").value,new_target_model:$("map-target-model").value,
      mapping:entries};
    const inspection=await api("/api/v1/references/map/inspect",{
      method:"POST",body:payload});
    state.mappedPayload=payload;
    state.mappedPlan=inspection;
    $("map-approval").hidden=false;
    $("map-plan-summary").textContent=inspection.plan.changed_rows+
      " записей · "+inspection.plan.changed_links+
      " связей · ревизия "+inspection.plan.expected_revision+
      " → "+(inspection.plan.expected_revision+1);
    $("map-plan-digest").textContent="SHA-256: "+inspection.plan_sha256;
    show("План проверен. Перед выполнением подтвердите соответствия.");
  }catch(err){show(err.message,true);}
});
$("map-approve").addEventListener("change",()=>{
  $("map-apply").disabled=!state.mappedPlan||!$("map-approve").checked;
});
$("map-apply").addEventListener("click",async()=>{
  try{
    if(!state.mappedPlan||!state.mappedPayload||!$("map-approve").checked)
      throw Error("Сначала проверь и подтверди план");
    const out=await api("/api/v1/references/map/apply",{
      method:"POST",body:{...state.mappedPayload,
        expected_plan_sha256:state.mappedPlan.plan_sha256}});
    await sync();
    await refreshMigrationHistory();
    show("Связи перенесены: "+out.changed_links+
      " · новая ревизия "+out.revision+". Без сетевых операций.");
  }catch(err){clearMapPlan();show(err.message,true);}
});
$("recovery-drill").addEventListener("click",async()=>{
  try{
    if(!can("members.manage"))throw Error("Проверка доступна только владельцу");
    $("recovery-drill").disabled=true;
    $("recovery-drill-summary").textContent="Проверка копии…";
    const result=await api("/api/v1/recovery/drill",{method:"POST",body:{}});
    if(result.passed!==true||result.scratch_only!==true||result.source_database_modified!==false)
      throw Error("Восстановление на отдельной копии не подтверждено");
    $("recovery-drill-summary").textContent="PASS · "+result.rows_verified+
      " записей · "+result.links_verified+
      " связей · SHA "+result.verified_bundle_sha256.slice(0,16)+"…"+
      " · исходная база без изменений";
    show("Изолированная проверка восстановления пройдена");
  }catch(e){
    $("recovery-drill-summary").textContent="Проверка не прошла.";
    show(e.message,true);
  }finally{
    $("recovery-drill").disabled=!can("members.manage");
  }
});
$("recovery-inspect").addEventListener("click",async()=>{
  try{
    if(!can("members.manage"))throw Error("Только владелец может проверять полный архив");
    const result=await api("/api/v1/recovery/inspect");
    $("recovery-summary").textContent="Ревизия "+result.revision+
      " · записей "+result.records+" · связей "+result.links+
      " · SQLite "+result.sqlite_quick_check+
      " · SHA "+result.bundle_sha256.slice(0,20)+"…";
    show("Проектный снимок проверен. Данные не экспортированы и не восстановлены.");
  }catch(e){show(e.message,true);}
});
function relationFields(modelName){
  const m=state.spec?.models.find(m=>m.name===modelName);
  return m?m.fields.filter(f=>f.type==="reference"):[];
}
function updateReferenceTargets(){
  const a=relationFields($("link-rename-model").value);
  const b=relationFields($("link-retarget-model").value);
  pick($("link-rename-field"),a.map(f=>[f.name,f.label+" → "+f.references]));
  pick($("link-retarget-field"),b.map(f=>[f.name,f.label+" → "+f.references]));
}
$("link-rename-model").addEventListener("change",updateReferenceTargets);
$("link-retarget-model").addEventListener("change",updateReferenceTargets);
$("link-rename-form").addEventListener("submit",async ev=>{
  ev.preventDefault();
  try{
    if(!can("spec.write")||!can("record.write"))throw Error("Нет прав на миграцию связей");
    if(!$("link-rename-confirm").checked)throw Error("Подтверди проверку связей");
    const out=await api("/api/v1/schema/models/"+
      $("link-rename-model").value+"/rename-reference",{
        method:"POST",body:{expected_revision:state.revision,
          old_name:$("link-rename-field").value,
          new_name:$("link-new-name").value.trim()}});
    await sync();
    $("link-new-name").value="";
    $("link-rename-confirm").checked=false;
    await refreshMigrationHistory();
    show("Поле-связь мигрировано · "+out.updated_links+" связей · ревизия "+out.revision);
  }catch(e){show(e.message,true);}
});
$("link-retarget-form").addEventListener("submit",async ev=>{
  ev.preventDefault();
  try{
    if(!can("spec.write")||!can("record.write"))throw Error("Нет прав на смену целевой модели");
    if(!$("link-retarget-confirm").checked)throw Error("Подтверди отсутствие связей");
    const out=await api("/api/v1/schema/models/"+
      $("link-retarget-model").value+"/retarget-unused-reference",{
        method:"POST",body:{expected_revision:state.revision,
          field:$("link-retarget-field").value,
          new_target_model:$("link-target-model").value}});
    await sync();
    $("link-retarget-confirm").checked=false;
    await refreshMigrationHistory();
    show("Целевая модель изменена для пустой связи · ревизия "+out.revision);
  }catch(e){show(e.message,true);}
});
async function refreshRevisions(){
  if(!state.token || !state.spec)return;
  const response=await api("/api/v1/revisions");
  pick($("history-revision"),response.revisions
    .filter(x=>x.revision<state.revision)
    .map(x=>[String(x.revision),"v"+x.revision+" · "+x.pages+" страниц · "+x.sha256.slice(0,12)]));
}
$("history-revision").addEventListener("change",()=>{
  state.restorePlan=null;
  $("history-plan").hidden=true;
  $("history-empty").hidden=false;
  $("history-approve").checked=false;
  $("history-apply").disabled=true;
});
$("history-inspect-form").addEventListener("submit",async ev=>{
  ev.preventDefault();
  try{
    if(!can("spec.write"))throw Error("Только редактор может восстанавливать страницы");
    const target=Number($("history-revision").value);
    if(!Number.isSafeInteger(target)||target<1||target>=state.revision)
      throw Error("Выбери предыдущую ревизию");
    const res=await api("/api/v1/revisions/restore/inspect",{method:"POST",
      body:{expected_revision:state.revision,target_revision:target}});
    state.restorePlan=res;
    $("history-plan").hidden=false;
    $("history-empty").hidden=true;
    $("history-approve").checked=false;
    $("history-apply").disabled=true;
    $("history-plan-summary").textContent="Текущая v"+res.plan.current_revision+
      " → снимок v"+res.plan.target_revision+" · "+
      res.plan.pages_after+" страниц · SHA "+res.plan.target_sha256.slice(0,16);
    $("history-page-changes").textContent="Изменяемые страницы: "+
      (res.plan.changed_page_slugs.join(", ")||"нет")+
      (res.plan.site_metadata_changed?" · Метаданные сайта":"");
    show("План восстановления проверен. Данные записей остаются нетронутыми.");
  }catch(e){state.restorePlan=null;$("history-plan").hidden=true;
    $("history-empty").hidden=false;show(e.message,true);}
});
$("history-approve").addEventListener("change",()=>{
  $("history-apply").disabled=!state.restorePlan || !$("history-approve").checked;
});
$("history-apply").addEventListener("click",async()=>{
  try{
    const plan=state.restorePlan;
    if(!plan||!$("history-approve").checked)
      throw Error("Сначала проверь и подтверди план");
    const data=await api("/api/v1/revisions/restore",{method:"POST",
      body:{expected_revision:plan.plan.current_revision,
        target_revision:plan.plan.target_revision,
        expected_plan_sha256:plan.plan_sha256}});
    await sync();
    await refreshRevisions();
    show("Создана новая версия v"+data.revision+
      " из v"+data.restored_from+". Клиентские записи не изменены.");
  }catch(e){state.restorePlan=null;$("history-apply").disabled=true;
    show(e.message,true);}
});
function populateRenameFields(){
  const model=state.spec?.models.find(m=>m.name===$("schema-rename-model").value);
  pick($("schema-rename-source"),model
    ?model.fields.filter(f=>f.type!=="reference").map(f=>[f.name,f.label]):[]);
}
$("schema-rename-model").addEventListener("change",populateRenameFields);
$("schema-rename-form").addEventListener("submit",async ev=>{
  ev.preventDefault();
  try{
    if(!can("spec.write")||!can("record.write"))throw Error("Недостаточно прав на миграцию");
    if(!$("schema-rename-approve").checked)throw Error("Подтверди проверку миграции");
    const model=$("schema-rename-model").value;
    const response=await api("/api/v1/schema/models/"+model+"/rename-field",{
      method:"POST",body:{expected_revision:state.revision,
        old_name:$("schema-rename-source").value,
        new_name:$("schema-rename-target").value.trim()}});
    await sync();
    $("schema-rename-target").value="";
    $("schema-rename-approve").checked=false;
    await refreshMigrationHistory();
    show("Поле переименовано · ревизия "+response.revision+
         " · перенесено записей "+response.rows_migrated);
  }catch(err){show(err.message,true);}
});
function updateSchemaFieldType(){
  const isRef=$("schema-field-type").value==="reference";
  $("schema-reference-model").disabled=!isRef;
  $("schema-default").disabled=isRef;
  if(isRef)$("schema-default").value="";
}
function updateNewSectionFormType(){
  const selected=$("new-section-type").value==="form";
  $("form-model-label").hidden=!selected;
  $("form-model-select").hidden=!selected;
}
function schemaDefault(type,text){
  const val=text.trim();
  if(val==="")return {provided:false};
  if(type==="integer"){
    if(!/^-?\d+$/.test(val) || !Number.isSafeInteger(Number(val)))throw Error("Нужно допустимое целое число");
    return {provided:true,value:Number(val)};
  }
  if(type==="boolean"){
    if(!["true","false"].includes(val))throw Error("Для Да/Нет используй true или false");
    return {provided:true,value:val==="true"};
  }
  return {provided:true,value:val};
}
async function refreshMigrationHistory(){
  if(!state.token || !state.spec)return;
  const result=await api("/api/v1/schema/migrations");
  const root=$("schema-migrations");
  root.replaceChildren();
  if(!result.migrations.length){
    root.append(node("p","Миграций пока нет.","muted"));
    return;
  }
  for(const m of result.migrations){
    const item=node("div",null,"workflow-item");
    item.append(node("strong","v"+m.spec_revision+" · "+m.operation+" · "+m.model_name));
    item.append(node("small","Обновлено записей: "+m.rows_migrated));
    root.append(item);
  }
}
$("schema-field-type").addEventListener("change",updateSchemaFieldType);
$("new-section-type").addEventListener("change",updateNewSectionFormType);
$("schema-model-form").addEventListener("submit",async event=>{
  event.preventDefault();
  try{
    const model={
      name:$("schema-model-name").value.trim(),
      label:$("schema-model-label").value.trim(),
      fields:[{name:"name",label:"Название",type:"text",required:true}]
    };
    const out=await api("/api/v1/schema/models",{method:"POST",
      body:{expected_revision:state.revision,model}});
    await sync();
    $("schema-model-name").value="";
    $("schema-model-label").value="";
    await refreshMigrationHistory();
    show("Модель создана · ревизия "+out.revision);
  }catch(e){show(e.message,true);}
});
$("schema-field-form").addEventListener("submit",async event=>{
  event.preventDefault();
  try{
    const type=$("schema-field-type").value;
    const modelName=$("schema-select-model").value;
    const field={
      name:$("schema-field-name").value.trim(),
      label:$("schema-field-label").value.trim(),
      type,required:$("schema-field-required").checked
    };
    if(type==="reference")field.references=$("schema-reference-model").value;
    const body={expected_revision:state.revision,field};
    if(type!=="reference"){
      const value=schemaDefault(type,$("schema-default").value);
      if(value.provided)body.default_value=value.value;
    }
    const out=await api("/api/v1/schema/models/"+modelName+"/fields",
      {method:"POST",body});
    await sync();
    $("schema-select-model").value=modelName;
    $("schema-field-name").value="";
    $("schema-field-label").value="";
    $("schema-default").value="";
    await refreshMigrationHistory();
    show("Поле добавлено · ревизия "+out.revision+" · изменено записей "+out.rows_migrated);
  }catch(e){show(e.message,true);}
});
$("schema-label-form").addEventListener("submit",async event=>{
  event.preventDefault();
  try{
    const [kind,model,field]=$("schema-label-target").value.split(":");
    const suffix=kind==="model"?"":"/fields/"+field;
    const out=await api("/api/v1/schema/models/"+model+suffix,{method:"PATCH",
      body:{expected_revision:state.revision,label:$("schema-label-value").value.trim()}});
    await sync();
    await refreshMigrationHistory();
    show("Название обновлено · ревизия "+out.revision);
  }catch(e){show(e.message,true);}
});
function renderModels(){
  pick($("model-select"),state.spec.models.map(m=>[m.name,m.label]));
  pick($("wf-model"),state.spec.models.map(m=>[m.name,m.label]));
  state.model=$("model-select").value;
  renderModelFields();updateWorkflowFields();
}
function renderModelFields(data={}){
  const m=model();
  const target=$("row-fields");
  target.replaceChildren();
  if(!m)return;
  const generation=(state.referenceGeneration=(state.referenceGeneration||0)+1);
  $("model-description").textContent=m.fields.length+" полей · типизированные данные";
  for(const field of m.fields){
    const box=node("div");
    const label=node("label",field.label+(field.required?" *":""));
    label.setAttribute("for","field-"+field.name);
    let input;
    if(field.type==="reference"){
      input=node("select");
      input.append(option("","Загрузка связанных записей…"));
      input.disabled=true;
      api("/api/v1/models/"+encodeURIComponent(field.references)+"/choices")
        .then(result=>{
          if(state.referenceGeneration!==generation || state.model!==m.name
             || $("field-"+field.name)!==input)return;
          const requested=data[field.name]??"";
          const available=result.choices.map(r=>[r.row_id,r.label+" · "+r.row_id.slice(0,8)]);
          if(requested && !available.some(([id])=>id===requested)){
            available.unshift([requested,"Ранее выбранная запись · "+requested.slice(0,8)]);
          }
          pick(input,[["","Без связи"],...available]);
          input.value=requested;
          input.disabled=!can("record.write");
          if(result.truncated){
            box.append(node("small","Показаны первые 100 записей. Уже выбранная связь сохранена.","hint"));
          }
        })
        .catch(err=>{
          if(state.referenceGeneration!==generation || $("field-"+field.name)!==input)return;
          pick(input,[["","Не удалось загрузить доступные записи"]]);
          input.disabled=true;
          show("Связи не загружены: "+err.message,true);
        });
    }else{
      input=node("input");
      if(field.type==="integer")input.type="number";
      else if(field.type==="date")input.type="date";
      else if(field.type==="email")input.type="email";
      else if(field.type==="boolean")input.type="checkbox";
      else input.type="text";
      if(field.type==="boolean")input.checked=Boolean(data[field.name]);
      else if(data[field.name]!==undefined && data[field.name]!==null)input.value=String(data[field.name]);
      input.disabled=!can("record.write");
    }
    input.id="field-"+field.name;
    input.dataset.field=field.name;
    input.required=Boolean(field.required);
    box.prepend(label);
    box.append(input);
    target.append(box);
  }
}
function readForm(){
  const data={};
  for(const f of model().fields){
    const el=$("field-"+f.name);
    const raw=f.type==="boolean"?el.checked:el.value.trim();
    if(raw==="" && !f.required){
      if(state.selectedRow && Object.hasOwn(state.selectedRow.fields,f.name))data[f.name]=null;
      continue;
    }
    data[f.name]=typed(f,raw);
  }
  return data;
}
async function refreshRows(){
  if(!state.spec || !can("record.read"))return;
  const targetModel=state.model;
  const answer=await api("/api/v1/models/"+encodeURIComponent(targetModel));
  if(targetModel!==state.model)return;
  state.rows=answer.rows;
  pick($("row-select"),[["","Новая запись"],...state.rows.map(r=>
    [r.row_id,(r.fields[model().fields[0].name]??r.row_id)+" · v"+r.version])]);
  state.selectedRow=null;
  renderModelFields();
  $("row-form-title").textContent="Новая запись";
  $("delete-row").disabled=true;
  drawTable();
}
function drawTable(){
  const root=$("rows-table");root.replaceChildren();
  const m=model();if(!m)return;
  const table=node("table"),head=node("thead"),hrow=node("tr");
  for(const field of m.fields)hrow.append(node("th",field.label));
  hrow.append(node("th","Версия"));head.append(hrow);table.append(head);
  const tbody=node("tbody");
  for(const r of state.rows){
    const tr=node("tr");
    for(const f of m.fields){
      const v=r.fields[f.name];tr.append(node("td",v==null?"—":String(v)));
    }
    tr.append(node("td",r.version));tbody.append(tr);
  }
  table.append(tbody);root.append(table);
}
function selectRow(){
  state.selectedRow=state.rows.find(x=>x.row_id===$("row-select").value)||null;
  renderModelFields(state.selectedRow?.fields||{});
  $("row-form-title").textContent=state.selectedRow?"Изменение записи":"Новая запись";
  $("delete-row").disabled=!can("record.write")||!state.selectedRow;
}
$("model-select").addEventListener("change",async()=>{
  state.model=$("model-select").value;
  try{await refreshRows();}catch(e){show(e.message,true);}
});
$("row-select").addEventListener("change",selectRow);
$("new-row").addEventListener("click",()=>{
  $("row-select").value="";selectRow();
});
$("row-form").addEventListener("submit",async ev=>{
  ev.preventDefault();
  try{
    const data=readForm();
    const current=state.selectedRow;
    const path="/api/v1/models/"+state.model;
    if(current){
      await api(path+"/"+current.row_id,{method:"PATCH",
        body:{expected_version:current.version,changes:data,idempotency_key:safeId()}});
    }else{
      await api(path,{method:"POST",body:{data,idempotency_key:safeId()}});
    }
    await refreshRows();show("Запись сохранена в SQLite");
  }catch(e){show(e.message,true);}
});
$("delete-row").addEventListener("click",async()=>{
  const current=state.selectedRow;
  if(!current || !confirm("Удалить эту запись? Связанные записи не будут удалены."))return;
  try{
    await api("/api/v1/models/"+state.model+"/"+current.row_id,{method:"DELETE",
      body:{expected_version:current.version,idempotency_key:safeId()}});
    await refreshRows();show("Запись удалена");
  }catch(e){show(e.message,true);}
});
function updateWorkflowFields(){
  const m=state.spec?.models.find(x=>x.name===$("wf-model").value);
  if(!m)return;
  pick($("wf-condition-field"),[["","Без условия"],...m.fields.map(f=>[f.name,f.label])]);
  pick($("wf-action-field"),m.fields.filter(f=>f.type!=="reference").map(f=>[f.name,f.label]));
}
$("wf-model").addEventListener("change",updateWorkflowFields);
$("workflow-form").addEventListener("submit",async ev=>{
  ev.preventDefault();
  try{
    const m=state.spec.models.find(x=>x.name===$("wf-model").value);
    const actionField=m.fields.find(f=>f.name===$("wf-action-field").value);
    const conditionField=m.fields.find(f=>f.name===$("wf-condition-field").value);
    const rule={schema:"osgard.original180.app-workflow/1",name:$("wf-name").value,
      model:m.name,trigger:$("wf-trigger").value,
      condition:conditionField?{field:conditionField.name,
        equals:typed(conditionField,$("wf-condition-value").value.trim())}:null,
      action:{type:"set_field",field:actionField.name,
              value:typed(actionField,$("wf-action-value").value.trim())}};
    await api("/api/v1/workflows",{method:"POST",body:{rule}});
    $("wf-name").value="";$("wf-action-value").value="";
    await sync();show("Правило создано. Для запуска выбери запись.");
  }catch(e){show(e.message,true);}
});
function renderWorkflows(){
  const target=$("workflow-list");target.replaceChildren();
  if(!state.workflows.length){target.append(node("p","Правил пока нет.","muted"));return;}
  for(const w of state.workflows){
    const card=node("div",null,"workflow-item");
    card.append(node("strong",w.rule.name));
    card.append(node("small",w.rule.model+" · "+w.rule.trigger+(w.enabled?" · активно":" · выключено")));
    if(w.enabled){
      if(w.rule.trigger==="manual"){
      const run=node("button","Запустить","ghost");
      run.type="button";run.disabled=!can("workflow.run");
      run.addEventListener("click",async()=>{
        const rowId=$("wf-run-row").value.trim();
        if(!rowId){show("Укажи UUID записи для запуска правила",true);return;}
        try{
          const result=await api("/api/v1/workflows/"+w.workflow_id+"/run",
            {method:"POST",body:{event_id:safeId(),trigger:w.rule.trigger,row_id:rowId}});
          show(result.changed?"Правило изменило запись":"Правило выполнено без изменения");
          if(state.model===w.rule.model)await refreshRows();
        }catch(e){show(e.message,true);}
      });card.append(run);
      }else{
        card.append(node("small","Автоматически при событии. Ручной запуск запрещён."));
      }
      const disable=node("button","Отключить","danger");
      disable.type="button";disable.disabled=!can("workflow.manage");
      disable.addEventListener("click",async()=>{
        try{
          await api("/api/v1/workflows/"+w.workflow_id+"/disable",
            {method:"POST",body:{expected_revision:w.revision}});
          await sync();show("Правило отключено");
        }catch(e){show(e.message,true);}
      });card.append(disable);
    }
    target.append(card);
  }
}
async function refreshPreview(){
  try{
    const page=$("preview-select").value;
    if(!page)return;
    const response=await api("/api/v1/preview/"+page);
    $("preview-frame").srcdoc=response.html;
    show("Обновлено локальное статическое превью");
  }catch(e){show(e.message,true);}
}
$("preview-select").addEventListener("change",refreshPreview);
$("refresh-preview").addEventListener("click",refreshPreview);
})();
