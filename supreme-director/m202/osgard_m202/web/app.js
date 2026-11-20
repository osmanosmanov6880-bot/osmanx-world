"use strict";
/* OSGARD M202. All responses rendered as text, never as HTML. Owner only. */
const S={token:"",session:null,schedule:null,policy:null,report:null,snapshots:[],generation:0};
const $=id=>document.getElementById(id);
const el=(tag,cls,text)=>{const x=document.createElement(tag);if(cls)x.className=cls;if(text!==undefined)x.textContent=String(text);return x;};
const money=v=>v==null?"—":new Intl.NumberFormat("ru-RU",{style:"currency",currency:"RUB"}).format(v/100);
const time=t=>t==null?"Не назначено":new Date(t*1000).toLocaleString("ru-RU",{dateStyle:"short",timeStyle:"short",timeZone:"UTC"})+" UTC";
const newKey=()=>"m202-"+crypto.randomUUID();
function flash(message){const t=$("toast");t.textContent=message;t.hidden=false;clearTimeout(flash.timer);flash.timer=setTimeout(()=>t.hidden=true,5000);}
async function api(operation,payload={},write=false){
    if(!S.token)throw Error("Требуется авторизация");
    const res=await fetch("/v1/execute",{method:"POST",cache:"no-store",headers:{"Content-Type":"application/json","Authorization":"Bearer "+S.token},body:JSON.stringify({operation,payload,idempotency_key:write?newKey():null})});
    const data=await res.json();
    if(!res.ok||!data.ok){const error=new Error(data.message||data.error||"Ошибка запроса");error.status=res.status;throw error;}
    return data.result;
}
async function login(e){
    e.preventDefault();S.token=$("token").value;$("loginError").textContent="";
    try{S.session=await api("titan.session.get");
        if(S.session.role!=="owner")throw Error("Центр мониторинга доступен только владельцу организации");
        $("login").hidden=true;$("shell").hidden=false;$("actor").textContent=S.session.actor+" · владелец";
        $("token").value="";await refresh();
    }catch(e){S.token="";$("loginError").textContent=e.message;}
}
function logout(){S.generation++;S.session=null;S.schedule=null;S.policy=null;S.token="";$("token").value="";$("login").hidden=false;$("shell").hidden=true;}
async function refresh(){
    const epoch=++S.generation;
    try{
        const [schedule,policy,report,history]=await Promise.all([
          api("commerce.monitor.schedule.get"),
          api("commerce.alerts.policy.get"),
          api("commerce.monitor.report"),
          api("commerce.monitor.snapshots.list",{limit:60})
        ]);
        if(epoch!==S.generation)return;
        S.schedule=schedule;S.policy=policy;S.report=report;S.snapshots=history.snapshots;
        renderSchedule();renderOverview(report);renderHistory(history);renderReport(report);renderSla(report.sla);
    }catch(e){flash("Не удалось обновить данные: "+e.message);}
}
function renderSchedule(){
    const x=S.schedule;
    $("scheduleBadge").textContent=x.enabled?"Расписание включено":x.exists?"Приостановлено":"Не настроено";
    $("runInfo").textContent=x.enabled?"Следующая проверка: "+time(x.next_due_at):"Задания не выполняются автоматически";
    $("statNext").textContent=x.enabled?time(x.next_due_at):"Выключено";
    $("enabled").checked=!!x.enabled;
    if(x.exists){
        $("interval").value=String(x.interval_seconds);
        $("ackHours").value=String(x.ack_sla_seconds/3600);
        $("resolveHours").value=String(x.resolve_sla_seconds/3600);
    }
}
function renderOverview(report){
    $("statActive").textContent=(report.alert_counts.open||0)+(report.alert_counts.acknowledged||0);
    $("statSla").textContent=report.sla?.live_breaches_count??"—";
    $("statSnaps").textContent=report.snapshots_total;
}
async function saveSchedule(e){
    e.preventDefault();
    if(!S.policy?.exists){flash("Сначала создайте финансовую политику в разделе «Риски M201»");return;}
    const interval=Number($("interval").value),ack=Number($("ackHours").value),resolve=Number($("resolveHours").value);
    if(!Number.isInteger(ack)||!Number.isInteger(resolve)||ack<1||resolve<ack){flash("Укажите корректные сроки реакции и решения");return;}
    try{
        const data=await api("commerce.monitor.schedule.set",{
           expected_version:S.schedule.version,enabled:$("enabled").checked,
           interval_seconds:interval,ack_sla_seconds:ack*3600,
           resolve_sla_seconds:resolve*3600
        },true);
        flash("Настройки сохранены. Для выполнения по расписанию подключите CLI к системному планировщику.");
        S.schedule=data;await refresh();
    }catch(error){flash(error.status===409?"Данные изменились в другой вкладке. Обновите страницу.":error.message);}
}
async function doDue(){
    if(!S.schedule?.exists){flash("Сначала настройте расписание");return;}
    const button=$("runDue");button.disabled=true;
    try{
        const r=await api("commerce.monitor.schedule.run_due",{
            expected_schedule_version:S.schedule.version},true);
        flash(r.status==="EXECUTED"?"Проверка по расписанию выполнена":r.status==="NOT_DUE"?"Срок ещё не наступил":"Расписание выключено");
        await refresh();
    }catch(error){flash(error.message);}finally{button.disabled=false;}
}
async function manualScan(){
    if(!S.policy?.exists){flash("Сначала создайте финансовую политику M201");return;}
    try{
        const result=await api("commerce.monitor.scan",{
            expected_policy_version:S.policy.version},true);
        flash("Снимок сохранён. Новых предупреждений: "+result.alert_changes.created_count);
        await refresh();
    }catch(error){flash(error.message);}
}
function renderHistory(data){
    const root=$("snapshotList");root.replaceChildren();
    const old=$("previous"),latest=$("current");old.replaceChildren();latest.replaceChildren();
    if(!data.snapshots.length){root.append(el("p","muted","Проверки ещё не сохранялись."));return;}
    for(const snap of data.snapshots.slice().reverse().slice(0,24)){
        const c=el("div","snapshot");
        c.append(el("strong","",time(snap.created_at)),
                 el("small","",(snap.origin==="scheduled"?"По расписанию":"Вручную")+" · рисков: "+snap.active_rule_count),
                 el("small","","SHA-256: "+snap.chain_hash.slice(0,16)+"…"));
        root.append(c);
    }
    for(const s of data.snapshots){
        for(const x of [old,latest]){
            const opt=el("option","",time(s.created_at)+" · "+s.active_rule_count+" рисков");
            opt.value=s.id;x.append(opt);
        }
    }
    if(data.snapshots.length>1){
        old.value=data.snapshots[data.snapshots.length-2].id;
        latest.value=data.snapshots[data.snapshots.length-1].id;
    }
}
async function compare(){
    const a=$("previous").value,b=$("current").value;
    if(!a||!b){flash("Требуется минимум два снимка");return;}
    try{
        const data=await api("commerce.monitor.snapshots.compare",{
            previous_id:a,current_id:b});
        const root=$("compareOutput");root.replaceChildren();
        for(const item of data.deltas){
            const line=el("div","record"),name=el("div");
            name.append(el("strong","",item.rule),el("small","",(item.was_active?"Был риск":"Риска не было")+" → "+(item.is_active?"Есть риск":"Риск исчез")));
            const quantity=item.unit==="count"?String(item.delta):money(item.delta);
            line.append(name,el("strong",item.delta>0?"bad":item.delta<0?"good":"",quantity));root.append(line);
        }
    }catch(error){flash(error.message);}
}
function renderSla(sla){
    const root=$("slaList");root.replaceChildren();
    if(!sla){root.append(el("p","muted","Настройте сроки реакции, чтобы включить контроль SLA."));return;}
    if(!sla.items.length){root.append(el("p","muted","Исторических SLA-нарушений пока нет."));return;}
    for(const item of sla.items.slice(0,50)){
        const row=el("div","record"),left=el("div");
        left.append(el("strong","",item.kind),el("small","",(item.assignee||"Ответственный не назначен")+" · срок: "+time(item.deadline)));
        row.append(left,el("strong",item.live_breach?"bad":"good",item.state==="active"?"Требует реакции":"Завершено"));root.append(row);
    }
    if(sla.truncated)root.append(el("p","muted","Список ограничен; сводка вычислена по всей базе."));
}
async function refreshSla(){
    if(!S.schedule?.exists){flash("Сначала настройте контроль сроков");return;}
    try{
        const result=await api("commerce.monitor.sla.refresh",{},true);
        flash("Новых SLA-нарушений: "+result.created_count+" · снято: "+result.cleared.length);
        await refresh();
    }catch(error){flash(error.message);}
}
function renderReport(report){
    const root=$("reportArea");root.replaceChildren();
    const elements=[
        ["Новые предупреждения",String(report.alert_counts.open)],
        ["Ожидают действий",String(report.alert_counts.acknowledged)],
        ["Принятый владельцем риск",String(report.alert_counts.dismissed)],
        ["Сняты вследствие изменения показателей",String(report.alert_counts.cleared)],
        ["Последний снимок",time(report.last_persisted_snapshot?.created_at)],
        ["Банковская сверка",report.bank_verified?"Да":"Нет — только локальные сведения"]
    ];
    for(const [title,value] of elements){
        const row=el("div","record");row.append(el("span","muted",title),el("strong","",value));root.append(row);
    }
}
async function viewReport(){try{const result=await api("commerce.monitor.report");S.report=result;renderReport(result);renderOverview(result);flash("Отчёт сформирован из локальной SQLite");}catch(error){flash(error.message);}}
async function exportCsv(){
    try{
        const result=await api("commerce.monitor.report.csv");
        const blob=new Blob([result.content],{type:result.mime});
        const url=URL.createObjectURL(blob);
        try{
            const a=document.createElement("a");a.href=url;a.download=result.filename;
            document.body.append(a);a.click();a.remove();
        }finally{setTimeout(()=>URL.revokeObjectURL(url),1000);}
        flash("Экспортировано записей: "+result.rows);
    }catch(error){flash(error.message);}
}
$("loginForm").onsubmit=login;$("logout").onclick=logout;$("refresh").onclick=refresh;
$("scheduleForm").onsubmit=saveSchedule;$("runDue").onclick=doDue;
$("manualScan").onclick=manualScan;$("loadHistory").onclick=refresh;
$("compare").onclick=compare;$("refreshSla").onclick=refreshSla;
$("viewReport").onclick=viewReport;$("exportCsv").onclick=exportCsv;
