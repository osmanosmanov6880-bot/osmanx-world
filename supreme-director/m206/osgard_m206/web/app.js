"use strict";
/* M206 owner-only financial assurance console. No HTML injection, token
   persistence, external API/CDN, fabricated financial inputs or auto-resolution. */
const S={token:"",identity:null,plans:[],plan:null,portfolio:null,
    latest:null,forecasts:null,baseline:null,backtest:null,sequence:0};
const $=id=>document.getElementById(id);
const node=(tag,className,value)=>{
    const e=document.createElement(tag);if(className)e.className=className;
    if(value!==undefined)e.textContent=String(value);return e;
};
const money=value=>value==null?"—":new Intl.NumberFormat("ru-RU",
    {style:"currency",currency:"RUB"}).format(value/100);
const datetime=value=>value==null?"—":new Date(value*1000).toLocaleString("ru-RU",
    {dateStyle:"short",timeStyle:"short",timeZone:"UTC"})+" UTC";
const descriptions={
    SOURCE_LINK_DRIFT:"Изменился или отменён источник расходов M198",
    UNLINKED_MANUAL_COST:"Разовый расход M204 не связан с источником M198",
    AMBIGUOUS_LOCAL_MATCH:"Найдено несколько возможных источников",
    CROSS_BASIS_REFERENCE_REVIEW:"Один номер основания в плановых и понесённых расходах",
    NO_ONE_TIME_COST_BASIS:"Нет ни одной разовой инвестиционной базы",
    NO_MONTHLY_BENEFIT_FORECAST:"Нет гипотезы ежемесячной выгоды",
    RECURRING_SOURCE_UNKNOWN:"Нет данных о регулярной стоимости (это не ноль)",
    CROSS_PLAN_SOURCE_REFERENCE:"Основание расхода также используется другим планом",
};
const statuses={warning:"Требует проверки",review:"Рассмотреть",info:"Нет данных"};
function notify(message){
    const box=$("toast");box.textContent=String(message);box.hidden=false;
    clearTimeout(notify.timer);notify.timer=setTimeout(()=>box.hidden=true,4600);
}
function newKey(){return "m206-"+crypto.randomUUID();}
function minor(text){
    const raw=String(text).trim().replace(",",".");
    if(!/^\d{1,11}(?:\.\d{1,2})?$/.test(raw))
        throw Error("Введите сумму в рублях, не более двух знаков после запятой");
    const [whole,dec=""]=raw.split(".");
    const amount=BigInt(whole)*100n+BigInt((dec+"00").slice(0,2));
    if(amount<0n||amount>1000000000000n)
        throw Error("Допустимая сумма — 0…10¹² копеек");
    return Number(amount);
}
function number(id,lo,hi){
    const raw=$(id).value,parsed=Number(raw);
    if(raw===""||!Number.isInteger(parsed)||parsed<lo||parsed>hi)
        throw Error("Недопустимое значение "+id+": "+lo+"…"+hi);
    return parsed;
}
async function api(operation,payload={},write=false){
    if(!S.token)throw Error("Требуется авторизация");
    const res=await fetch("/v1/execute",{
        method:"POST",cache:"no-store",
        headers:{"Content-Type":"application/json","Authorization":"Bearer "+S.token},
        body:JSON.stringify({operation,payload,
            idempotency_key:write?newKey():null})
    });
    const data=await res.json();
    if(!res.ok||!data.ok){
        const err=new Error(data.message||data.error||"Сервер отклонил запрос");
        err.code=res.status;throw err;
    }
    return data.result;
}
async function login(e){
    e.preventDefault();$("loginError").textContent="";
    S.token=$("token").value;
    try{
        const id=await api("titan.session.get");
        if(id.role!=="owner")throw Error("Диагностика финансов доступна только владельцу организации");
        S.identity=id;
        $("actor").textContent=id.actor+" · владелец";
        $("login").hidden=true;$("shell").hidden=false;$("token").value="";
        await refresh();
    }catch(error){
        S.token="";S.identity=null;
        $("loginError").textContent=error.message;
    }
}
function logout(){
    ++S.sequence;
    S.token="";S.identity=null;S.plans=[];S.plan=null;S.portfolio=null;
    S.latest=null;S.forecasts=null;S.baseline=null;S.backtest=null;
    $("login").hidden=false;$("shell").hidden=true;$("token").value="";
}
function entryRow(title,details,state,severity){
    const row=node("div","record"),left=node("div"),right=node("div","right");
    left.append(node("strong","",title),node("small","",details));
    if(state!==undefined)right.append(node("strong",severity||"",state));
    row.append(left,right);
    return {root:row,right};
}
function empty(element,message){
    element.replaceChildren(node("p","muted",message));
}
async function refresh(){
    const current=++S.sequence;
    try{
        const [actions,overview]=await Promise.all([
            api("commerce.actions.list",{limit:200}),
            api("commerce.assurance.portfolio")
        ]);
        if(current!==S.sequence)return;
        const old=S.plan?.id;
        S.plans=actions.items;
        S.portfolio=overview;
        S.plan=S.plans.find(p=>p.id===old)||S.plans[0]||null;
        renderStats();renderPlanSelect();renderPortfolio();
        await loadPlan(current);
    }catch(err){notify("Не удалось загрузить: "+err.message);}
}
function renderStats(){
    const items=S.portfolio?.items||[];
    $("statPlans").textContent=S.portfolio?.plans_total??"—";
    $("statUnscanned").textContent=items.filter(p=>p.scan_status==="NOT_SCANNED").length;
    const counts=items.map(p=>p.warning_count).filter(x=>x!==null);
    $("statWarnings").textContent=counts.length?
        counts.reduce((a,b)=>a+b,0):"Нет сканов";
    $("statForecasts").textContent=items.reduce((a,b)=>a+b.frozen_baselines,0);
}
function renderPlanSelect(){
    const select=$("planSelect");
    select.replaceChildren();
    if(!S.plans.length){
        const option=node("option","","Нет планов — создайте в M203");option.value="";
        select.append(option);$("planHint").textContent="План не выбран";
        $("planSections").hidden=true;return;
    }
    $("planSections").hidden=false;
    for(const p of S.plans){
        const option=node("option","",p.title+" · "+p.status);option.value=p.id;
        select.append(option);
    }
    select.value=S.plan.id;
    $("planHint").textContent=S.plan.rule+" · "+S.plan.status+
        " · версия "+S.plan.version;
}
async function selectPlan(){
    ++S.sequence;
    S.plan=S.plans.find(p=>p.id===$("planSelect").value)||null;
    S.latest=null;S.forecasts=null;S.baseline=null;S.backtest=null;
    renderPlanSelect();await loadPlan(S.sequence);
}
async function loadPlan(sequence){
    if(!S.plan)return;
    const planId=S.plan.id;
    try{
        const [last,forecasts]=await Promise.all([
            api("commerce.assurance.latest",{plan_id:planId}),
            api("commerce.forecast.list",{plan_id:planId})
        ]);
        if(sequence!==S.sequence||S.plan?.id!==planId)return;
        const before=S.baseline;
        S.latest=last;S.forecasts=forecasts;
        S.baseline=forecasts.items.some(i=>i.baseline_id===before)?
            before:forecasts.items.at(-1)?.baseline_id||null;
        renderDiagnostics();renderBaselineSelect();
        await loadBacktest(sequence);
    }catch(error){notify("Данные проверки недоступны: "+error.message);}
}
function renderDiagnostics(){
    const list=$("findingList");
    list.replaceChildren();
    if(!S.latest?.exists){
        $("diagnosticStatus").textContent="Для этого плана нет снимка проверки. Невыполненная проверка НЕ означает отсутствие проблем.";
        $("diagnosticHash").textContent="";
        list.append(node("p","muted","Запустите проверку для получения подтверждённых локальными данными замечаний."));
        return;
    }
    const s=S.latest.snapshot;
    $("diagnosticStatus").textContent="Последний снимок "+datetime(S.latest.captured_at)+
        " · предупреждений "+s.counts.warning+
        " · на рассмотрение "+s.counts.review+
        " · информационных "+s.counts.info;
    $("diagnosticHash").textContent="Локальная контрольная сумма: "+S.latest.verified_local_hash+
        " · внешняя подпись отсутствует.";
    if(!s.findings.length){
        list.append(node("p","muted","Эти детерминированные проверки не нашли расхождений. Это не означает банковскую верификацию."));
    }
    for(const finding of s.findings){
        const acknowledged=S.latest.acknowledged_finding_ids.includes(finding.id);
        const row=entryRow(descriptions[finding.code]||finding.code,
            finding.source_ref+" · "+JSON.stringify(finding.detail),
            acknowledged?"Рассмотрено, не исправлено":(statuses[finding.severity]||finding.severity),
            finding.severity);
        if(!acknowledged){
            const b=node("button","","Подтвердить рассмотрение");
            b.type="button";b.onclick=()=>acknowledge(finding);
            row.right.append(b);
        }
        list.append(row.root);
    }
}
async function runScan(){
    if(!S.plan)return;
    try{
        const result=await api("commerce.assurance.scan",{
            plan_id:S.plan.id},true);
        notify("Снимок сохранён: "+result.snapshot.findings.length+" замечаний.");
        await refresh();
    }catch(error){notify(error.message);}
}
async function acknowledge(finding){
    if(!S.plan||!S.latest?.exists)return;
    const reason=window.prompt("Почему замечание рассмотрено? Не утверждайте, что оно исправлено без новой проверки:");
    if(reason===null)return;
    try{
        await api("commerce.assurance.acknowledge",{
            plan_id:S.plan.id,scan_id:S.latest.scan_id,
            finding_id:finding.id,reason
        },true);
        notify("Рассмотрение зафиксировано. Проблема не скрыта.");
        await refresh();
    }catch(error){notify(error.message);}
}
function renderBaselineSelect(){
    const select=$("baselineSelect");select.replaceChildren();
    if(!S.forecasts?.items.length){
        const option=node("option","","Прогнозы ещё не зафиксированы");option.value="";
        select.append(option);$("baselineHint").textContent="Сначала зафиксируйте сценарий M205.";
        return;
    }
    for(const f of S.forecasts.items){
        const opt=node("option","",datetime(f.captured_at)+
            " · "+f.scenario_rate_bp/100+"% · "+
            f.active_observations+" наблюд.");opt.value=f.baseline_id;
        select.append(opt);
    }
    select.value=S.baseline;
    const item=S.forecasts.items.find(x=>x.baseline_id===S.baseline);
    $("baselineHint").textContent="Сценарий "+item.scenario_rate_bp/100+
        "% · "+item.horizon_months+" месяцев · исходный хеш "+item.payload_hash.slice(0,16)+"…";
    const month=$("monthSelect");month.replaceChildren();
    for(let k=1;k<=item.horizon_months;k++){
        const opt=node("option","",String(k));opt.value=String(k);month.append(opt);
    }
}
async function changeBaseline(){
    S.baseline=$("baselineSelect").value||null;
    renderBaselineSelect();await loadBacktest(S.sequence);
}
async function freeze(e){
    e.preventDefault();if(!S.plan)return;
    try{
        const result=await api("commerce.forecast.freeze",{
            plan_id:S.plan.id,
            cost_basis:$("costBasis").value,
            recurring_basis:$("recurringBasis").value,
            horizon_months:number("horizon",1,36),
            realization_rates_bp:["rateLow","rateMid","rateHigh"].map(x=>number(x,0,100)*100),
            scenario_index:number("scenarioIndex",0,2),
            require_reconciled_costs:$("requireReconciled").checked,
            assume_zero_recurring:$("assumeZero").checked,
            rationale:$("forecastRationale").value
        },true);
        notify("Прогноз зафиксирован неизменяемым снимком.");
        await refresh();
        S.baseline=result.baseline_id;
        renderBaselineSelect();
        await loadBacktest(S.sequence);
    }catch(error){notify(error.message);}
}
async function observation(e){
    e.preventDefault();
    if(!S.baseline){notify("Сначала выберите зафиксированный прогноз");return;}
    try{
        const result=await api("commerce.forecast.observation.add",{
            baseline_id:S.baseline,
            month_index:number("monthSelect",1,36),
            reported_gross_minor:minor($("reportedGross").value),
            reported_operating_minor:minor($("reportedOperating").value),
            reference:$("observationReference").value,
            evidence_note:$("observationEvidence").value
        },true);
        notify("Ручное наблюдение сохранено. Банковской проверки нет.");
        $("reportedGross").value="";$("reportedOperating").value="";
        $("observationReference").value="";$("observationEvidence").value="";
        await refresh();
    }catch(error){notify(error.message);}
}
async function loadBacktest(sequence){
    if(!S.baseline){
        S.backtest=null;
        $("qualityStatus").textContent="Пока нет зафиксированного прогноза.";
        $("qualityStats").replaceChildren();$("monthRows").replaceChildren();
        return;
    }
    const baselineId=S.baseline;
    try{
        const result=await api("commerce.forecast.backtest",{
            baseline_id:baselineId
        });
        if(sequence!==S.sequence||S.baseline!==baselineId)return;
        S.backtest=result;renderBacktest();
    }catch(error){notify("Ошибка проверки прогноза: "+error.message);}
}
function renderBacktest(){
    const r=S.backtest;if(!r)return;
    $("qualityStatus").textContent="Ручные наблюдения "+r.observed_months+
        " из "+r.horizon_months+
        " · изменившиеся исходные источники: "+r.sources_changed_since_freeze.length+
        ". Старый прогноз не пересчитывался.";
    const stats=$("qualityStats");stats.replaceChildren();
    const values=[
        ["Покрытие",r.coverage_bp/100+"%"],
        ["Средняя абсолютная ошибка",money(r.mean_absolute_error_minor)],
        ["Средняя систематическая ошибка",money(r.mean_signed_error_minor)],
        ["Без наблюдений",String(r.missing_months)]
    ];
    for(const [label,value] of values){
        const box=node("div");box.append(node("span","",label),
                                      node("strong","",value));
        stats.append(box);
    }
    const list=$("monthRows");list.replaceChildren();
    if(!r.months.length){list.append(node("p","muted","Нет месяцев для отображения."));return;}
    const wrap=node("div","table-wrap");
    const table=node("table","data-table");
    const head=node("tr");
    for(const txt of ["Месяц","Ожидание (чистый поток)","Ручной отчёт","Ошибка","Состояние"])
        head.append(node("th","",txt));
    const thead=node("thead");thead.append(head);table.append(thead);
    const body=node("tbody");
    for(const m of r.months){
        const row=node("tr");
        for(const v of [
            String(m.month),
            money(m.predicted_net_minor),
            money(m.reported_net_minor),
            money(m.error_minor),
            m.status==="OWNER_REPORTED_NOT_VERIFIED"?"Заявлено вручную":"Нет наблюдения"
        ])row.append(node("td","",v));
        body.append(row);
    }
    table.append(body);wrap.append(table);list.append(wrap);
}
function renderPortfolio(){
    const list=$("portfolio");list.replaceChildren();
    if(!S.portfolio?.items.length){
        list.append(node("p","muted","Планов нет. Создайте финансовое решение M203."));
        return;
    }
    for(const item of S.portfolio.items){
        const description=item.scan_status==="NOT_SCANNED"?
            "Диагностика не выполнялась — состояние неизвестно":
            "Предупреждений "+item.warning_count+
            " · вопросов на рассмотрение "+item.review_count+
            " · прочитано, не исправлено "+item.acknowledged_not_resolved;
        const line=entryRow(item.title,
            description+" · зафиксированных прогнозов "+item.frozen_baselines,
            item.scan_status==="NOT_SCANNED"?"Не проверено":"Локальный снимок",
            item.scan_status==="NOT_SCANNED"?"warning":"good");
        list.append(line.root);
    }
}
function download(filename,body,mime){
    const url=URL.createObjectURL(new Blob([body],{type:mime}));
    const a=node("a");a.href=url;a.download=filename;
    document.body.append(a);a.click();a.remove();
    setTimeout(()=>URL.revokeObjectURL(url),1000);
}
async function exportCSV(){
    try{
        const r=await api("commerce.assurance.portfolio.csv");
        download(r.filename,r.content,r.mime);
        notify("Экспортировано планов: "+r.rows+". Нет банковской верификации.");
    }catch(error){notify(error.message);}
}
async function exportPacket(){
    if(!S.plan){notify("Сначала выберите план");return;}
    try{
        const r=await api("commerce.assurance.packet",{
            plan_id:S.plan.id
        });
        download("osgard-m206-"+S.plan.id.slice(0,12)+".json",
            JSON.stringify(r,null,2),"application/json; charset=utf-8");
        notify("Пакет локальных доказательств создан. SHA не является внешней подписью.");
    }catch(error){notify(error.message);}
}
$("loginForm").onsubmit=login;
$("logout").onclick=logout;$("refresh").onclick=refresh;
$("planSelect").onchange=selectPlan;$("runScan").onclick=runScan;
$("forecastForm").onsubmit=freeze;$("baselineSelect").onchange=changeBaseline;
$("observationForm").onsubmit=observation;
$("reloadPortfolio").onclick=refresh;$("csv").onclick=exportCSV;
$("packet").onclick=exportPacket;
