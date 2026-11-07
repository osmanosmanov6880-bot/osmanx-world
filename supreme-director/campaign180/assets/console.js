(() => {
"use strict";
const $ = id => document.getElementById(id);
const state = {token:"",me:null,spec:null,revision:0,workflows:[],rows:[],model:null,selectedRow:null,restorePlan:null,mappedPlan:null,mappedPayload:null,rowOffset:0,rowLimit:25,rowGeneration:0,csvPending:null,csvRetryKey:null,batchSelection:new Set(),batchPlan:null,batchRetryKey:null,batchRestorePlan:null,batchRestoreRetryKey:null,batchFieldGeneration:0,tasks:[],taskMembers:[],taskEditing:null,taskOffset:0,taskGeneration:0,taskPendingKey:null,collabTask:null,collabGeneration:0,commentPendingKey:null,checklistPendingKey:null,calendarGeneration:0,dependencyRetryKey:null,deliveryGeneration:0,deliveryData:null,deliveryPhaseKey:null,deliveryMilestoneKey:null,forecastGeneration:0,forecastData:null,forecastEffortKey:null,forecastCapacityKey:null,scenarioGeneration:0,scenarioSnapshot:null,scenarioMoves:[],scenarioData:null,scenarioLibrary:null,scenarioSaveKey:null,scenarioSelectKeys:{},scenarioApplyKeys:{},scenarioRollbackKeys:{}};
const panels = ["dashboard","tasks","pages","records","schema","history","workflows","preview"];
const names = {dashboard:"Обзор",tasks:"Задачи",pages:"Страницы",records:"Данные",schema:"Модели и формы",history:"Версии и откат",workflows:"Автоматизация",preview:"Предпросмотр"};
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
  if(name==="records" && state.spec)refreshBatchHistory().catch(e=>show(e.message,true));
  if(name==="tasks" && state.spec)refreshTasks().catch(e=>show(e.message,true));
  if(name==="tasks" && state.spec)refreshTaskCalendar().catch(e=>show(e.message,true));
  if(name==="tasks" && can("task.manage"))refreshDelivery().catch(e=>show(e.message,true));
  if(name==="tasks" && can("task.manage"))refreshResourceForecast().catch(e=>show(e.message,true));
  if(name==="tasks" && can("task.manage"))refreshScenarioWorkload().catch(e=>show(e.message,true));
  if(name==="tasks" && can("task.manage"))
    refreshTeamWorkload().catch(e=>show(e.message,true));
  if(name==="dashboard" && state.spec)refreshTaskSummary().catch(e=>show(e.message,true));
}
document.querySelectorAll(".nav-link").forEach(b=>b.addEventListener("click",()=>switchPanel(b.dataset.panel)));
async function sync(){
  const [me,result,workflows]=await Promise.all([
    api("/api/v1/me"),api("/api/v1/spec"),api("/api/v1/workflows")]);
  state.me=me;state.spec=result.spec;state.revision=result.revision;
  state.csvPending=null;state.csvRetryKey=null;state.rowOffset=0;
  state.batchSelection.clear();clearBatchPlan(true);
  state.restorePlan=null;
  clearMapPlan(true);
  $("history-plan").hidden=true;
  $("history-empty").hidden=false;
  $("history-approve").checked=false;
  $("history-apply").disabled=true;
  state.workflows=workflows.workflows;
  $("role-pill").textContent="Роль: "+me.role;
  $("tasks-nav").hidden=!can("task.read");
  $("task-form").hidden=!can("task.manage");
  $("team-workload-panel").hidden=!can("task.manage");
  $("delivery-panel").hidden=!can("task.manage");
  $("resource-forecast-panel").hidden=!can("task.manage");
  $("scenario-panel").hidden=!can("task.manage");
  $("task-assignee-filter-wrap").hidden=!can("task.manage");
  $("task-checklist-form").hidden=!can("task.manage");
  $("task-refresh").disabled=!can("task.read");
  $("team-kpis").hidden=!can("task.read");
  state.taskEditing=null;state.taskOffset=0;state.taskPendingKey=null;
  if(can("task.manage"))await loadTaskMembers();
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
  if(can("task.read"))await refreshTaskSummary();
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
const TASK_STATUS={todo:"Ожидает",in_progress:"В работе",
  blocked:"Заблокирована",done:"Выполнена"};
const TASK_PRIORITY={low:"Низкий",normal:"Обычный",high:"Высокий",urgent:"Критический"};
const TASK_TRANSITIONS={
  todo:["in_progress","blocked"],in_progress:["blocked","done"],
  blocked:["in_progress"],done:[]};
async function loadTaskMembers(){
  if(!can("task.manage"))return;
  const reply=await api("/api/v1/tasks/members");
  state.taskMembers=reply.members;
  pick($("task-assignee"),[["","Не назначено"],
    ...state.taskMembers.map(m=>[m.actor,m.actor+" · "+m.role])]);
  pick($("task-assignee-filter"),[["","Любой"],["__unassigned__","Без исполнителя"],
    ...state.taskMembers.map(m=>[m.actor,m.actor+" · "+m.role])]);
}
function resetTaskForm(){
  state.taskEditing=null;state.taskPendingKey=null;
  $("task-form").reset();
  $("task-form-title").textContent="Новая задача";
  $("task-save").textContent="Создать задачу";
  $("task-priority").value="normal";
}
async function refreshTaskSummary(){
  if(!can("task.read"))return;
  const result=await api("/api/v1/tasks/summary");
  const m=result.metrics;
  $("metric-tasks-open").textContent=m.total-m.done;
  $("metric-tasks-overdue").textContent=m.overdue;
  $("metric-tasks-blocked").textContent=m.blocked;
  $("metric-tasks-done").textContent=m.done;
  $("tasks-total").textContent=m.total;
  $("tasks-progress").textContent=m.in_progress;
  $("tasks-overdue").textContent=m.overdue;
  $("tasks-done").textContent=m.done;
}
async function refreshTasks({resetOffset=false}={}){
  if(!can("task.read"))return;
  if(resetOffset)state.taskOffset=0;
  const sequence=++state.taskGeneration;
  const status=$("task-status-filter").value||null;
  const due=$("task-due-filter").value||null;
  const assignee=can("task.manage")?($("task-assignee-filter").value||null):null;
  const result=await api("/api/v1/tasks/query",{
    method:"POST",body:{limit:25,offset:state.taskOffset,status,due,assignee}});
  if(sequence!==state.taskGeneration)return;
  state.tasks=result.tasks;
  $("task-count").textContent=result.total===0?"Задач пока нет":
    "Задачи "+(result.offset+1)+"–"+(result.offset+result.tasks.length)+
    " из "+result.total+" · "+(result.scope==="all"?"Вся команда":"Мои поручения");
  $("task-prev").disabled=result.offset===0;
  $("task-next").disabled=!result.has_more;
  renderTaskList();
  await refreshTaskSummary();
  if(can("task.manage"))await refreshTeamWorkload();
  await refreshTaskCalendar();
  if(can("task.manage"))await refreshResourceForecast();
  if(can("task.manage"))await refreshScenarioWorkload();
}
const SCENARIO_LIBRARY_STATUS={
  draft:"Черновик",approved:"Выбран владельцем",
  superseded:"Выбор отменён",applied:"Применён к задачам",
  rolled_back:"Назначения возвращены",
};
function renderSavedScenarios(){
  const root=$("scenario-library-list");root.replaceChildren();
  const data=state.scenarioLibrary;
  if(!data)return;
  const variants=data.variants;
  $("scenario-library-summary").textContent="Сохранено вариантов: "+variants.length+
    " / 50 · выбрать и применить может только владелец проекта.";
  const isOwner=state.me?.role==="owner";
  if(!variants.length)root.append(node("p","Вариантов пока нет. Добавьте перестановки и сохраните сценарий.","hint"));
  for(const item of variants){
    const card=node("article",null,"scenario-saved-card");
    card.dataset.status=item.effective_status||item.status;
    card.dataset.current=String(item.snapshot_current);
    card.dataset.id=item.scenario_id;
    const top=node("div",null,"scenario-saved-header");
    top.append(node("strong",item.title),
      node("span",SCENARIO_LIBRARY_STATUS[item.effective_status]||
        SCENARIO_LIBRARY_STATUS[item.status]||item.status,"scenario-saved-status"));
    card.append(top);
    card.append(node("p",item.move_count+" перестановок · версия "+item.version+
      " · "+(item.snapshot_current?"Данные актуальны":"Исходные данные изменились"),
      "scenario-saved-subtitle"));
    const stats=node("div",null,"scenario-saved-metrics");
    const original=item.preview.baseline.metrics;
    const alternative=item.preview.scenario.metrics;
    for(const [label,before,after] of [
      ["Задачи с риском",original.at_risk_tasks,alternative.at_risk_tasks],
      ["Перегрузка",original.overloaded_workers,alternative.overloaded_workers],
      ["Расчётная дата",original.potential_finish||"неизвестна",
                        alternative.potential_finish||"неизвестна"]]){
      stats.append(node("p",label+": "+before+" → "+after));
    }
    card.append(stats);
    const actions=node("div",null,"scenario-saved-actions");
    const history=node("button","История","ghost");
    history.type="button";
    history.addEventListener("click",async()=>{
      try{
        const data=await api("/api/v1/scenarios/saved/"+
          encodeURIComponent(item.scenario_id)+"/history",{
            method:"POST",body:{limit:50}});
        const target=$("scenario-decision-list");target.replaceChildren();
        for(const e of data.events){
          const action={SAVE:"Сохранение",APPROVE:"Выбор владельцем",
            SUPERSEDE:"Отмена выбора",APPLY:"Применение",
            ROLLBACK:"Откат назначения"}[e.action]||e.action;
          const line=node("div",null,"scenario-decision-entry");
          line.append(node("strong",action),
            node("small","Автор: "+e.actor+" · версия "+e.version+" · "+
              new Date(e.at_epoch*1000).toLocaleString("ru-RU")),
            node("small","Проверка SHA-256: "+e.sha256.slice(0,20)+"…"));
          target.append(line);
        }
        $("scenario-decision-history").hidden=false;
      }catch(e){show(e.message,true);}
    });
    actions.append(history);
    if(item.status==="applied"){
      const outcome=node("button","Фактический результат","ghost");
      outcome.type="button";
      outcome.addEventListener("click",()=>
        showScenarioOutcome(item.scenario_id).catch(e=>show(e.message,true)));
      actions.append(outcome);
    }
    if(isOwner && item.snapshot_current &&
        (item.status==="draft"||item.status==="superseded")){
      const choose=node("button","Выбрать этот вариант","ghost");
      choose.type="button";
      choose.addEventListener("click",async()=>{
        choose.disabled=true;
        try{
          const key=state.scenarioSelectKeys[item.scenario_id]||safeId();
          state.scenarioSelectKeys[item.scenario_id]=key;
          await api("/api/v1/scenarios/saved/"+encodeURIComponent(item.scenario_id)+
            "/select",{method:"POST",body:{
              expected_version:item.version,expected_snapshot:item.input_snapshot,
              idempotency_key:key}});
          delete state.scenarioSelectKeys[item.scenario_id];
          await refreshScenarioWorkload();
          show("Вариант выбран владельцем. Реальные назначения ещё не менялись");
        }catch(e){show(e.message,true);}
        finally{choose.disabled=false;}
      });
      actions.append(choose);
    }
    if(isOwner && item.status==="approved"){
      const guard=node("div",null,"scenario-apply-guard");
      const warning=node("p","Подтвердите применение. Все указанные "+
        "задачи будут реально переназначены одним действием.","hint");
      const checkbox=node("input");
      checkbox.type="checkbox";
      checkbox.setAttribute("aria-label","Подтверждаю переназначение задач");
      const label=node("label","Я проверил исполнителей и последствия");
      label.prepend(checkbox);
      const input=node("input");
      input.type="text";input.placeholder="Введите ПРИМЕНИТЬ";
      input.setAttribute("aria-label","Введите ПРИМЕНИТЬ");
      input.autocomplete="off";
      const apply=node("button","Применить выбранный план","primary");
      apply.type="button";
      const enabled=()=>{apply.disabled=!(checkbox.checked&&input.value==="ПРИМЕНИТЬ"&&
        item.snapshot_current);};
      checkbox.addEventListener("change",enabled);
      input.addEventListener("input",enabled);
      enabled();
      apply.addEventListener("click",async()=>{
        if(!checkbox.checked||input.value!=="ПРИМЕНИТЬ")return;
        apply.disabled=true;
        try{
          const key=state.scenarioApplyKeys[item.scenario_id]||safeId();
          state.scenarioApplyKeys[item.scenario_id]=key;
          const result=await api("/api/v1/scenarios/saved/"+
            encodeURIComponent(item.scenario_id)+"/apply",{
              method:"POST",body:{
                expected_version:item.version,
                expected_snapshot:item.input_snapshot,
                confirmation:"ПРИМЕНИТЬ",
                idempotency_key:key}});
          delete state.scenarioApplyKeys[item.scenario_id];
          await refreshTasks();
          await refreshResourceForecast();
          await refreshScenarioWorkload();
          show("Реально переназначено задач: "+result.applied_count+
            ". Изменения сохранены атомарно и записаны в журнал");
        }catch(e){show(e.message,true);}
        finally{apply.disabled=false;enabled();}
      });
      guard.append(warning,label,input,apply);
      card.append(guard);
    }
    card.append(actions);root.append(card);
  }
}
$("scenario-library-refresh").addEventListener("click",()=>
  refreshScenarioWorkload().catch(e=>show(e.message,true)));
$("scenario-decision-close").addEventListener("click",()=>{
  $("scenario-decision-history").hidden=true;
});
const OUTCOME_METRICS={
  open_tasks:"Открытые задачи",
  scheduled_tasks:"Задачи с прогнозом",
  unforecastable_tasks:"Задачи без прогноза",
  at_risk_tasks:"Риски по сроку",
  at_risk_milestones:"Риски вех",
  potential_finish:"Расчётная дата",
  coverage_complete:"Полнота расчёта",
  overloaded_workers:"Перегруженные сотрудники",
  unknown_load_workers:"Неизвестная нагрузка",
};
function fmtOutcomeMetric(v){
  if(v===null||v===undefined)return "Неизвестно";
  if(typeof v==="boolean")return v?"Да":"Нет";
  return String(v);
}
async function showScenarioOutcome(scenarioId){
  const data=await api("/api/v1/scenarios/saved/"+
    encodeURIComponent(scenarioId)+"/outcome");
  const root=$("scenario-outcome-body");root.replaceChildren();
  const application=data.application;
  if(!application){
    root.append(node("p","Для этого применения нет подписанного журнала "+
      "исходных назначений (более ранняя версия). Автоматический откат "+
      "заблокирован, чтобы не восстановить неверного исполнителя.","hint"));
    $("scenario-outcome-report").hidden=false;
    return;
  }
  const summary=node("div",null,"scenario-outcome-summary");
  const heading=node("p",
    "Применено "+new Date(application.at_epoch*1000).toLocaleString("ru-RU")+
    " · задач: "+application.task_changes.length,"hint");
  root.append(heading);
  for(const [key,label] of Object.entries(OUTCOME_METRICS)){
    const item=node("div",null,"scenario-outcome-metric");
    item.append(node("span",label),node("strong",
      fmtOutcomeMetric(application.metrics_before[key])+" → "+
      fmtOutcomeMetric(application.metrics_after[key])));
    summary.append(item);
  }
  root.append(summary);
  root.append(node("h4","Фактические назначения"));
  const assignments=node("div",null,"scenario-outcome-assignments");
  for(const change of application.task_changes){
    const entry=node("div",null,"scenario-outcome-assignment");
    entry.append(node("strong","Задача "+change.task_id.slice(0,8)),
      node("span",(change.before_assignee||"Без исполнителя")+
        " → "+change.after_assignee),
      node("small","Версия "+change.version_before+
        " → "+change.version_after));
    assignments.append(entry);
  }
  root.append(assignments);
  root.append(node("p","Журнал SHA-256: "+application.sha256,"hint"));
  if(data.rollback){
    const complete=node("div",null,"scenario-outcome-returned");
    complete.append(node("strong","Назначения возвращены владельцем"),
      node("small","Время: "+new Date(data.rollback.at_epoch*1000).toLocaleString("ru-RU")+
        " · проверка SHA-256: "+data.rollback.sha256),
      node("small","Отмена изменила версии задач — история выполненных операций сохранена."));
    root.append(complete);
  }else{
    const box=node("div",null,"scenario-outcome-live");
    box.append(node("strong",data.changed_since_application?
      "После применения исходные данные менялись":
      "Текущие исходные данные совпадают с применённым вариантом"));
    box.append(node("small","Дата последнего снимка: "+
      data.current_snapshot.slice(0,16)+"…"));
    root.append(box);
    if(state.me?.role==="owner" && data.rollback_ready){
      const guard=node("div",null,"scenario-rollback-guard");
      guard.append(node("p","Откат вернёт прежних исполнителей только для "+
        application.task_changes.length+
        " задач из этого плана. Операция необратимо запишется в историю.","hint"));
      const agree=node("input");agree.type="checkbox";
      agree.setAttribute("aria-label","Проверил исходные назначения перед откатом");
      const label=node("label","Проверил исходных исполнителей и подтверждаю откат");
      label.prepend(agree);
      const phrase=node("input");phrase.type="text";
      phrase.placeholder="Введите ОТКАТИТЬ";
      phrase.setAttribute("aria-label","Введите ОТКАТИТЬ");
      phrase.autocomplete="off";
      const button=node("button","Вернуть предыдущие назначения","primary");
      button.type="button";
      const gate=()=>{button.disabled=!(agree.checked&&phrase.value==="ОТКАТИТЬ");};
      agree.addEventListener("change",gate);phrase.addEventListener("input",gate);
      gate();
      button.addEventListener("click",async()=>{
        if(!agree.checked||phrase.value!=="ОТКАТИТЬ")return;
        button.disabled=true;
        try{
          const key=state.scenarioRollbackKeys[scenarioId]||safeId();
          state.scenarioRollbackKeys[scenarioId]=key;
          const receipt=await api("/api/v1/scenarios/saved/"+
            encodeURIComponent(scenarioId)+"/rollback",{
              method:"POST",body:{
                expected_version:data.scenario_version,
                expected_snapshot:data.current_snapshot,
                confirmation:"ОТКАТИТЬ",idempotency_key:key,
              }});
          delete state.scenarioRollbackKeys[scenarioId];
          await refreshTasks();await refreshResourceForecast();
          await refreshScenarioWorkload();
          await showScenarioOutcome(scenarioId);
          show("Атомарно возвращено назначений: "+receipt.reverted_count+
            ". История изменений сохранена.");
        }catch(e){show(e.message,true);}
        finally{button.disabled=false;gate();}
      });
      guard.append(label,phrase,button);
      root.append(guard);
    }else if(state.me?.role==="owner"){
      root.append(node("p","Автоматический откат сейчас запрещён: задачи "+
        "менялись после применения или прежний исполнитель недоступен. "+
        "Изменения не внесены.","hint"));
    }
  }
  $("scenario-outcome-report").hidden=false;
}
$("scenario-outcome-close").addEventListener("click",()=>{
  $("scenario-outcome-report").hidden=true;
});
$("scenario-save-title").addEventListener("input",()=>{
  state.scenarioSaveKey=null;
});
$("scenario-save-form").addEventListener("submit",async e=>{
  e.preventDefault();
  if(!state.scenarioMoves.length||!state.scenarioSnapshot){
    show("Сначала добавьте хотя бы одну виртуальную перестановку",true);return;
  }
  const button=$("scenario-save");
  button.disabled=true;
  try{
    const key=state.scenarioSaveKey||safeId();
    state.scenarioSaveKey=key;
    await api("/api/v1/scenarios/saved",{method:"POST",body:{
      title:$("scenario-save-title").value.trim(),
      expected_snapshot:state.scenarioSnapshot,
      moves:state.scenarioMoves,idempotency_key:key}});
    state.scenarioSaveKey=null;
    $("scenario-save-form").reset();
    await refreshScenarioWorkload();
    show("Вариант сохранён. Для изменения реальных задач нужен выбор владельца и подтверждение");
  }catch(e){show(e.message,true);}
  finally{button.disabled=false;}
});

const SCENARIO_WINDOW=10;
function renderScenarioMoves(){
  const root=$("scenario-moves");root.replaceChildren();
  if(!state.scenarioMoves.length){
    root.append(node("p","Сценарий пуст. Выберите задачу и другого сотрудника.","hint"));
  }
  for(const move of state.scenarioMoves){
    const task=state.scenarioData?.forecast.tasks.find(x=>x.task_id===move.task_id);
    const row=node("div",null,"scenario-move");
    row.append(node("span",(task?.title||move.task_id.slice(0,8))+
      " · "+(task?.assignee||"Без исполнителя")+" → "+move.assignee));
    const remove=node("button","Убрать","ghost");
    remove.type="button";
    remove.addEventListener("click",()=>{
      state.scenarioMoves=state.scenarioMoves.filter(x=>x.task_id!==move.task_id);
      $("scenario-results").hidden=true;renderScenarioMoves();
    });
    row.append(remove);root.append(row);
  }
  $("scenario-compare").disabled=!state.scenarioMoves.length;
}
async function refreshScenarioWorkload(){
  if(!can("task.manage"))return;
  const seq=++state.scenarioGeneration;
  const [view,members,forecast,library]=await Promise.all([
    api("/api/v1/scenarios/workload"),
    api("/api/v1/tasks/members"),
    api("/api/v1/forecast"),
    api("/api/v1/scenarios/saved"),
  ]);
  if(seq!==state.scenarioGeneration)return;
  if(state.scenarioSnapshot!==view.input_snapshot){
    state.scenarioMoves=[];
    $("scenario-results").hidden=true;
  }
  state.scenarioSnapshot=view.input_snapshot;
  $("scenario-panel").dataset.sourceSnapshot=view.input_snapshot;
  state.scenarioData={workload:view,members:members.members,forecast};
  state.scenarioLibrary=library;
  const m=view.metrics;
  $("scenario-overloaded").textContent=m.overloaded_workers;
  $("scenario-unknown").textContent=m.unknown_load_workers;
  $("scenario-late").textContent=m.at_risk_tasks;
  $("scenario-coverage").textContent=m.coverage_complete?"Полная":"Недостаточно данных";
  const root=$("scenario-worker-list");root.replaceChildren();
  if(!view.workers.length)root.append(node("p","Пока нет назначенных задач.","hint"));
  for(const worker of view.workers){
    const card=node("article",null,"scenario-worker");
    card.dataset.overload=String(worker.overloaded_10d);
    card.append(node("strong",worker.worker));
    const value=node("div",null,"scenario-worker-stats");
    value.append(node("small","Открытых задач: "+worker.open_tasks));
    value.append(node("small","Оценено часов: "+worker.estimated_hours+
      (worker.unknown_estimates?" · без оценки: "+worker.unknown_estimates:"")));
    value.append(node("small",worker.hours_per_day?
      "Мощность: "+worker.hours_per_day+" ч/день":"Мощность не указана"));
    value.append(node("small",worker.backlog_pressure_10d_percent!==null?
      "Нагрузка запаса на 10 дней: "+worker.backlog_pressure_10d_percent+"%":
      "Невозможно оценить загрузку"));
    if(worker.overloaded_10d===true){
      value.append(node("small","Запас работы больше 10-дневной мощности"));
    }
    if(worker.late_tasks)value.append(node("small",
      "Ожидаются задержки: "+worker.late_tasks));
    card.append(value);root.append(card);
  }
  const taskSelect=$("scenario-task");
  const selectedTask=taskSelect.value;
  const open=forecast.tasks.filter(x=>x.status!=="done");
  pick(taskSelect,[["","Выберите открытую задачу"],
    ...open.slice(0,100).map(x=>[x.task_id,x.title])]);
  if(open.some(x=>x.task_id===selectedTask))taskSelect.value=selectedTask;
  const workerSelect=$("scenario-worker");
  const selectedWorker=workerSelect.value;
  pick(workerSelect,[["","Выберите сотрудника"],
    ...members.members.map(x=>[x.actor,x.actor+" · "+x.role])]);
  if(members.members.some(x=>x.actor===selectedWorker))workerSelect.value=selectedWorker;
  renderScenarioMoves();
  renderSavedScenarios();
}
$("scenario-refresh").addEventListener("click",()=>
  refreshScenarioWorkload().catch(e=>show(e.message,true)));
$("scenario-add").addEventListener("click",()=>{
  if(!state.scenarioData)return;
  const task_id=$("scenario-task").value;
  const assignee=$("scenario-worker").value;
  const task=state.scenarioData.forecast.tasks.find(x=>x.task_id===task_id);
  if(!task||!assignee){show("Выберите задачу и сотрудника",true);return;}
  if(task.assignee===assignee){show("Выберите другого исполнителя",true);return;}
  const without=state.scenarioMoves.filter(x=>x.task_id!==task_id);
  if(without.length>=20){show("Не более 20 изменений за раз",true);return;}
  state.scenarioMoves=[...without,{task_id,assignee}];
  $("scenario-results").hidden=true;
  renderScenarioMoves();show("Перестановка добавлена только в сценарий");
});
$("scenario-clear").addEventListener("click",()=>{
  state.scenarioMoves=[];$("scenario-results").hidden=true;
  renderScenarioMoves();show("Сценарий очищен. Настоящие задачи не менялись");
});
function scenarioMetricCard(label,value){
  const card=node("div",null,"scenario-metric");
  card.append(node("span",label),node("strong",String(value)));
  return card;
}
function renderScenarioComparison(result){
  const baseline=result.baseline.metrics,scenario=result.scenario.metrics;
  const wrapper=$("scenario-comparison");wrapper.replaceChildren();
  const formatFinish=m=>m.coverage_complete&&m.potential_finish?
    m.potential_finish:"Неполный прогноз";
  for(const [title,metrics] of [["Текущий план",baseline],["Альтернатива",scenario]]){
    const card=node("article",null,"scenario-variant");
    card.append(node("h4",title));
    card.append(scenarioMetricCard("Расчётная дата",formatFinish(metrics)));
    card.append(scenarioMetricCard("Задач с риском",metrics.at_risk_tasks));
    card.append(scenarioMetricCard("Перегружены (10 дней)",metrics.overloaded_workers));
    card.append(scenarioMetricCard("Открытых без прогноза",metrics.unforecastable_tasks));
    wrapper.append(card);
  }
  const delta=result.comparison.finish_delta_calendar_days;
  const assessment=node("p",delta===null?
    "Сравнение общей даты невозможно: один или оба варианта имеют неполные исходные данные.":
    (delta===0?"Расчётная дата завершения не меняется.":
     delta<0?"Альтернатива раньше на "+Math.abs(delta)+" календарных дней.":
     "Альтернатива позже на "+delta+" календарных дней."),"scenario-assessment");
  wrapper.append(assessment);
  const changes=$("scenario-changes");changes.replaceChildren();
  for(const item of result.moves){
    changes.append(node("div",item.title+": "+(item.old_assignee||"Без исполнителя")+
      " → "+item.new_assignee+" · "+(item.before_finish||"дата неизвестна")+
      " / "+(item.after_finish||"дата неизвестна"),"scenario-diff-row"));
  }
  $("scenario-results").hidden=false;
}
$("scenario-compare").addEventListener("click",async()=>{
  if(!state.scenarioMoves.length||!state.scenarioSnapshot)return;
  const button=$("scenario-compare");button.disabled=true;
  try{
    const payload={expected_snapshot:state.scenarioSnapshot,
      moves:state.scenarioMoves};
    const result=await api("/api/v1/scenarios/compare",{method:"POST",body:payload});
    if(result.input_snapshot!==state.scenarioSnapshot)return;
    renderScenarioComparison(result);
    show("Сценарии сравнены. Реальные назначения в SQLite не менялись");
  }catch(e){
    show(e.message,true);
    await refreshScenarioWorkload().catch(()=>{});
  }finally{button.disabled=false;}
});

const FORECAST_STATES={
  scheduled:"Расчёт выполнен",
  completed:"Завершена",
  unassigned:"Нет исполнителя",
  inactive_assignee:"Исполнитель неактивен",
  capacity_missing:"Не указаны часы исполнителя",
  incomplete_assignee_inputs:"Не все задачи сотрудника оценены",
  effort_missing:"Нет оценки работы",
  blocked_status:"Задача заблокирована",
  prerequisite_unforecastable:"Неизвестен срок предшественника",
  beyond_2_year_horizon:"Вне горизонта 730 дней",
  unforecastable:"Недостаточно данных",
};
async function refreshResourceForecast(){
  if(!can("task.manage"))return;
  const seq=++state.forecastGeneration;
  const [data,members]=await Promise.all([
    api("/api/v1/forecast"),api("/api/v1/tasks/members")
  ]);
  if(seq!==state.forecastGeneration)return;
  state.forecastData=data;
  const m=data.metrics;
  $("forecast-scheduled").textContent=m.scheduled_tasks+" / "+m.open_tasks;
  $("forecast-unknown").textContent=m.unforecastable_tasks;
  $("forecast-risk").textContent=m.at_risk_tasks+" задач · "+
    m.at_risk_milestones+" вех";
  $("forecast-finish").textContent=m.potential_finish||"Нет полного прогноза";
  $("forecast-coverage").textContent=m.coverage_complete?
    "Все открытые задачи имеют расчётные даты. Это сценарный прогноз, не гарантия завершения.":
    "Прогноз неполный: "+m.unforecastable_tasks+
    " задач без расчётной даты. Общую дату завершения выдавать нельзя.";
  const workerSelect=$("forecast-worker");
  const selectedWorker=workerSelect.value;
  pick(workerSelect,[["","Выберите сотрудника"],
    ...members.members.map(x=>[x.actor,x.actor+" · "+x.role])]);
  if(members.members.some(x=>x.actor===selectedWorker))workerSelect.value=selectedWorker;
  const taskSelect=$("forecast-task");
  const selectedTask=taskSelect.value;
  const incomplete=data.tasks.filter(x=>x.status!=="done");
  pick(taskSelect,[["","Выберите задачу"],
    ...incomplete.slice(0,100).map(x=>[x.task_id,x.title])]);
  if(incomplete.slice(0,100).some(x=>x.task_id===selectedTask)){
    taskSelect.value=selectedTask;
  }
  const list=$("forecast-task-list");list.replaceChildren();
  if(!incomplete.length)list.append(node("p","Открытых задач нет.","hint"));
  for(const task of incomplete.slice(0,100)){
    const card=node("article",null,"forecast-task");
    card.dataset.state=task.state;
    const top=node("div",null,"task-item-head");
    top.append(node("strong",task.title),
      node("span",FORECAST_STATES[task.state]||"Неизвестно","forecast-state"));
    card.append(top);
    const stats=node("div",null,"forecast-task-meta");
    stats.append(
      node("small",task.assignee?"Исполнитель: "+task.assignee:"Без исполнителя"),
      node("small",task.effort_hours?"Осталось: "+task.effort_hours+" ч":"Нет оценки"),
      node("small",task.due_date?"План: "+task.due_date:"Срок не назначен"),
      node("small",task.estimated_finish?"Расчёт: "+task.estimated_finish:"Расчётной даты нет"));
    if(task.variance_calendar_days!==null){
      stats.append(node("small","Отклонение от срока: "+
        (task.variance_calendar_days>0?"+":"")+task.variance_calendar_days+" дн."));
    }
    card.append(stats);
    list.append(card);
  }
  if(incomplete.length>100)list.append(node("p","Показаны первые 100 задач, расчёт включает весь проект.","hint"));
  const exposure=$("forecast-milestone-list");exposure.replaceChildren();
  if(data.milestone_exposure.length){
    exposure.append(node("h3","Риски контрольных вех"));
    for(const item of data.milestone_exposure.slice(0,100)){
      const row=node("div",null,"forecast-milestone");
      row.append(node("strong",item.name),
        node("small",item.state==="potential_slip"?
          "Риск сдвига на "+item.potential_slip_days+" дн. от прогноза":
          item.state==="ready_for_confirmation"?"Задача готова, веха ждёт подтверждения":
          item.state==="within_forecast"?"Укладывается в текущий прогноз":
          "Не хватает данных для расчёта вехи"));
      exposure.append(row);
    }
  }
}
function forecastSelectedVersion(kind,id){
  const data=state.forecastData;
  if(!data)return 0;
  const items=kind==="capacity"?data.capacities:data.efforts;
  const entry=items.find(x=>
    (kind==="capacity"?x.worker:x.task_id)===id);
  return entry?entry.version:0;
}
$("forecast-worker").addEventListener("change",()=>{
  state.forecastCapacityKey=null;
  const id=$("forecast-worker").value;
  const entry=state.forecastData?.capacities.find(x=>x.worker===id);
  $("forecast-hours-per-day").value=entry?String(entry.hours_per_day):"";
});
$("forecast-task").addEventListener("change",()=>{
  state.forecastEffortKey=null;
  const id=$("forecast-task").value;
  const entry=state.forecastData?.efforts.find(x=>x.task_id===id);
  $("forecast-effort-hours").value=entry?String(entry.effort_hours):"";
});
$("forecast-capacity-form").addEventListener("input",()=>{state.forecastCapacityKey=null;});
$("forecast-effort-form").addEventListener("input",()=>{state.forecastEffortKey=null;});
$("forecast-capacity-form").addEventListener("submit",async event=>{
  event.preventDefault();
  if(!can("task.manage"))return;
  const button=$("forecast-capacity-save");button.disabled=true;
  try{
    const worker=$("forecast-worker").value;
    const key=state.forecastCapacityKey||safeId();
    state.forecastCapacityKey=key;
    await api("/api/v1/forecast/capacity",{method:"POST",body:{
      worker,hours_per_day:Number($("forecast-hours-per-day").value),
      expected_version:forecastSelectedVersion("capacity",worker),
      idempotency_key:key}});
    state.forecastCapacityKey=null;
    await refreshResourceForecast();
    await refreshScenarioWorkload();
    show("Реальная мощность сотрудника сохранена с контролем версии");
  }catch(e){show(e.message,true);}
  finally{button.disabled=false;}
});
$("forecast-effort-form").addEventListener("submit",async event=>{
  event.preventDefault();
  if(!can("task.manage"))return;
  const button=$("forecast-effort-save");button.disabled=true;
  try{
    const task_id=$("forecast-task").value;
    const key=state.forecastEffortKey||safeId();
    state.forecastEffortKey=key;
    await api("/api/v1/forecast/effort",{method:"POST",body:{
      task_id,effort_hours:Number($("forecast-effort-hours").value),
      expected_version:forecastSelectedVersion("effort",task_id),
      idempotency_key:key}});
    state.forecastEffortKey=null;
    await refreshResourceForecast();
    await refreshScenarioWorkload();
    show("Оценка работы сохранена; прогноз пересчитан");
  }catch(e){show(e.message,true);}
  finally{button.disabled=false;}
});
$("forecast-refresh").addEventListener("click",()=>
  refreshResourceForecast().catch(e=>show(e.message,true)));
$("forecast-audit-open").addEventListener("click",async()=>{
  try{
    const result=await api("/api/v1/forecast/history",{
      method:"POST",body:{limit:30}});
    const list=$("forecast-history-list");list.replaceChildren();
    if(!result.events.length)list.append(node("p","Изменений пока нет.","hint"));
    for(const item of result.events){
      const row=node("div",null,"forecast-audit-item");
      row.append(node("strong",item.subject_type==="capacity"?
        "Мощность: "+item.subject_id:"Оценка задачи: "+item.subject_id.slice(0,8)),
        node("small","Версия "+item.version+" · "+item.actor+" · "+
          new Date(item.at_epoch*1000).toLocaleString("ru-RU")),
        node("small","SHA-256: "+item.sha256.slice(0,20)+"…"));
      list.append(row);
    }
    $("forecast-history-panel").hidden=false;
  }catch(e){show(e.message,true);}
});
$("forecast-audit-close").addEventListener("click",()=>{
  $("forecast-history-panel").hidden=true;
});

const DELIVERY_RISK={
  completed:"Выполнено",completed_late:"Выполнено с опозданием",
  overdue:"Просрочено",slipped:"Прогноз сдвинут",on_track:"По плану",
};
const DELIVERY_PHASE_STATUS={
  completed:"Все вехи завершены",overdue:"Этап просрочен",
  active:"В процессе",unplanned:"Нет контрольных вех",
};
function dateInput(value,ariaLabel){
  const input=node("input");
  input.type="date";input.min="2000-01-01";input.max="2100-12-31";
  input.value=value||"";input.required=true;
  input.setAttribute("aria-label",ariaLabel);
  return input;
}
async function refreshDelivery(){
  if(!can("task.manage"))return;
  const serial=++state.deliveryGeneration;
  const [report,tasks]=await Promise.all([
    api("/api/v1/delivery"),
    api("/api/v1/tasks/query",{method:"POST",body:{limit:100,offset:0}}),
  ]);
  if(serial!==state.deliveryGeneration)return;
  state.deliveryData=report;
  $("delivery-phases-count").textContent=report.metrics.phases;
  $("delivery-phases-late").textContent=report.metrics.phases_slipping;
  $("delivery-done").textContent=report.metrics.milestones_done+
    " / "+report.metrics.milestones;
  $("delivery-overdue").textContent=report.metrics.milestones_overdue_open;
  $("delivery-summary").textContent="Базовые сроки неизменяемы · "+report.as_of_utc+
    " UTC · выполнены с опозданием: "+report.metrics.milestones_completed_late+
    " · прогноз сдвинут: "+report.metrics.milestones_forecast_slipping;
  const selected=$("delivery-milestone-phase").value;
  pick($("delivery-milestone-phase"),[["","Выберите этап"],
    ...report.phases.map(p=>[p.phase_id,p.name+" · до "+p.baseline_end])]);
  if(report.phases.some(p=>p.phase_id===selected)){
    $("delivery-milestone-phase").value=selected;
  }else if(report.phases.length){
    $("delivery-milestone-phase").value=report.phases[0].phase_id;
  }
  pick($("delivery-milestone-task"),[["","Без задачи"],
    ...tasks.tasks.map(t=>[t.task_id,t.title+" · "+TASK_STATUS[t.status]])]);
  renderDeliveryPlan(report);
}
function renderDeliveryPlan(report){
  const root=$("delivery-phase-list");root.replaceChildren();
  if(!report.phases.length){
    root.append(node("p","Этапов пока нет. Создайте этап с исходными сроками.","hint"));
    return;
  }
  for(const phase of report.phases){
    const group=node("article",null,"delivery-phase");
    const top=node("div",null,"delivery-phase-heading");
    const left=node("div");
    left.append(node("h3",phase.name),
      node("small","Базовый период: "+phase.baseline_start+" — "+phase.baseline_end));
    top.append(left,node("span",DELIVERY_PHASE_STATUS[phase.status],"delivery-status"));
    group.append(top);
    const metrics=node("div",null,"delivery-phase-meta");
    metrics.append(node("span","Прогноз завершения: "+phase.forecast_end),
      node("span","Выполнено: "+phase.milestones_done+"/"+phase.milestone_count),
      node("span","Отклонение: "+(phase.variance_days>0?"+":"")+
        phase.variance_days+" дн."));
    if(phase.actual_end)metrics.append(node("span","Фактически: "+phase.actual_end));
    group.append(metrics);
    const progress=node("div",null,"delivery-progress");
    progress.setAttribute("role","progressbar");
    progress.setAttribute("aria-valuemin","0");
    progress.setAttribute("aria-valuemax","100");
    progress.setAttribute("aria-valuenow",String(phase.progress_percent));
    progress.setAttribute("aria-label","Выполнено вех этапа "+phase.name);
    const fill=node("div",null,"delivery-progress-fill");
    fill.style.width=phase.progress_percent+"%";progress.append(fill);
    group.append(progress);
    const phaseActions=node("div",null,"delivery-actions");
    const phaseDate=dateInput(phase.forecast_end,"Новый прогноз этапа "+phase.name);
    const savePhase=node("button","Изменить прогноз этапа","ghost");
    savePhase.type="button";
    savePhase.addEventListener("click",async()=>{
      if(phaseDate.value===phase.forecast_end)return;
      savePhase.disabled=true;
      try{
        await api("/api/v1/delivery/phases/"+encodeURIComponent(phase.phase_id)+
          "/forecast",{method:"PATCH",body:{
            expected_version:phase.version,forecast_end:phaseDate.value,
            idempotency_key:safeId()}});
        await refreshDelivery();show("Прогноз этапа сохранён; исходный срок не изменён");
      }catch(e){show(e.message,true);}
      finally{savePhase.disabled=false;}
    });
    phaseActions.append(phaseDate,savePhase);
    const audit=node("button","История этапа","ghost");
    audit.type="button";
    audit.addEventListener("click",()=>
      showDeliveryHistory(phase.phase_id).catch(e=>show(e.message,true)));
    phaseActions.append(audit);group.append(phaseActions);
    const list=node("div",null,"delivery-milestone-list");
    const items=report.milestones.filter(m=>m.phase_id===phase.phase_id);
    if(!items.length)list.append(node("p","В этом этапе ещё нет контрольных вех.","hint"));
    for(const milestone of items){
      const row=node("div",null,"delivery-milestone");
      row.dataset.risk=milestone.risk;
      const label=node("div",null,"delivery-milestone-heading");
      label.append(node("strong",milestone.name),
        node("span",DELIVERY_RISK[milestone.risk],"delivery-risk"));
      row.append(label);
      const dates=node("div",null,"delivery-milestone-dates");
      dates.append(node("small","База: "+milestone.baseline_due),
        node("small","Прогноз: "+milestone.forecast_due));
      if(milestone.completed_on){
        dates.append(node("small","Факт: "+milestone.completed_on));
      }
      dates.append(node("small","Отклонение: "+
        (milestone.variance_days>0?"+":"")+milestone.variance_days+" дн."));
      row.append(dates);
      const actions=node("div",null,"delivery-actions");
      if(!milestone.completed_on){
        const input=dateInput(milestone.forecast_due,
          "Прогноз вехи "+milestone.name);
        const forecast=node("button","Обновить прогноз","ghost");
        forecast.type="button";
        forecast.addEventListener("click",async()=>{
          if(input.value===milestone.forecast_due)return;
          forecast.disabled=true;
          try{
            await api("/api/v1/delivery/milestones/"+encodeURIComponent(
              milestone.milestone_id),{method:"PATCH",body:{
                expected_version:milestone.version,operation:"forecast",
                value:input.value,idempotency_key:safeId()}});
            await refreshDelivery();show("Прогноз вехи обновлён, базовая дата сохранена");
          }catch(e){show(e.message,true);}
          finally{forecast.disabled=false;}
        });
        actions.append(input,forecast);
        const actual=dateInput(new Date().toISOString().slice(0,10),
          "Фактическая дата завершения "+milestone.name);
        const complete=node("button","Подтвердить выполнение","ghost");
        complete.type="button";
        complete.addEventListener("click",async()=>{
          if(!actual.value){show("Укажите дату фактического выполнения",true);return;}
          complete.disabled=true;
          try{
            await api("/api/v1/delivery/milestones/"+encodeURIComponent(
              milestone.milestone_id),{method:"PATCH",body:{
                expected_version:milestone.version,operation:"complete",
                value:actual.value,idempotency_key:safeId()}});
            await refreshDelivery();
            show("Веха завершена; фактическая дата зафиксирована в SQLite");
          }catch(e){show(e.message,true);}
          finally{complete.disabled=false;}
        });
        actions.append(actual,complete);
      }
      const events=node("button","История вехи","ghost");
      events.type="button";
      events.addEventListener("click",()=>
        showDeliveryHistory(milestone.milestone_id).catch(e=>show(e.message,true)));
      actions.append(events);
      row.append(actions);list.append(row);
    }
    group.append(list);root.append(group);
  }
}
async function showDeliveryHistory(id){
  const response=await api("/api/v1/delivery/"+encodeURIComponent(id)+"/history",{
    method:"POST",body:{limit:30}});
  const list=$("delivery-history-list");list.replaceChildren();
  if(!response.events.length)list.append(node("p","Изменений пока нет.","hint"));
  for(const entry of response.events){
    const row=node("div",null,"delivery-audit-row");
    row.append(node("strong",entry.operation==="CREATE"?"Создание":
      entry.operation==="COMPLETE"?"Выполнение":"Изменение прогноза"),
      node("small",entry.actor+" · версия "+entry.version+" · "+
        new Date(entry.at_epoch*1000).toLocaleString("ru-RU")),
      node("small","SHA-256: "+entry.sha256.slice(0,18)+"…"));
    list.append(row);
  }
  $("delivery-history-panel").hidden=false;
}
$("delivery-history-close").addEventListener("click",()=>{
  $("delivery-history-panel").hidden=true;
});
$("delivery-refresh").addEventListener("click",()=>{
  refreshDelivery().catch(e=>show(e.message,true));
});
$("delivery-phase-form").addEventListener("input",()=>{state.deliveryPhaseKey=null;});
$("delivery-phase-form").addEventListener("submit",async event=>{
  event.preventDefault();
  if(!can("task.manage"))return;
  const button=$("delivery-phase-create");button.disabled=true;
  try{
    const key=state.deliveryPhaseKey||safeId();
    state.deliveryPhaseKey=key;
    await api("/api/v1/delivery/phases",{method:"POST",body:{
      name:$("delivery-phase-name").value.trim(),
      baseline_start:$("delivery-phase-start").value,
      baseline_end:$("delivery-phase-end").value,idempotency_key:key}});
    state.deliveryPhaseKey=null;
    $("delivery-phase-form").reset();
    await refreshDelivery();show("Этап записан в SQLite с неизменяемыми базовыми датами");
  }catch(e){show(e.message,true);}
  finally{button.disabled=false;}
});
$("delivery-milestone-form").addEventListener("input",()=>{
  state.deliveryMilestoneKey=null;
});
$("delivery-milestone-form").addEventListener("change",()=>{
  state.deliveryMilestoneKey=null;
});
$("delivery-milestone-form").addEventListener("submit",async event=>{
  event.preventDefault();
  if(!can("task.manage"))return;
  const button=$("delivery-milestone-create");button.disabled=true;
  try{
    const key=state.deliveryMilestoneKey||safeId();
    state.deliveryMilestoneKey=key;
    await api("/api/v1/delivery/phases/"+
      encodeURIComponent($("delivery-milestone-phase").value)+
      "/milestones",{method:"POST",body:{
      name:$("delivery-milestone-name").value.trim(),
      baseline_due:$("delivery-milestone-due").value,
      linked_task_id:$("delivery-milestone-task").value||null,
      idempotency_key:key}});
    state.deliveryMilestoneKey=null;
    $("delivery-milestone-form").reset();
    await refreshDelivery();show("Контрольная веха добавлена в реальный план");
  }catch(e){show(e.message,true);}
  finally{button.disabled=false;}
});

const TASK_CALENDAR_RISK={
  overdue:"Просрочена",blocked:"Ожидает предшественников",
  urgent:"Критический срок",normal:"По графику",
};
async function refreshTaskCalendar(){
  if(!can("task.read"))return;
  const seq=++state.calendarGeneration;
  const body={
    days:Number($("task-calendar-days").value),
    include_overdue:$("task-calendar-overdue").checked,
  };
  if($("task-calendar-start").value)body.start_date=$("task-calendar-start").value;
  const report=await api("/api/v1/tasks/calendar",{method:"POST",body});
  if(seq!==state.calendarGeneration)return;
  const stats=report.metrics;
  $("calendar-overdue").textContent=stats.overdue;
  $("calendar-critical").textContent=stats.critical_open;
  $("calendar-blocked").textContent=stats.blocked_by_dependencies;
  $("calendar-in-window").textContent=stats.due_in_window;
  $("task-calendar-summary").textContent=report.from_date+" — "+report.through_date+
    " · "+report.selected_total+" задач с датами"+
    (report.truncated?" · показаны первые 200":"")+
    " · "+(report.scope==="all"?"Вся команда":"Мои поручения");
  const root=$("task-calendar-list");root.replaceChildren();
  if(!report.tasks.length){
    root.append(node("p","На выбранный период нет открытых задач со сроками.","hint"));
  }
  for(const item of report.tasks){
    const card=node("article",null,"task-calendar-item");
    card.dataset.risk=item.risk;
    const head=node("div",null,"task-item-head");
    head.append(node("strong",item.title),
                node("span",TASK_CALENDAR_RISK[item.risk]||"По плану","task-calendar-risk"));
    card.append(head);
    const details=node("div",null,"task-calendar-item-details");
    details.append(node("small","Срок: "+item.due_date),
      node("small","Статус: "+TASK_STATUS[item.status]),
      node("small",item.assignee?"Исполнитель: "+item.assignee:"Без исполнителя"));
    if(item.unfinished_prerequisites){
      details.append(node("small","Не завершены предшественники: "+
        item.unfinished_prerequisites));
    }
    card.append(details);
    const open=node("button","Открыть задачу","ghost");
    open.type="button";
    open.addEventListener("click",()=>openTaskCollaboration(item)
      .catch(e=>show(e.message,true)));
    card.append(open);
    root.append(card);
  }
}
for(const id of ["task-calendar-start","task-calendar-days","task-calendar-overdue"]){
  $(id).addEventListener("change",()=>
    refreshTaskCalendar().catch(e=>show(e.message,true)));
}
$("task-calendar-refresh").addEventListener("click",()=>
  refreshTaskCalendar().catch(e=>show(e.message,true)));

async function refreshTeamWorkload(){
  if(!can("task.manage"))return;
  const reply=await api("/api/v1/tasks/workload");
  const root=$("team-workload-list");root.replaceChildren();
  for(const member of reply.members){
    const card=node("div",null,"team-member-load");
    card.append(node("strong",member.actor||"Без исполнителя"));
    card.append(node("small",member.role==="inactive"?"Доступ отозван":member.role));
    const info=node("div",null,"team-member-stats");
    for(const [label,value] of [
      ["Всего",member.total],["Открыты",member.open],
      ["Просрочены",member.overdue],["Заблокированы",member.blocked],
      ["Выполнены",member.completed]]){
      const line=node("span",label+": "+value);info.append(line);
    }
    card.append(info);
    root.append(card);
  }
}
$("team-workload-refresh").addEventListener("click",()=>{
  refreshTeamWorkload().catch(e=>show(e.message,true));
});
function closeTaskCollaboration(){
  ++state.collabGeneration;state.collabTask=null;
  state.commentPendingKey=null;state.checklistPendingKey=null;
  $("task-collaboration").hidden=true;
}
$("task-collaboration-close").addEventListener("click",closeTaskCollaboration);
async function openTaskCollaboration(task){
  state.collabTask=task;
  state.commentPendingKey=null;state.checklistPendingKey=null;
  state.dependencyRetryKey=null;
  $("task-dependency-editor").hidden=!can("task.manage");
  $("task-collaboration").hidden=false;
  $("task-collaboration-title").textContent=task.title;
  $("task-collaboration-hint").textContent="Задача "+task.task_id.slice(0,8)+
    " · "+TASK_STATUS[task.status]+" · исполнитель: "+(task.assignee||"не назначен");
  $("task-checklist-form").hidden=!can("task.manage");
  await refreshTaskCollaboration();
}
function renderTaskDependencies(data,candidates){
  const root=$("task-dependency-list");root.replaceChildren();
  $("task-dependency-count").textContent=data.total+" связей · "+
    data.unfinished+" не завершены";
  if(!data.prerequisites.length){
    root.append(node("p","Предшествующих задач пока нет.","hint"));
  }
  const selectedIds=new Set();
  for(const edge of data.prerequisites){
    const entry=node("div",null,"task-dependency-item");
    if(data.can_manage){
      selectedIds.add(edge.task_id);
      const name=node("strong",edge.title);
      const status=node("small",
        edge.status==="done"?"Выполнена":"Ожидает: "+TASK_STATUS[edge.status]);
      entry.append(name,status);
      const drop=node("button","Убрать связь","ghost");
      drop.type="button";
      drop.disabled=state.collabTask?.status==="done";
      drop.addEventListener("click",async()=>{
        const task=state.collabTask;
        if(!task)return;
        drop.disabled=true;
        try{
          const result=await api("/api/v1/tasks/"+encodeURIComponent(task.task_id)+
            "/dependencies/remove",{method:"POST",body:{
              prerequisite_id:edge.task_id,expected_version:task.version,
              idempotency_key:safeId()}});
          if(state.collabTask?.task_id!==task.task_id)return;
          state.collabTask={...state.collabTask,version:result.version};
          await refreshTaskCollaboration();
          await refreshTasks();
          show("Зависимость удалена, изменение записано в журнал");
        }catch(error){show(error.message,true);}
        finally{drop.disabled=false;}
      });
      entry.append(drop);
    }else{
      entry.append(node("span",
        edge.completed?"Предшественник завершён":"Ожидается завершение предшественника"));
    }
    root.append(entry);
  }
  const editor=$("task-dependency-editor");
  editor.hidden=!can("task.manage")||state.collabTask?.status==="done";
  if(!editor.hidden){
    const options=candidates.filter(x=>
      x.task_id!==state.collabTask?.task_id && !selectedIds.has(x.task_id));
    pick($("task-dependency-candidate"),[["","Выберите задачу"],
      ...options.map(x=>[x.task_id,x.title+" · "+TASK_STATUS[x.status]])]);
  }
}
$("task-dependency-candidate").addEventListener("change",()=>{
  state.dependencyRetryKey=null;
});
$("task-dependency-add").addEventListener("click",async()=>{
  const task=state.collabTask;
  if(!task||!can("task.manage"))return;
  const before=$("task-dependency-candidate").value;
  if(!before){show("Выберите предшествующую задачу",true);return;}
  const button=$("task-dependency-add");button.disabled=true;
  try{
    const key=state.dependencyRetryKey||safeId();
    state.dependencyRetryKey=key;
    const result=await api("/api/v1/tasks/"+encodeURIComponent(task.task_id)+
      "/dependencies/add",{method:"POST",body:{
        prerequisite_id:before,expected_version:task.version,idempotency_key:key}});
    state.dependencyRetryKey=null;
    if(state.collabTask?.task_id!==task.task_id)return;
    state.collabTask={...state.collabTask,version:result.version};
    await refreshTaskCollaboration();
    await refreshTasks();
    show("Зависимость сохранена: завершение задачи теперь контролируется");
  }catch(error){show(error.message,true);}
  finally{button.disabled=false;}
});
async function refreshTaskCollaboration(){
  const task=state.collabTask;
  if(!task)return;
  const serial=++state.collabGeneration;
  const path="/api/v1/tasks/"+encodeURIComponent(task.task_id);
  const requests=[api(path+"/checklist"),api(path+"/comments"),
    api(path+"/dependencies")];
  if(can("task.manage"))requests.push(api("/api/v1/tasks/query",{
    method:"POST",body:{limit:100,offset:0}}));
  const [checklist,comments,dependencies,choices]=await Promise.all(requests);
  if(serial!==state.collabGeneration || state.collabTask?.task_id!==task.task_id)return;
  state.collabTask={...task,version:dependencies.task_version};
  renderTaskDependencies(dependencies,choices?.tasks||[]);
  $("task-checklist-count").textContent=checklist.completed+"/"+checklist.total;
  const steps=$("task-checklist-list");steps.replaceChildren();
  if(!checklist.items.length)steps.append(node("p","Пока нет шагов.","hint"));
  for(const item of checklist.items){
    const row=node("label",null,"task-checklist-row");
    const checkbox=node("input");checkbox.type="checkbox";
    checkbox.checked=item.done;checkbox.disabled=!can("task.progress");
    checkbox.setAttribute("aria-label","Завершить шаг: "+item.label);
    const name=node("span",item.label);
    if(item.done)name.classList.add("task-checklist-completed");
    checkbox.addEventListener("change",async()=>{
      checkbox.disabled=true;
      try{
        await api(path+"/checklist/"+encodeURIComponent(item.item_id),{
          method:"PATCH",body:{expected_version:item.version,done:checkbox.checked,
                                idempotency_key:safeId()}});
        await refreshTaskCollaboration();
        show("Шаг задачи обновлён");
      }catch(e){
        checkbox.checked=item.done;checkbox.disabled=false;show(e.message,true);
      }
    });
    row.append(checkbox,name);steps.append(row);
  }
  const list=$("task-comment-list");list.replaceChildren();
  if(!comments.comments.length)list.append(node("p","Комментариев пока нет.","hint"));
  for(const c of comments.comments){
    const item=node("article",null,"task-comment");
    item.append(node("strong",c.actor));
    item.append(node("small",new Date(c.created_epoch*1000).toLocaleString("ru-RU")));
    item.append(node("p",c.body));
    list.append(item);
  }
  if(comments.has_more)list.append(node("p","Показаны первые 25 комментариев.","hint"));
}
$("task-comment-form").addEventListener("input",()=>{state.commentPendingKey=null;});
$("task-comment-form").addEventListener("submit",async event=>{
  event.preventDefault();
  const task=state.collabTask;
  if(!task)return;
  const button=$("task-comment-form").querySelector("button[type=submit]");
  button.disabled=true;
  try{
    const key=state.commentPendingKey||safeId();
    state.commentPendingKey=key;
    await api("/api/v1/tasks/"+encodeURIComponent(task.task_id)+"/comments",{
      method:"POST",body:{body:$("task-comment-text").value,idempotency_key:key}});
    state.commentPendingKey=null;
    $("task-comment-form").reset();
    await refreshTaskCollaboration();show("Комментарий сохранён в SQLite");
  }catch(e){show(e.message,true);}
  finally{button.disabled=false;}
});
$("task-checklist-form").addEventListener("input",()=>{state.checklistPendingKey=null;});
$("task-checklist-form").addEventListener("submit",async event=>{
  event.preventDefault();
  const task=state.collabTask;
  if(!task||!can("task.manage"))return;
  const button=$("task-checklist-form").querySelector("button[type=submit]");
  button.disabled=true;
  try{
    const key=state.checklistPendingKey||safeId();
    state.checklistPendingKey=key;
    await api("/api/v1/tasks/"+encodeURIComponent(task.task_id)+"/checklist",{
      method:"POST",body:{label:$("task-checklist-title").value,idempotency_key:key}});
    state.checklistPendingKey=null;
    $("task-checklist-form").reset();
    await refreshTaskCollaboration();show("Пункт чек-листа сохранён");
  }catch(e){show(e.message,true);}
  finally{button.disabled=false;}
});
function renderTaskList(){
  const root=$("task-list");root.replaceChildren();
  if(!state.tasks.length){
    root.append(node("p","Нет задач с выбранным статусом.","muted"));return;
  }
  for(const task of state.tasks){
    const card=node("article",null,"task-item");
    card.dataset.taskId=task.task_id;
    card.dataset.taskStatus=task.status;
    const top=node("div",null,"task-item-head");
    const title=node("strong",task.title);
    const info=node("span",TASK_PRIORITY[task.priority],"task-priority");
    top.append(title,info);card.append(top);
    if(task.description)card.append(node("p",task.description,"task-description"));
    const meta=node("div",null,"task-meta");
    const assigned=task.assignee?"Исполнитель: "+task.assignee:"Без исполнителя";
    const due=task.due_date?"Срок: "+task.due_date:"Срок не установлен";
    meta.append(node("small",assigned),node("small",due),
                node("small","Версия "+task.version));
    card.append(meta);
    const actions=node("div",null,"task-actions");
    if(can("task.progress")){
      const allowed=can("task.manage")?Object.keys(TASK_STATUS):
        TASK_TRANSITIONS[task.status];
      const statusSelect=node("select");
      statusSelect.setAttribute("aria-label","Статус задачи "+task.title);
      const options=can("task.manage")?allowed:[task.status,...allowed];
      pick(statusSelect,options.map(key=>[key,TASK_STATUS[key]]));
      statusSelect.value=task.status;
      const save=node("button","Сохранить статус","ghost");
      save.type="button";
      save.disabled=allowed.length===0;
      save.addEventListener("click",async()=>{
        if(statusSelect.value===task.status)return;
        save.disabled=true;
        try{
          await api("/api/v1/tasks/"+encodeURIComponent(task.task_id),{
            method:"PATCH",body:{
              expected_version:task.version,
              changes:{status:statusSelect.value},
              idempotency_key:safeId()}});
          await refreshTasks();
          show("Статус задачи сохранён в SQLite");
        }catch(e){show(e.message,true);save.disabled=false;}
      });
      actions.append(statusSelect,save);
    }
    if(can("task.manage")){
      const edit=node("button","Изменить","ghost");
      edit.type="button";
      edit.addEventListener("click",()=>{
        state.taskEditing=task;
        state.taskPendingKey=null;
        $("task-form-title").textContent="Редактирование задачи";
        $("task-save").textContent="Сохранить изменения";
        $("task-title").value=task.title;
        $("task-description").value=task.description;
        $("task-priority").value=task.priority;
        $("task-assignee").value=task.assignee||"";
        $("task-due").value=task.due_date||"";
        $("task-title").focus();
      });
      actions.append(edit);
    }
    const collab=node("button","Обсуждение / шаги","ghost task-collab-open");
    collab.type="button";
    collab.addEventListener("click",()=>openTaskCollaboration(task)
      .catch(e=>show(e.message,true)));
    actions.append(collab);
    const history=node("button","История","ghost");
    history.type="button";
    history.addEventListener("click",()=>showTaskHistory(task.task_id)
      .catch(e=>show(e.message,true)));
    actions.append(history);
    card.append(actions);root.append(card);
  }
}
async function showTaskHistory(taskId){
  const result=await api("/api/v1/tasks/"+encodeURIComponent(taskId)+"/history",{
    method:"POST",body:{limit:25}});
  const root=$("task-events-list");root.replaceChildren();
  for(const event of result.events){
    const item=node("div",null,"task-event");
    item.append(node("strong",event.operation==="CREATE"?"Создана":"Изменена"));
    item.append(node("span","Версия "+event.version+" · "+event.actor+" · "+
      new Date(event.at_epoch*1000).toLocaleString("ru-RU")));
    item.append(node("small","Поля: "+event.changed_fields.join(", ")));
    item.append(node("small","SHA-256: "+event.sha256.slice(0,18)+"…"));
    root.append(item);
  }
  $("task-events-panel").hidden=false;
}
$("task-events-close").addEventListener("click",()=>{
  $("task-events-panel").hidden=true;
});
$("task-refresh").addEventListener("click",()=>{
  refreshTasks().catch(e=>show(e.message,true));
});
$("task-status-filter").addEventListener("change",()=>{
  refreshTasks({resetOffset:true}).catch(e=>show(e.message,true));
});
for(const id of ["task-due-filter","task-assignee-filter"]){
  $(id).addEventListener("change",()=>{
    refreshTasks({resetOffset:true}).catch(e=>show(e.message,true));
  });
}
$("task-prev").addEventListener("click",()=>{
  state.taskOffset=Math.max(0,state.taskOffset-25);
  refreshTasks().catch(e=>show(e.message,true));
});
$("task-next").addEventListener("click",()=>{
  state.taskOffset+=25;
  refreshTasks().catch(e=>show(e.message,true));
});
$("task-reset").addEventListener("click",resetTaskForm);
$("task-form").addEventListener("input",()=>{state.taskPendingKey=null;});
$("task-form").addEventListener("change",()=>{state.taskPendingKey=null;});
$("task-form").addEventListener("submit",async event=>{
  event.preventDefault();
  if(!can("task.manage"))return;
  const button=$("task-save");button.disabled=true;
  try{
    const payload={
      title:$("task-title").value.trim(),
      description:$("task-description").value.trim(),
      assignee:$("task-assignee").value||null,
      priority:$("task-priority").value,
      due_date:$("task-due").value||null,
    };
    const previous=state.taskEditing;
    const key=state.taskPendingKey||safeId();
    state.taskPendingKey=key;
    if(previous){
      const changes={};
      for(const [name,value] of Object.entries(payload)){
        if(previous[name]!==value)changes[name]=value;
      }
      if(!Object.keys(changes).length)throw Error("У задачи нет изменений");
      await api("/api/v1/tasks/"+encodeURIComponent(previous.task_id),{
        method:"PATCH",body:{expected_version:previous.version,
                              changes,idempotency_key:key}});
      show("Задача обновлена с проверкой версии");
    }else{
      await api("/api/v1/tasks",{
        method:"POST",body:{...payload,idempotency_key:key}});
      show("Задача создана в SQLite");
    }
    resetTaskForm();
    await refreshTasks({resetOffset:true});
  }catch(error){show(error.message,true);}
  finally{button.disabled=false;}
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
  renderLiveForm(section);
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
function renderLiveForm(section){
  const form=$("live-form"),root=$("live-form-fields");
  const generation=(state.liveFormGeneration=(state.liveFormGeneration||0)+1);
  state.liveFormRetryKey=null;
  const enabled=section?.type==="form" && can("record.write");
  form.hidden=!enabled;
  root.replaceChildren();
  if(!enabled)return;
  const selected=state.spec.models.find(m=>m.name===section.model);
  if(!selected){form.hidden=true;return;}
  const included=section.fields||selected.fields.map(f=>f.name);
  $("live-form-title").textContent="Испытать форму: "+section.heading;
  $("live-form-status").textContent="";
  for(const name of included){
    const field=selected.fields.find(f=>f.name===name);
    if(!field)continue;
    const wrapper=node("div"),label=node("label",field.label+(field.required?" *":""));
    const input=field.type==="reference"?node("select"):node("input");
    input.dataset.liveField=field.name;
    input.id="live-"+field.name;
    input.required=Boolean(field.required);
    if(field.type==="reference"){
      pick(input,[["","Загрузка связей…"]]);input.disabled=true;
      api("/api/v1/models/"+encodeURIComponent(field.references)+"/choices")
        .then(result=>{
          if(generation!==state.liveFormGeneration)return;
          pick(input,[["","Выберите запись"],...result.choices.map(row=>[row.row_id,row.label])]);
          input.disabled=false;
        })
        .catch(()=>{
          if(generation!==state.liveFormGeneration)return;
          pick(input,[["","Связи недоступны"]]);input.disabled=true;
        });
    }else{
      input.type=field.type==="integer"?"number":
        field.type==="email"?"email":
        field.type==="date"?"date":
        field.type==="boolean"?"checkbox":"text";
      if(input.type==="number")input.step="1";
    }
    label.setAttribute("for",input.id);
    wrapper.append(label,input);root.append(wrapper);
    input.addEventListener("input",()=>{state.liveFormRetryKey=null;});
    input.addEventListener("change",()=>{state.liveFormRetryKey=null;});
  }
  $("live-form-submit").disabled=false;
}
$("live-form").addEventListener("submit",async event=>{
  event.preventDefault();
  const button=$("live-form-submit");
  if(button.disabled)return;
  button.disabled=true;
  try{
    if(!can("record.write"))throw Error("Недостаточно прав для отправки");
    const page=$("page-select").value;
    const index=Number($("section-select").value);
    const section=state.spec.pages.find(p=>p.slug===page)?.sections[index];
    if(section?.type!=="form")throw Error("Форма изменилась, обновите страницу");
    const definition=state.spec.models.find(m=>m.name===section.model);
    const data={};
    for(const input of $("live-form-fields").querySelectorAll("[data-live-field]")){
      if(input.disabled)throw Error("Поле связи ещё не загружено");
      const field=definition.fields.find(f=>f.name===input.dataset.liveField);
      const raw=field.type==="boolean"?input.checked:input.value.trim();
      if(raw==="" && !field.required)continue;
      data[field.name]=typed(field,raw);
    }
    const key=state.liveFormRetryKey||safeId();
    state.liveFormRetryKey=key;
    const result=await api("/api/v1/forms/"+encodeURIComponent(page)+"/submit",{
      method:"POST",body:{section_index:index,expected_revision:state.revision,
        data,idempotency_key:key}});
    state.liveFormRetryKey=null;
    $("live-form").reset();
    $("live-form-status").textContent="Сохранено в SQLite: "+result.row_id.slice(0,8);
    if(state.model===result.model)await refreshRows();
    show("Форма отправлена; сохранена реальная запись · v"+result.version);
  }catch(error){
    $("live-form-status").textContent="Не сохранено: "+error.message;
    show(error.message,true);
  }finally{button.disabled=false;}
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
  renderModelFields();updateWorkflowFields();renderBatchFields();
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
async function refreshRows({resetOffset=false}={}){
  if(!state.spec || !can("record.read"))return;
  if(resetOffset)state.rowOffset=0;
  const targetModel=state.model;
  const sequence=++state.rowGeneration;
  const result=await api("/api/v1/models/"+encodeURIComponent(targetModel)+"/query",{
    method:"POST",body:{limit:state.rowLimit,offset:state.rowOffset,
      search:$("record-search").value.trim()}});
  if(targetModel!==state.model || sequence!==state.rowGeneration)return;
  state.rows=result.rows;
  state.batchSelection.clear();clearBatchPlan(true);
  $("batch-selected-count").textContent="Выбрано: 0";
  $("record-page-info").textContent=(result.total===0?"Нет записей":
    "Показаны "+(result.offset+1)+"–"+(result.offset+result.rows.length)+
    " из "+result.total);
  $("record-prev").disabled=result.offset===0;
  $("record-next").disabled=!result.has_more;
  $("record-export").disabled=!can("record.read");
  $("record-csv-inspect").disabled=!can("record.write");
  pick($("row-select"),[["","Новая запись"],...state.rows.map(r=>
    [r.row_id,(r.fields[model().fields[0].name]??r.row_id)+" · v"+r.version])]);
  state.selectedRow=null;
  renderModelFields();
  $("row-form-title").textContent="Новая запись";
  $("delete-row").disabled=true;
  drawTable();
}
function clearCsvPlan(){
  state.csvPending=null;
  state.csvRetryKey=null;
  $("record-csv-approve").checked=false;
  $("record-csv-approve").disabled=true;
  $("record-csv-apply").disabled=true;
  $("record-csv-summary").textContent="";
}
$("record-find").addEventListener("click",async()=>{
  try{await refreshRows({resetOffset:true});}catch(error){show(error.message,true);}
});
$("record-search").addEventListener("keydown",event=>{
  if(event.key==="Enter"){event.preventDefault();$("record-find").click();}
});
$("record-clear").addEventListener("click",async()=>{
  $("record-search").value="";
  try{await refreshRows({resetOffset:true});}catch(error){show(error.message,true);}
});
$("record-prev").addEventListener("click",async()=>{
  state.rowOffset=Math.max(0,state.rowOffset-state.rowLimit);
  try{await refreshRows();}catch(error){show(error.message,true);}
});
$("record-next").addEventListener("click",async()=>{
  state.rowOffset+=state.rowLimit;
  try{await refreshRows();}catch(error){show(error.message,true);}
});
$("record-export").addEventListener("click",async()=>{
  try{
    if(!can("record.read"))throw Error("Нет прав на экспорт");
    const result=await api("/api/v1/models/"+encodeURIComponent(state.model)+"/csv-export",{
      method:"POST",body:{limit:100,search:$("record-search").value.trim()}});
    const blob=new Blob(["\ufeff",result.csv_text],{type:"text/csv;charset=utf-8"});
    const url=URL.createObjectURL(blob);
    const anchor=node("a");
    anchor.href=url;anchor.download=state.model+"-local-export.csv";
    document.body.append(anchor);anchor.click();anchor.remove();
    setTimeout(()=>URL.revokeObjectURL(url),1000);
    show("CSV подготовлен: "+result.exported+" строк"+
      (result.truncated?" (только первые 100 из "+result.total_filtered+")":""));
  }catch(error){show(error.message,true);}
});
$("record-csv-file").addEventListener("change",clearCsvPlan);
$("record-csv-approve").addEventListener("change",()=>{
  $("record-csv-apply").disabled=!$("record-csv-approve").checked || !state.csvPending;
});
$("record-csv-inspect").addEventListener("click",async()=>{
  clearCsvPlan();
  try{
    if(!can("record.write"))throw Error("Нет права на импорт");
    const file=$("record-csv-file").files?.[0];
    if(!file)throw Error("Сначала выбери CSV-файл");
    if(file.size>60000)throw Error("CSV превышает ограничение 60 КБ");
    const csvText=await file.text();
    if(new TextEncoder().encode(csvText).length>60000)
      throw Error("CSV превышает ограничение 60 КБ");
    const target=state.model,revision=state.revision;
    const inspected=await api("/api/v1/models/"+encodeURIComponent(target)+
      "/csv-import/inspect",{method:"POST",
      body:{expected_revision:revision,csv_text:csvText}});
    if(target!==state.model || revision!==state.revision)
      throw Error("Модель или схема изменилась, проверьте CSV снова");
    state.csvPending={model:target,revision,csvText,inspected};
    $("record-csv-summary").textContent="Проверено: "+inspected.count+
      " строк, "+inspected.columns.length+" столбцов · SHA-256 "+
      inspected.expected_plan_sha256.slice(0,16)+"…";
    $("record-csv-approve").disabled=false;
    show("Проверка CSV завершена, данные ещё не сохранены");
  }catch(error){$("record-csv-summary").textContent="Ошибка проверки: "+error.message;
    show(error.message,true);}
});
$("record-csv-apply").addEventListener("click",async()=>{
  const pending=state.csvPending;
  if(!pending || !$("record-csv-approve").checked)return;
  const button=$("record-csv-apply");button.disabled=true;
  try{
    if(!can("record.write") || pending.model!==state.model ||
       pending.revision!==state.revision)
      throw Error("Права или настройки модели изменились — требуется новая проверка");
    const key=state.csvRetryKey||safeId();
    state.csvRetryKey=key;
    const result=await api("/api/v1/models/"+encodeURIComponent(pending.model)+
      "/csv-import/apply",{method:"POST",body:{
        expected_revision:pending.revision,csv_text:pending.csvText,
        expected_plan_sha256:pending.inspected.expected_plan_sha256,
        idempotency_key:key}});
    clearCsvPlan();
    $("record-csv-file").value="";
    await refreshRows({resetOffset:true});
    show("Импортировано в SQLite: "+result.imported+
      " записей · автоматизаций: "+result.workflow_runs);
  }catch(error){
    $("record-csv-summary").textContent="Импорт не подтверждён: "+error.message;
    show(error.message,true);
  }finally{
    button.disabled=!state.csvPending || !$("record-csv-approve").checked;
  }
});
function clearBatchPlan(clearRestore=false){
  state.batchPlan=null;
  state.batchRetryKey=null;
  $("batch-approve").checked=false;
  $("batch-approve").disabled=true;
  $("batch-apply").disabled=true;
  $("batch-summary").textContent="";
  if(clearRestore){
    state.batchRestorePlan=null;state.batchRestoreRetryKey=null;
    $("batch-restore-review").hidden=true;
    $("batch-restore-approve").checked=false;
    $("batch-restore-apply").disabled=true;
  }
}
function renderBatchFields(){
  const available=model()?.fields||[];
  const previous=$("batch-field").value;
  pick($("batch-field"),available.map(f=>[f.name,f.label+" · "+f.type]));
  if(available.some(f=>f.name===previous))$("batch-field").value=previous;
  updateBatchValueControl();
}
function updateBatchValueControl(){
  clearBatchPlan();
  const field=model()?.fields.find(f=>f.name===$("batch-field").value);
  const root=$("batch-value-control");root.replaceChildren();
  if(!field)return;
  const generation=++state.batchFieldGeneration;
  const input=(field.type==="reference"||field.type==="boolean")?
    node("select"):node("input");
  input.id="batch-value";
  if(field.type==="reference"){
    input.disabled=true;pick(input,[["","Загрузка вариантов…"]]);
    api("/api/v1/models/"+encodeURIComponent(field.references)+"/choices")
      .then(result=>{
        if(generation!==state.batchFieldGeneration)return;
        pick(input,[["","Без связи"],...result.choices.map(x=>[x.row_id,x.label])]);
        input.disabled=!can("record.write");
      })
      .catch(e=>{
        if(generation!==state.batchFieldGeneration)return;
        pick(input,[["","Ошибка загрузки"]]);input.disabled=true;
        show(e.message,true);
      });
  }else if(field.type==="boolean"){
    pick(input,[["true","Да"],["false","Нет"]]);
  }else{
    input.type=field.type==="integer"?"number":
      field.type==="email"?"email":field.type==="date"?"date":"text";
    if(field.type==="integer")input.step="1";
    if(field.type==="text")input.maxLength=1000;
  }
  input.disabled=input.disabled||!can("record.write");
  input.addEventListener("input",()=>clearBatchPlan());
  input.addEventListener("change",()=>clearBatchPlan());
  root.append(input);
}
$("batch-field").addEventListener("change",updateBatchValueControl);
function selectedBatchPatches(){
  if(!can("record.write"))throw Error("Нет прав для изменения записей");
  const selected=state.rows.filter(r=>state.batchSelection.has(r.row_id));
  if(!selected.length)throw Error("Отметь хотя бы одну запись на текущей странице");
  if(selected.length>25)throw Error("Лимит одного пакета — 25 записей");
  const field=model()?.fields.find(f=>f.name===$("batch-field").value);
  const input=$("batch-value");
  if(!field||!input||input.disabled)throw Error("Выбери доступное поле и значение");
  if(!input.checkValidity())throw Error("Недопустимое значение поля");
  const raw=input.value.trim();
  const value=field.type==="boolean"?raw==="true":typed(field,raw);
  return selected.map(row=>({
    row_id:row.row_id,expected_version:row.version,changes:{[field.name]:value}
  }));
}
$("batch-inspect").addEventListener("click",async()=>{
  clearBatchPlan();
  try{
    const modelName=state.model,revision=state.revision;
    const patches=selectedBatchPatches();
    const plan=await api("/api/v1/models/"+encodeURIComponent(modelName)+
      "/batch/inspect",{method:"POST",body:{expected_revision:revision,patches}});
    if(state.model!==modelName||state.revision!==revision)
      throw Error("Модель изменилась; заново проверьте пакет");
    state.batchPlan={model:modelName,revision,patches,plan};
    $("batch-summary").textContent="Проверено: "+plan.count+
      " записей · SHA-256 "+plan.expected_plan_sha256.slice(0,16)+"…";
    $("batch-approve").disabled=false;
    show("План массового изменения проверен. Записи пока не изменены.");
  }catch(e){$("batch-summary").textContent="Не удалось проверить: "+e.message;
    show(e.message,true);}
});
$("batch-approve").addEventListener("change",()=>{
  $("batch-apply").disabled=!state.batchPlan||!$("batch-approve").checked;
});
$("batch-apply").addEventListener("click",async()=>{
  const pending=state.batchPlan;
  if(!pending||!$("batch-approve").checked)return;
  $("batch-apply").disabled=true;
  try{
    if(pending.model!==state.model||pending.revision!==state.revision)
      throw Error("Схема изменена; проверьте пакет повторно");
    const key=state.batchRetryKey||safeId();
    state.batchRetryKey=key;
    const receipt=await api("/api/v1/models/"+encodeURIComponent(pending.model)+
      "/batch/apply",{method:"POST",body:{
        expected_revision:pending.revision,patches:pending.patches,
        expected_plan_sha256:pending.plan.expected_plan_sha256,
        idempotency_key:key}});
    clearBatchPlan(true);
    await refreshRows({resetOffset:true});
    await refreshBatchHistory();
    show("Массовое изменение сохранено: "+receipt.updated+
      " записей · журнал "+receipt.batch_id.slice(0,8));
  }catch(e){$("batch-summary").textContent="Изменения не подтверждены: "+e.message;
    show(e.message,true);
  }finally{
    $("batch-apply").disabled=!state.batchPlan||!$("batch-approve").checked;
  }
});
async function refreshBatchHistory(){
  if(!state.spec||!can("record.read"))return;
  const selected=state.model;
  const result=await api("/api/v1/models/"+encodeURIComponent(selected)+
    "/batch/history",{method:"POST",body:{limit:20}});
  if(selected!==state.model)return;
  const root=$("batch-history-list");root.replaceChildren();
  if(!result.history.length){
    root.append(node("p","Пакетных операций пока нет.","muted"));return;
  }
  const restored=new Set(result.history.filter(x=>x.operation==="RESTORE")
    .map(x=>x.parent_batch_id));
  for(const entry of result.history){
    const card=node("div",null,"batch-journal-item");
    card.append(node("strong",
      entry.operation==="RESTORE"?"Откат":"Изменение"));
    card.append(node("small",entry.count+" записей · "+
      new Date(entry.created_epoch*1000).toLocaleString("ru-RU")+
      " · "+entry.batch_id.slice(0,8)));
    card.append(node("small","SHA-256 "+entry.entry_digest.slice(0,20)+"…"));
    if(entry.operation==="UPDATE"){
      const button=node("button",restored.has(entry.batch_id)?
        "Откат уже выполнен":"Проверить откат","ghost");
      button.type="button";
      button.disabled=restored.has(entry.batch_id)||
        !can("record.write")||!can("spec.write");
      button.addEventListener("click",()=>inspectBatchRestore(entry.batch_id)
        .catch(e=>show(e.message,true)));
      card.append(button);
    }
    root.append(card);
  }
}
async function inspectBatchRestore(batchId){
  state.batchRestorePlan=null;
  state.batchRestoreRetryKey=null;
  $("batch-restore-review").hidden=true;
  const modelName=state.model,revision=state.revision;
  const plan=await api("/api/v1/models/"+encodeURIComponent(modelName)+
    "/batch/restore/inspect",{method:"POST",
      body:{batch_id:batchId,expected_revision:revision}});
  if(modelName!==state.model||revision!==state.revision)
    throw Error("Версия модели изменилась во время проверки");
  state.batchRestorePlan={model:modelName,revision,batchId,plan};
  $("batch-restore-review").hidden=false;
  $("batch-restore-approve").checked=false;
  $("batch-restore-apply").disabled=true;
  $("batch-restore-summary").textContent="Готов откат "+plan.count+
    " записей · SHA-256 "+plan.expected_plan_sha256.slice(0,16)+
    "… Новая ревизия сохранит историю. Автоматизации повторно не запускаются.";
}
$("batch-history-refresh").addEventListener("click",()=>{
  refreshBatchHistory().catch(e=>show(e.message,true));
});
$("batch-restore-approve").addEventListener("change",()=>{
  $("batch-restore-apply").disabled=!$("batch-restore-approve").checked||
    !state.batchRestorePlan;
});
$("batch-restore-apply").addEventListener("click",async()=>{
  const pending=state.batchRestorePlan;
  if(!pending||!$("batch-restore-approve").checked)return;
  $("batch-restore-apply").disabled=true;
  try{
    if(pending.model!==state.model||pending.revision!==state.revision)
      throw Error("Версия проекта изменилась");
    const key=state.batchRestoreRetryKey||safeId();
    state.batchRestoreRetryKey=key;
    const out=await api("/api/v1/models/"+encodeURIComponent(pending.model)+
      "/batch/restore/apply",{method:"POST",body:{
        batch_id:pending.batchId,expected_revision:pending.revision,
        expected_plan_sha256:pending.plan.expected_plan_sha256,
        idempotency_key:key}});
    clearBatchPlan(true);
    await refreshRows({resetOffset:true});
    await refreshBatchHistory();
    show("Откат выполнен: "+out.restored+" записей. История сохранена.");
  }catch(e){$("batch-restore-summary").textContent="Откат отклонён: "+e.message;
    show(e.message,true);
  }finally{
    $("batch-restore-apply").disabled=!state.batchRestorePlan||
      !$("batch-restore-approve").checked;
  }
});
function drawTable(){
  const root=$("rows-table");root.replaceChildren();
  const m=model();if(!m)return;
  const table=node("table"),head=node("thead"),hrow=node("tr");
  hrow.append(node("th","Выбрать"));
  for(const field of m.fields)hrow.append(node("th",field.label));
  hrow.append(node("th","Версия"));head.append(hrow);table.append(head);
  const tbody=node("tbody");
  for(const r of state.rows){
    const tr=node("tr");
    const selectCell=node("td");
    const mark=node("input");mark.type="checkbox";
    mark.dataset.batchRowId=r.row_id;
    mark.setAttribute("aria-label","Выбрать запись "+r.row_id.slice(0,8));
    mark.checked=state.batchSelection.has(r.row_id);
    mark.disabled=!can("record.write");
    mark.addEventListener("change",()=>{
      if(mark.checked)state.batchSelection.add(r.row_id);
      else state.batchSelection.delete(r.row_id);
      clearBatchPlan();
      $("batch-selected-count").textContent="Выбрано: "+state.batchSelection.size;
    });
    selectCell.append(mark);tr.append(selectCell);
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
  $("record-search").value="";
  $("record-csv-file").value="";
  clearCsvPlan();
  renderBatchFields();
  try{await refreshRows({resetOffset:true});}catch(e){show(e.message,true);}
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
// A deterministic signal for real browser readiness and safe form submission.
document.documentElement.dataset.consoleReady="1";
})();
