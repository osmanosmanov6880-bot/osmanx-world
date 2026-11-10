"use strict";
/* M203 owner-controlled actions. No HTML injection, persistent bearer tokens or network egress. */
const S={token:"",session:null,alerts:[],snapshots:[],members:[],plans:[],plan:null,report:null,seq:0};
const $=id=>document.getElementById(id);
const dom=(tag,cls,value)=>{const e=document.createElement(tag);if(cls)e.className=cls;if(value!==undefined)e.textContent=String(value);return e;};
const money=x=>x==null?"—":new Intl.NumberFormat("ru-RU",{style:"currency",currency:"RUB"}).format(x/100);
const day=t=>t==null?"Не назначен":new Date(t*1000).toLocaleString("ru-RU",{dateStyle:"short",timeStyle:"short",timeZone:"UTC"})+" UTC";
const STATUS={draft:"Черновик",active:"В работе",model_reviewed:"Модельный результат принят",cancelled:"Отменён"};
const JUDGEMENTS={MODEL_TARGET_REACHED_REVIEW_REQUIRED:"Цель модели достигнута, нужна проверка владельца",TARGET_NOT_REACHED:"Показатель не достиг целевого уровня",TASKS_NOT_FINISHED:"Цель достигнута, но задачи ещё не завершены"};
function pop(message){const node=$("toast");node.textContent=String(message);node.hidden=false;clearTimeout(pop.t);pop.t=setTimeout(()=>node.hidden=true,4500);}
function uuid(){return "m203-"+crypto.randomUUID();}
function amount(s,isCount=false){
    const v=String(s).trim().replace(",",".");
    if(isCount){if(!/^\d{1,4}$/.test(v)||Number(v)>1000)throw Error("Число проектов должно быть целым от 0 до 1000");return Number(v);}
    if(!/^\d{1,13}(?:\.\d{1,2})?$/.test(v))throw Error("Введите сумму в рублях, максимум две цифры после запятой");
    const p=v.split(".");
    const n=BigInt(p[0])*100n+BigInt(((p[1]||"")+"00").slice(0,2));
    if(n>1000000000000000n)throw Error("Сумма превышает предел модели");
    return Number(n);
}
function epoch(id){const v=$(id).value;const m=Date.parse(v);if(!Number.isFinite(m))throw Error("Укажите корректный срок");return Math.floor(m/1000);}
function localDatetime(t){const d=new Date(t*1000);const offset=d.getTimezoneOffset()*60000;return new Date(d.getTime()-offset).toISOString().slice(0,16);}
async function api(operation,payload={},write=false){
    if(!S.token)throw Error("Нет авторизации");
    const r=await fetch("/v1/execute",{method:"POST",cache:"no-store",headers:{"Content-Type":"application/json","Authorization":"Bearer "+S.token},body:JSON.stringify({operation,payload,idempotency_key:write?uuid():null})});
    const data=await r.json();
    if(!r.ok||!data.ok){const e=new Error(data.message||data.error||"Запрос отклонён");e.status=r.status;throw e;}
    return data.result;
}
async function login(e){
    e.preventDefault();S.token=$("token").value;$("loginError").textContent="";
    try{
        S.session=await api("titan.session.get");
        if(S.session.role==="viewer")throw Error("Эта панель недоступна роли viewer");
        $("login").hidden=true;$("shell").hidden=false;$("token").value="";
        $("actor").textContent=S.session.actor+" · "+S.session.role;
        $("ownerView").hidden=S.session.role!=="owner";
        $("employeeView").hidden=S.session.role==="owner";
        await refresh();
    }catch(error){S.token="";$("loginError").textContent=error.message;}
}
function logout(){S.seq++;S.token="";S.session=null;S.plan=null;S.report=null;S.alerts=[];S.snapshots=[];S.plans=[];$("login").hidden=false;$("shell").hidden=true;$("token").value="";}
async function refresh(){
    const seq=++S.seq;
    try{
        if(S.session.role!=="owner"){
            const mine=await api("commerce.actions.mine");
            if(seq!==S.seq)return;
            renderMine(mine.items);
            return;
        }
        const results=await Promise.all([
            api("commerce.alerts.list",{limit:200}),
            api("commerce.monitor.snapshots.list",{limit:200}),
            api("titan.team.members.list"),
            api("commerce.actions.list",{limit:200}),
            api("commerce.actions.report")
        ]);
        if(seq!==S.seq)return;
        S.alerts=results[0].items;
        S.snapshots=results[1].snapshots;
        S.members=results[2].members||[];
        S.plans=results[3].items;
        S.report=results[4];
        renderStats();
        renderAlerts();
        renderPlans();
        renderReport();
        if(S.plan){
            const still=S.plans.find(p=>p.id===S.plan.id);
            if(still)S.plan=still;else S.plan=null;
        }
        renderSelected();
    }catch(error){pop("Ошибка загрузки: "+error.message);}
}
function renderMine(items){
    const root=$("employeeItems");root.replaceChildren();
    if(!items.length){root.append(dom("p","muted","Поручений пока нет."));return;}
    for(const task of items){
        const row=dom("div","item");const left=dom("div");
        left.append(dom("strong","",task.title),dom("small","",task.plan_title+" · "+task.status+" · "+day(task.due_at)));
        const link=dom("a","","Открыть задание");link.href="/studio/";
        row.append(left,link);root.append(row);
    }
}
function renderStats(){
    if(!S.report)return;
    $("statTotal").textContent=S.report.plan_count;
    $("statActive").textContent=S.report.statuses.active;
    $("statTasks").textContent=S.report.task_completed_count+" / "+S.report.task_count;
    $("statReviewed").textContent=S.report.model_reviewed_count;
}
function riskOption(a){const option=dom("option","",a.label+" · эпизод "+a.episode);option.value=a.id;return option;}
function selectedRisk(){return S.alerts.find(a=>a.id===$("riskSelect").value);}
function renderAlerts(){
    const field=$("riskSelect");const selected=field.value;field.replaceChildren();
    const active=S.alerts.filter(a=>["open","acknowledged"].includes(a.status));
    field.append(dom("option","","Выберите риск"));field.firstChild.value="";
    for(const a of active)field.append(riskOption(a));
    if(active.some(x=>x.id===selected))field.value=selected;
    if(!field.value&&active.length)field.value=active[0].id;
    updateBaseline();
}
function updateBaseline(){
    const a=selectedRisk(),field=$("baselineSelect");field.replaceChildren();
    if(!a){$("riskInfo").textContent="Сначала выполните сканирование в разделе M202.";return;}
    const valid=S.snapshots.filter(s=>s.created_at>=a.created_at&&
        s.policy_version===a.policy_version&&s.rules.some(r=>r.rule===a.rule&&r.present));
    for(const sample of valid){
        const rule=sample.rules.find(r=>r.rule===a.rule);
        const option=dom("option","","Снимок "+day(sample.created_at)+" · "+(rule.unit==="count"?rule.observed:money(rule.observed)));
        option.value=sample.id;field.append(option);
    }
    $("target").value="0";
    $("riskInfo").textContent="Правило: "+a.rule+" · показатель: "+
        (a.unit==="count"?a.observed_value:money(a.observed_value))+
        " · доступны только снимки той же финансовой политики.";
    if(!field.options.length)$("riskInfo").textContent+=" Нет сопоставимого снимка — сначала запустите проверку M202.";
}
function card(plan){
    const b=dom("button","plan"+(S.plan?.id===plan.id?" selected-plan":""));
    b.type="button";
    b.append(dom("span","tag",STATUS[plan.status]||plan.status),
             dom("strong","",plan.title),
             dom("p","meta","Риск "+plan.rule+" · цель "+metric(plan,plan.target_value)+
                 " · поручений "+plan.done_steps+"/"+plan.total_steps),
             dom("span","tag","Версия "+plan.version+" · срок "+day(plan.due_at)));
    b.onclick=()=>{S.plan=plan;renderPlans();renderSelected();};
    return b;
}
function metric(plan,v){return plan.rule==="OVER_BUDGET_PROJECTS"?String(v):money(v);}
function renderPlans(){
    const root=$("planCards");root.replaceChildren();
    if(!S.plans.length){root.append(dom("p","muted","Планов пока нет. Создайте первый на основании риска M201."));return;}
    for(const p of S.plans)root.append(card(p));
}
function createRow(title,subtitle,status,color){
    const row=dom("div","item");const left=dom("div");
    left.append(dom("strong","",title),dom("small","",subtitle));
    row.append(left,dom("span",color||"neutral",status));return row;
}
function renderSelected(){
    const panel=$("detailsPanel");
    panel.hidden=!S.plan;
    if(!S.plan)return;
    const p=S.plan;
    $("selectedTitle").textContent=p.title;
    $("planMeta").textContent=(STATUS[p.status]||p.status)+" · правило "+p.rule+
        " · база "+metric(p,p.baseline_value)+" → цель "+metric(p,p.target_value)+
        " · версия "+p.version;
    $("activate").disabled=p.status!=="draft";
    $("cancel").disabled=!["draft","active"].includes(p.status);
    $("stepForm").hidden=!["draft","active"].includes(p.status);
    $("evaluate").disabled=p.status!=="active";
    $("reviewForm").hidden=p.status!=="active"||!p.latest_evaluation;
    const list=$("steps");list.replaceChildren();
    if(!p.steps.length)list.append(dom("p","muted","Назначьте хотя бы одно поручение."));
    for(const step of p.steps){
        list.append(createRow(step.title,
            step.assignee+" · срок "+day(step.due_at)+" · задача "+step.work_id,
            step.status,step.status==="done"?"good":"neutral"));
    }
    const select=$("assignee");const oldAssignee=select.value;select.replaceChildren();
    for(const member of S.members){
        const opt=dom("option","",member.actor+" · "+member.role);opt.value=member.actor;select.append(opt);
    }
    if(S.members.some(m=>m.actor===oldAssignee))select.value=oldAssignee;
    if(!$("stepDue").value)$("stepDue").value=localDatetime(Math.min(p.due_at,Math.floor(Date.now()/1000)+3600));
    const outcomes=S.snapshots.filter(s=>s.policy_version===p.policy_version&&
        s.created_at>(p.started_at||0)&&s.id!==p.baseline_snapshot_id);
    const outcome=$("outcomeSelect");const prev=outcome.value;outcome.replaceChildren();
    for(const sample of outcomes){
        const opt=dom("option","",day(sample.created_at)+" · "+sample.id.slice(0,9));
        opt.value=sample.id;outcome.append(opt);
    }
    if(outcomes.some(s=>s.id===prev))outcome.value=prev;
    renderEvaluation(p.latest_evaluation);
}
function renderEvaluation(e){
    const box=$("result");box.replaceChildren();
    if(!e){box.append(dom("p","muted","Оценки пока нет. Дождитесь выполнения задач и нового снимка M202."));return;}
    const p=S.plan;
    box.append(dom("strong","",JUDGEMENTS[e.judgement]||e.judgement),
      dom("p","muted","База "+metric(p,e.baseline_value)+
          " → наблюдение "+metric(p,e.observed_value)+
          " · выполнено "+e.finished_tasks+" из "+e.total_tasks+" задач."));
    box.append(dom("p","muted small","Это результат локального расчёта. Причинность, прибыль и банковская оплата не подтверждены."));
}
async function createPlan(e){
    e.preventDefault();
    const a=selectedRisk();
    if(!a){pop("Выберите финансовый риск");return;}
    try{
        const result=await api("commerce.actions.create",{
            alert_id:a.id,expected_alert_version:a.version,
            baseline_snapshot_id:$("baselineSelect").value,
            title:$("title").value,hypothesis:$("hypothesis").value,
            target_value:amount($("target").value,a.rule==="OVER_BUDGET_PROJECTS"),
            due_at:epoch("planDue")
        },true);
        pop("План создан. Добавьте задачи и активируйте его.");
        await refresh();
        S.plan=S.plans.find(p=>p.id===result.id)||null;
        renderPlans();renderSelected();
    }catch(error){pop(error.message);}
}
async function addTask(e){
    e.preventDefault();
    if(!S.plan)return;
    try{
        const result=await api("commerce.actions.step.add",{
            plan_id:S.plan.id,expected_version:S.plan.version,
            title:$("stepTitle").value,description:$("stepDescription").value,
            assignee:$("assignee").value,due_at:epoch("stepDue")
        },true);
        pop("Задача создана сотруднику "+result.assignee+" в M195.");
        $("stepTitle").value="";$("stepDescription").value="";
        await refresh();
    }catch(error){pop(error.message);}
}
async function activate(){
    if(!S.plan)return;
    try{await api("commerce.actions.start",{
        plan_id:S.plan.id,expected_version:S.plan.version},true);
        pop("План активирован.");await refresh();
    }catch(e){pop(e.message);}
}
async function cancel(){
    if(!S.plan)return;
    const reason=window.prompt("Причина отмены (поручения остаются в M195):");
    if(reason===null)return;
    try{const result=await api("commerce.actions.cancel",{
        plan_id:S.plan.id,expected_version:S.plan.version,reason
    },true);pop("План отменён. Активных задач M195: "+result.remaining_task_ids.length);await refresh();}
    catch(e){pop(e.message);}
}
async function evaluate(){
    if(!S.plan)return;
    const id=$("outcomeSelect").value;
    if(!id){pop("Нужен новый снимок M202 после запуска плана");return;}
    try{const result=await api("commerce.actions.evaluate",{
        plan_id:S.plan.id,expected_version:S.plan.version,
        outcome_snapshot_id:id},true);
        pop(JUDGEMENTS[result.judgement]||result.judgement);
        await refresh();
    }catch(e){pop(e.message);}
}
async function review(e){
    e.preventDefault();
    if(!S.plan?.latest_evaluation)return;
    const approved=$("reviewChoice").value==="accept";
    try{
        const result=await api("commerce.actions.review",{
            plan_id:S.plan.id,expected_version:S.plan.version,
            evaluation_id:S.plan.latest_evaluation.id,
            approved,reason:$("reviewReason").value},true);
        pop(result.decision==="MODEL_RESULT_ACCEPTED"?"Модельный результат принят владельцем":"План возвращён на доработку");
        $("reviewReason").value="";await refresh();
    }catch(error){pop(error.message);}
}
function renderReport(){
    const root=$("report");root.replaceChildren();
    if(!S.report)return;
    const rows=[
       ["Планы по всем статусам",String(S.report.plan_count)],
       ["Активные планы с просроченным сроком",String(S.report.overdue_active_plan_count)],
       ["Выполненные поручения M195",S.report.task_completed_count+" из "+S.report.task_count],
       ["Модельные результаты проверены владельцем",String(S.report.model_reviewed_count)],
       ["Доказанный финансовый эффект",S.report.financial_outcome_proven?"Да":"Нет — требуется внешняя оценка"]
    ];
    for(const [title,value] of rows)root.append(createRow(title,"Источники: локальные M195–M203",value));
}
async function buildReport(){try{S.report=await api("commerce.actions.report");renderReport();renderStats();pop("Отчёт собран из локальной базы.");}catch(e){pop(e.message);}}
async function exportCsv(){
    try{
        const out=await api("commerce.actions.report.csv");
        const url=URL.createObjectURL(new Blob([out.content],{type:out.mime}));
        const a=document.createElement("a");a.href=url;a.download=out.filename;
        document.body.append(a);a.click();a.remove();
        setTimeout(()=>URL.revokeObjectURL(url),1000);
        pop("Экспортировано планов: "+out.rows);
    }catch(e){pop(e.message);}
}
$("loginForm").onsubmit=login;$("logout").onclick=logout;$("refresh").onclick=refresh;
$("createForm").onsubmit=createPlan;$("riskSelect").onchange=updateBaseline;
$("reloadPlans").onclick=refresh;$("stepForm").onsubmit=addTask;
$("activate").onclick=activate;$("cancel").onclick=cancel;
$("evaluate").onclick=evaluate;$("reviewForm").onsubmit=review;
$("buildReport").onclick=buildReport;$("csv").onclick=exportCsv;
$("planDue").value=localDatetime(Math.floor(Date.now()/1000)+2*86400);
