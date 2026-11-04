"use strict";
/* Standalone local M197 project cards. No localStorage, external API or HTML injection. */
const state={token:"",identity:null,projects:[],selected:null,card:null,search:"",generation:0};
const $=id=>document.getElementById(id);
const el=(tag,cls,text)=>{const node=document.createElement(tag);if(cls)node.className=cls;if(text!==undefined)node.textContent=String(text);return node;};
const fmt=n=>n==null?"Срок не задан":new Date(Number(n)*1000).toLocaleString("ru-RU",{dateStyle:"medium",timeStyle:"short"});
const code={planned:"Планируется",active:"В работе",completed:"Завершён",cancelled:"Отменён",open:"Открыто",fulfilled:"Исполнено",waived:"Снято владельцем",done:"Завершён",pending:"Ожидает"};
const word=x=>code[x]||String(x||"");
const controlsDisabled=()=>!state.identity||state.identity.role==="viewer";
const canManage=()=>!controlsDisabled()&&state.card&&(state.identity.role==="owner"||state.identity.actor===state.card.project.created_by)&&!["completed","cancelled"].includes(state.card.project.state);
const toast=message=>{const node=$("toast");node.textContent=String(message);node.hidden=false;clearTimeout(toast.timer);toast.timer=setTimeout(()=>node.hidden=true,4200);};
function uuid(){if(crypto.randomUUID)return crypto.randomUUID();const bytes=new Uint8Array(16);crypto.getRandomValues(bytes);return Array.from(bytes,n=>n.toString(16).padStart(2,"0")).join("");}
async function api(operation,payload={},write=false){
  if(!state.token)throw Error("Нет авторизации");
  const body={operation,payload,idempotency_key:write?"m197-"+uuid():null};
  const response=await fetch("/v1/execute",{method:"POST",cache:"no-store",headers:{"Content-Type":"application/json","Authorization":"Bearer "+state.token},body:JSON.stringify(body)});
  const data=await response.json();
  if(!response.ok||!data.ok){const ex=new Error(data.message||data.error||"Ошибка сервера");ex.status=response.status;throw ex;}
  return data.result;
}
function logout(){state.generation++;state.token="";state.identity=null;state.projects=[];state.selected=null;state.card=null;$("token").value="";$("login").hidden=false;$("shell").hidden=true;}
async function connect(e){e.preventDefault();const token=$("token").value;state.token=token;$("loginError").hidden=true;
  try{state.identity=await api("titan.session.get");$("token").value="";$("login").hidden=true;$("shell").hidden=false;
    $("actor").textContent=state.identity.actor+" · "+state.identity.role;await refresh();}
  catch(error){$("loginError").textContent="Не удалось войти: "+error.message;$("loginError").hidden=false;state.token="";}}
async function refresh(){const marker=++state.generation;try{
    const items=await api("commerce.projects.list");if(marker!==state.generation)return;
    state.projects=items.items||[];
    if(!state.selected||!state.projects.some(x=>x.id===state.selected))state.selected=state.projects.length?state.projects[0].id:null;
    renderProjects();await loadCard(marker);
  }catch(error){toast("Ошибка загрузки: "+error.message);}}
async function loadCard(marker=++state.generation){if(!state.selected){state.card=null;renderCard();return;}
  try{const current=state.selected;const result=await api("commerce.projects.card",{project_id:current});
    if(marker!==state.generation||state.selected!==current)return;state.card=result;renderCard();}
  catch(error){toast("Не удалось открыть карточку: "+error.message);}}
function projectButton(label,click,cls="secondary"){const b=el("button",cls,label);b.type="button";b.onclick=click;return b;}
function renderProjects(){const container=$("projects");container.replaceChildren();const q=state.search.toLocaleLowerCase("ru").trim();
  for(const p of state.projects.filter(p=>(p.title+" "+(p.customer_name||"")).toLocaleLowerCase("ru").includes(q))){
    const b=el("button","project-nav"+(p.id===state.selected?" active":""));b.type="button";
    b.append(el("strong","",p.title),el("small","",(p.customer_name||"Клиент")+" · "+word(p.state)));
    b.onclick=()=>{state.selected=p.id;state.card=null;renderProjects();renderCard();loadCard();};container.appendChild(b);
  }
  if(!container.children.length)container.append(el("p","muted","Нет проектов"));
}
function renderCard(){const root=$("content");root.replaceChildren();const data=state.card;if(!data){root.append(el("div","empty",state.selected?"Загрузка карточки...":"Нет проектов. Создайте проект в основной CRM."));return;}
  const project=data.project,h=data.delivery_health;
  const hero=el("section","hero"),text=el("div");
  text.append(el("div","eyebrow","КАРТОЧКА ПРОЕКТА · M197"),el("h1","",project.title),
    el("p","",(project.description||"Проект привязан к сделке CRM")+" · Данные обновлены "+fmt(project.updated_at)));
  hero.append(text,el("span","tag "+(project.state==="active"?"ok":""),word(project.state)));root.appendChild(hero);
  const stats=el("div","stats");for(const [name,value,hint] of [
    ["Этапы",h.stages_done+" / "+h.stages_total,"Реальный прогресс"],
    ["Обязательства",h.open_obligations,"Открытых клиентских обещаний"],
    ["Просрочки",h.overdue_stages+h.overdue_obligations,"Этапы и обязательства"],
    ["Документы",h.documents_total,"Версионированные файлы"]]){
      const card=el("div","stat");card.append(el("span","hint",name),el("strong","",value),el("small","",hint));stats.appendChild(card);
    }root.appendChild(stats);
  const status=el("p","notice",h.status==="AT_RISK"?"Есть просрочки по этапам или обязательствам. Проверьте сроки и договорённости с клиентом.":
    h.status==="OPEN_COMMITMENTS"?"Есть обязательства, которые необходимо подтвердить или снять отдельным решением владельца.":
    "В локальных данных нет просроченных открытых обязательств. Это не является независимой приёмкой проекта.");root.appendChild(status);
  root.appendChild(renderStages(data.stages||[],data.progress_percent));
  root.appendChild(renderObligations(data));
  root.appendChild(renderDocuments(data));
  root.appendChild(renderHistory());
}
function panel(title,subtitle){const block=el("section","section"),head=el("div","section-head"),desc=el("div");desc.append(el("h2","",title),el("p","",subtitle));head.append(desc);block.append(head);return {block,head};}
function emptyList(parent,text){parent.append(el("div","empty",text));}
function renderStages(stages,progress){const {block,head}=panel("Этапы исполнения","Связь этапов с реальными задачами сотрудников");head.append(el("span","tag",String(progress||0)+"%"));
  const bar=el("div","progress"),fill=el("span");fill.style.width=Math.min(100,Math.max(0,Number(progress)||0))+"%";bar.append(fill);block.append(bar);
  const list=el("div","data-list");list.style.marginTop="18px";
  if(!stages.length)emptyList(list,"Этапов пока нет. Добавьте их в основной CRM.");
  for(const s of stages){const row=el("div","data-row"),left=el("div");left.append(el("strong","",String(s.rank).padStart(2,"0")+" · "+s.title),el("small","",fmt(s.due_at)+" · Задач: "+s.linked_total+" · Выполнено: "+s.linked_done));
    row.append(left,el("span","tag "+(s.status==="done"?"ok":""),word(s.status)));list.append(row);}
  block.append(list);return block;
}
function renderObligations(card){const {block,head}=panel("Обязательства клиенту","Поставленные сроки, подтверждения и решения владельца");
  const can=canManage()&&!card.details_redacted;
  if(can)head.append(projectButton("+ Обязательство",()=>edit("obligation"),"primary"));
  const list=el("div","data-list");if(card.details_redacted){emptyList(list,"Подробности доступны владельцу или автору проекта.");}
  else if(!card.obligations?.length)emptyList(list,"Нет записанных обязательств.");
  for(const o of card.obligations||[]){const row=el("div","data-row"),left=el("div"),right=el("div","actions");
    left.append(el("strong","",o.title),el("small","",fmt(o.due_at)+" · Версия "+o.version));
    right.append(el("span","tag "+(o.status==="open"&&o.due_at&&o.due_at<card.delivery_health.calculated_at?"risk":o.status!=="open"?"ok":""),word(o.status)));
    if(can&&o.status==="open"){right.append(projectButton("Подтвердить",()=>edit("fulfill",o)));if(state.identity.role==="owner")right.append(projectButton("Снять",()=>edit("waive",o)));}
    row.append(left,right);list.append(row);}
  block.append(list);return block;
}
function renderDocuments(card){const {block,head}=panel("Документы и версии","Файлы хранятся локально в SQLite; у каждой версии свой SHA-256");const can=canManage()&&!card.details_redacted;
  if(can)head.append(projectButton("+ Загрузить файл",()=>edit("document"),"primary"));
  const list=el("div","data-list");if(card.details_redacted)emptyList(list,"Файлы доступны владельцу или автору проекта.");
  else if(!card.documents?.length)emptyList(list,"Файлов пока нет. Поддерживаются текст, Markdown и небольшие PDF до 48 КиБ.");
  for(const d of card.documents||[]){const row=el("div","data-row"),left=el("div"),buttons=el("div","actions");
    left.append(el("strong","",d.name),el("small","",d.mime+" · Версия "+d.version+" · "+d.byte_count+" байт · SHA-256 "+d.sha256.slice(0,12)+"..."));
    buttons.append(projectButton("Скачать",()=>download(d)));
    if(can)buttons.append(projectButton("Новая версия",()=>edit("revise",d)));
    row.append(left,buttons);list.append(row);}
  block.append(list);return block;
}
function renderHistory(){const {block,head}=panel("История изменений","Проверяемая локальная цепочка SHA-256, не независимая подпись клиента");
  if(state.card&&!state.card.details_redacted)head.append(projectButton("Загрузить историю",loadHistory));
  const list=el("div","timeline");list.id="historyList";if(state.card?.details_redacted)emptyList(list,"Доступно владельцу проекта.");
  else emptyList(list,"Откройте историю, чтобы посмотреть изменения и контрольные хеши.");block.append(list);return block;}
async function loadHistory(){if(!state.selected)return;try{const history=await api("commerce.projects.events",{project_id:state.selected});
    const list=$("historyList");if(!list)return;list.replaceChildren();for(const e of [...history.events].reverse().slice(0,60)){
      const entry=el("div","timeline-entry");entry.append(el("strong","",e.actor+" · "+e.kind),el("p","",fmt(e.at)+" · SHA "+e.event_hash.slice(0,14)+"..."));list.append(entry);}
    if(!history.events.length)emptyList(list,"История пуста");
  }catch(error){toast("История недоступна: "+error.message);}}
function field(container,label,kind,opts={}){const wrap=el("label","",label),input=el(kind);if(opts.type)input.type=opts.type;if(opts.name)input.name=opts.name;
  if(opts.required)input.required=true;if(opts.maxLength)input.maxLength=opts.maxLength;if(opts.min)input.min=opts.min;
  if(opts.accept)input.accept=opts.accept;if(opts.placeholder)input.placeholder=opts.placeholder;
  if(opts.value!==undefined)input.value=opts.value;
  if(opts.options){for(const x of opts.options){const opt=el("option","",x.label);opt.value=x.value;input.append(opt);}}
  wrap.append(input);container.append(wrap);return input;}
let dialogAction=null;
function edit(mode,record){if(!canManage())return;const root=$("formFields");root.replaceChildren();$("formError").hidden=true;
  let prepare;
  if(mode==="obligation"){
    $("formTitle").textContent="Новое обязательство";
    const title=field(root,"Что обещали клиенту", "input",{required:true,maxLength:200,placeholder:"Например, передать итоговый отчёт"});
    const due=field(root,"Срок исполнения","input",{type:"datetime-local"});
    const stages=[{value:"",label:"Весь проект"},...state.card.stages.filter(s=>s.status!=="done").map(s=>({value:s.id,label:s.title}))];
    const stage=field(root,"Этап проекта","select",{options:stages});
    prepare=async()=>{const p={project_id:state.selected,expected_project_version:state.card.project.version,title:title.value};
      if(stage.value)p.stage_id=stage.value;
      if(due.value){const time=new Date(due.value).getTime()/1000;if(!Number.isSafeInteger(time))throw Error("Неверная дата");p.due_at=time;}
      return api("commerce.projects.obligations.add",p,true);};
  }else if(mode==="document"||mode==="revise"){
    $("formTitle").textContent=mode==="revise"?"Новая версия документа":"Загрузить документ";
    const file=field(root,"Файл (до 48 КиБ)","input",{type:"file",required:true,accept:".txt,.md,.pdf,text/plain,text/markdown,application/pdf"});
    prepare=async()=>{const chosen=file.files?.[0];if(!chosen)throw Error("Выберите файл");if(chosen.size<1||chosen.size>49152)throw Error("Размер файла должен быть от 1 до 49152 байт");
      const buf=new Uint8Array(await chosen.arrayBuffer());const mime=chosen.name.toLowerCase().endsWith(".pdf")?"application/pdf":chosen.name.toLowerCase().endsWith(".md")?"text/markdown":"text/plain";
      let binary="";for(const byte of buf)binary+=String.fromCharCode(byte);
      if(mode==="document")return api("commerce.projects.documents.add",{project_id:state.selected,expected_project_version:state.card.project.version,
        name:chosen.name,mime,base64:btoa(binary)},true);
      if(mime!==record.mime)throw Error("Формат новой версии должен совпадать с исходным");
      return api("commerce.projects.documents.revise",{project_id:state.selected,document_id:record.id,expected_version:record.version,base64:btoa(binary)},true);};
  }else if(mode==="fulfill"||mode==="waive"){
    $("formTitle").textContent=mode==="waive"?"Снять обязательство":"Подтвердить исполнение";
    let input;
    if(mode==="waive")input=field(root,"Причина снятия","input",{required:true,maxLength:500,placeholder:"Письменное решение владельца"});
    else {
      if(!state.card.documents.length)root.append(el("p","notice","Сначала загрузите документ с подтверждением исполнения."));
      input=field(root,"Документ-подтверждение","select",{options:state.card.documents.map(d=>({label:d.name+" · версия "+d.version,value:d.sha256}))});
    }
    prepare=async()=>{if(!input.value)throw Error("Сначала загрузите подтверждающий документ");return api("commerce.projects.obligations.resolve",{
      project_id:state.selected,obligation_id:record.id,expected_version:record.version,
      status:mode==="waive"?"waived":"fulfilled",...(mode==="waive"?{waiver_reason:input.value}:{evidence_sha256:input.value})},true);};
  }
  dialogAction=prepare;$("editDialog").showModal();
}
async function download(doc){try{const data=await api("commerce.projects.documents.content",{project_id:state.selected,document_id:doc.id});
    const binary=atob(data.base64),bytes=Uint8Array.from(binary,c=>c.charCodeAt(0));
    const name=doc.name;const blob=new Blob([bytes],{type:doc.mime}),url=URL.createObjectURL(blob);const a=el("a");
    a.href=url;a.download=name;document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),2000);
  }catch(error){toast("Файл недоступен: "+error.message);}}
$("loginForm").addEventListener("submit",connect);
$("search").addEventListener("input",e=>{state.search=e.target.value;renderProjects();});
$("logout").onclick=logout;$("refresh").onclick=refresh;
$("closeDialog").onclick=()=>$("editDialog").close();$("cancelDialog").onclick=()=>$("editDialog").close();
$("editForm").addEventListener("submit",async e=>{e.preventDefault();if(!dialogAction)return;const submit=$("editForm").querySelector('button[type="submit"]');submit.disabled=true;
  try{await dialogAction();$("editDialog").close();toast("Изменения сохранены");await refresh();}
  catch(error){$("formError").textContent=error.status===409?"Данные изменились. Обновите карточку и повторите действие.":error.message;
    $("formError").hidden=false;}finally{submit.disabled=false;}});
