"use strict";
/* OSGARD M205 - actual local APIs; no token persistence or HTML injection. */
const S={token:"",identity:null,plans:[],plan:null,portfolio:null,
    inspection:null,recurring:null,economic:null,sequence:0};
const $=id=>document.getElementById(id);
const el=(tag,cls,text)=>{const x=document.createElement(tag);if(cls)x.className=cls;if(text!==undefined)x.textContent=String(text);return x;};
const rub=value=>value==null?"—":new Intl.NumberFormat("ru-RU",{style:"currency",currency:"RUB"}).format(value/100);
const when=t=>t==null?"—":new Date(t*1000).toLocaleString("ru-RU",{timeZone:"UTC",dateStyle:"short",timeStyle:"short"})+" UTC";
const statuses={draft:"Черновик",active:"В работе",model_reviewed:"Принят результат модели",cancelled:"Отменён"};
const linkStatuses={
    MATCHED_LOCAL_RECORDS:"Совпало с M198",
    SOURCE_MISSING:"Источник M198 отсутствует",
    SOURCE_VOIDED:"Исходный расход отменён",
    SOURCE_VERSION_CHANGED:"Расход M198 изменён",
    AMOUNT_OR_KIND_CHANGED:"Изменена сумма или категория",
    UNLINKED:"Связь снята"
};
const modelStatuses={
    PROJECTED_MANUAL_NET_ROI:"Сценарный расчёт выполнен",
    SOURCE_LINK_DRIFT_REQUIRES_REVIEW:"Устаревшая связь с M198 — перепроверьте источник",
    COST_RECONCILIATION_INCOMPLETE:"Не все разовые затраты сопоставлены с M198",
    MISSING_ONE_OFF_COST_BASIS:"Отсутствуют разовые затраты выбранной категории",
    MISSING_MONTHLY_BENEFIT_FORECAST:"Не задана ежемесячная гипотеза выгоды",
    MISSING_RECURRING_COST_ASSUMPTION:"Добавьте регулярные затраты или явно подтвердите допущение об их отсутствии"
};
function flash(msg){const x=$("toast");x.textContent=String(msg);x.hidden=false;
    clearTimeout(flash.timer);flash.timer=setTimeout(()=>x.hidden=true,5100);}
function idempotency(){return "m205-"+crypto.randomUUID();}
function positiveRubles(input){
    const v=String(input).trim().replace(",",".");
    if(!/^\d{1,11}(?:\.\d{1,2})?$/.test(v))throw Error("Введите сумму в рублях: максимум два знака после запятой");
    const [whole,frac=""]=v.split(".");
    const minor=BigInt(whole)*100n+BigInt((frac+"00").slice(0,2));
    if(minor<1n||minor>1000000000000n)throw Error("Сумма должна составлять от 1 до 10¹² копеек");
    return Number(minor);
}
function integer(id,lo,hi){
    const value=Number($(id).value);
    if(!Number.isInteger(value)||value<lo||value>hi)
        throw Error(id+": ожидается целое число от "+lo+" до "+hi);
    return value;
}
async function api(op,payload={},writing=false){
    if(!S.token)throw Error("Требуется токен доступа");
    const response=await fetch("/v1/execute",{
        method:"POST",cache:"no-store",
        headers:{"Content-Type":"application/json","Authorization":"Bearer "+S.token},
        body:JSON.stringify({operation:op,payload,
            idempotency_key:writing?idempotency():null})
    });
    const body=await response.json();
    if(!response.ok||!body.ok){
        const error=new Error(body.message||body.error||"Запрос отклонён");
        error.status=response.status;throw error;
    }
    return body.result;
}
async function logIn(e){
    e.preventDefault();$("loginError").textContent="";
    S.token=$("token").value;
    try{
        S.identity=await api("titan.session.get");
        if(S.identity.role!=="owner")throw Error("Экономический контроль доступен только владельцу");
        $("login").hidden=true;$("shell").hidden=false;
        $("actor").textContent=S.identity.actor+" · владелец";
        $("token").value="";
        await refresh();
    }catch(error){S.identity=null;S.token="";$("loginError").textContent=error.message;}
}
function logOut(){
    S.sequence++;S.token="";S.identity=null;S.plan=null;S.plans=[];
    S.portfolio=null;S.inspection=null;S.recurring=null;S.economic=null;
    $("login").hidden=false;$("shell").hidden=true;$("token").value="";
}
function row(title,details,tag,tagClass){
    const x=el("div","record"),left=el("div");
    left.append(el("strong","",title),el("small","",details));
    const right=el("div","right");
    if(tag!==undefined)right.append(el("strong",tagClass||"",tag));
    x.append(left,right);
    return {root:x,right};
}
async function refresh(){
    const current=++S.sequence;
    try{
        const [actions,portfolio]=await Promise.all([
            api("commerce.actions.list",{limit:200}),
            api("commerce.reconcile.portfolio")
        ]);
        if(current!==S.sequence)return;
        const original=S.plan?.id;
        S.plans=actions.items;S.portfolio=portfolio;
        S.plan=S.plans.find(p=>p.id===original)||S.plans[0]||null;
        renderOverview();renderPlans();renderPortfolio();
        await loadSelected(current);
    }catch(error){flash("Ошибка загрузки: "+error.message);}
}
function renderOverview(){
    const r=S.portfolio;
    $("metricPlans").textContent=r?.plans_total??"—";
    $("metricLinked").textContent=r?.totals?.active_links??"—";
    $("metricStale").textContent=r?.totals?.stale_links??"—";
    $("metricMissing").textContent=r?.totals?.unlinked_manual_cost_entries??"—";
}
function renderPlans(){
    const select=$("planSelect");select.replaceChildren();
    if(!S.plans.length){
        const empty=el("option","","Планы не найдены — создайте в M203");empty.value="";
        select.append(empty);$("planInfo").textContent="Нет выбранного плана";
        $("planArea").hidden=true;return;
    }
    $("planArea").hidden=false;
    for(const p of S.plans){
        const opt=el("option","",p.title+" · "+(statuses[p.status]||p.status));
        opt.value=p.id;select.append(opt);
    }
    select.value=S.plan.id;
    $("planInfo").textContent="Риск "+S.plan.rule+" · "+
       (statuses[S.plan.status]||S.plan.status)+" · срок "+when(S.plan.due_at);
}
async function choosePlan(){
    S.sequence++;
    S.plan=S.plans.find(x=>x.id===$("planSelect").value)||null;
    S.inspection=null;S.recurring=null;S.economic=null;
    renderPlans();
    await loadSelected(S.sequence);
}
async function loadSelected(current){
    const selected=S.plan?.id;
    if(!selected)return;
    try{
        const [inspection,recurring,economic]=await Promise.all([
            api("commerce.reconcile.inspect",{plan_id:selected,limit:200}),
            api("commerce.recurring.list",{plan_id:selected,limit:200}),
            api("commerce.economics.ledger",{plan_id:selected,limit:500})
        ]);
        if(current!==S.sequence||selected!==S.plan?.id)return;
        S.inspection=inspection;S.recurring=recurring;S.economic=economic;
        renderInspection();renderRecurring();
        $("scenarioCards").replaceChildren(el("p","muted",
            "Расчёт строится по отдельному запросу, выбранные допущения не сохраняются."));
        $("scenarioDetails").replaceChildren();
    }catch(error){flash("Не удалось проверить план: "+error.message);}
}
function renderInspection(){
    const r=S.inspection;if(!r)return;
    const planned=r.basis.cost_planned,incurred=r.basis.cost_incurred;
    $("plannedMatching").textContent=planned.linked_valid_count+"/"+planned.entry_count+
        (planned.stale_link_count?" · устарело "+planned.stale_link_count:"");
    $("incurredMatching").textContent=incurred.linked_valid_count+"/"+incurred.entry_count+
        (incurred.stale_link_count?" · устарело "+incurred.stale_link_count:"");
    const list=$("links");list.replaceChildren();
    if(!r.links.length)list.append(el("p","muted","Пока нет подтверждённых связей."));
    for(const item of r.links){
        const status=linkStatuses[item.match_status]||item.match_status;
        const display=row("Расход M198 · "+item.expense_id.slice(0,10)+"…",
            "Источник проекта "+item.project_id.slice(0,10)+"… · "+
            (item.cost_kind==="cost_planned"?"план":"заявленная оплата")+
            " · "+rub(item.amount_minor),
            status,item.match_status==="MATCHED_LOCAL_RECORDS"?"good":"warn");
        if(item.state==="active"){
            const b=el("button","","Снять связь");b.type="button";
            b.onclick=()=>unlink(item);display.right.append(b);
        }
        list.append(display.root);
    }
    const candidates=$("candidates");candidates.replaceChildren();
    if(!r.candidate_groups.length)
        candidates.append(el("p","muted","Не обнаружено подходящих кандидатов среди непривязанных расходов. Это не означает, что все суммы проверены."));
    for(const g of r.candidate_groups){
        const econ=S.economic?.items.find(e=>e.id===g.economic_entry_id);
        if(!econ)continue;
        for(const source of g.potential_matches){
            const x=row(econ.title+" · "+rub(econ.amount_minor),
                "M204 "+g.economic_entry_id.slice(0,10)+"… ↔ M198 "+
                    source.id.slice(0,10)+"… · версия M198 "+source.version,
                "Возможный источник");
            const b=el("button","","Подтвердить совпадение");b.type="button";
            b.onclick=()=>link(g.economic_entry_id,source);
            x.right.append(b);candidates.append(x.root);
        }
    }
    if(r.candidate_groups_truncated)
        candidates.append(el("p","muted","Показаны не все кандидаты; для полного аудита проверьте исходную базу."));
}
async function link(economicId,source){
    const econ=S.economic?.items.find(e=>e.id===economicId);
    if(!S.plan||!econ)return;
    if(!window.confirm("Подтвердить, что это ОДИН И ТОТ ЖЕ расход, учтённый в M198 и M204? Связь не подтверждает банк."))return;
    try{
        await api("commerce.reconcile.link",{
            plan_id:S.plan.id,economic_entry_id:economicId,
            project_id:source.project_id,expense_id:source.id,
            expected_economic_version:econ.version,
            expected_expense_version:source.version
        },true);
        flash("Расход сопоставлен. Сумма M198 не прибавлена к стоимости.");
        await refresh();
    }catch(error){flash(error.message);}
}
async function unlink(record){
    const reason=window.prompt("Почему требуется снять связь с расходом M198?");
    if(reason===null)return;
    try{
        await api("commerce.reconcile.unlink",{
            link_id:record.id,expected_version:record.version,reason
        },true);
        flash("Связь снята. Запись и история остались в системе.");
        await refresh();
    }catch(error){flash(error.message);}
}
function renderRecurring(){
    const list=$("recurringList");list.replaceChildren();
    if(!S.recurring?.items.length){
        list.append(el("p","muted","Регулярных затрат пока нет. Без отдельного подтверждения нулевой стоимости ROI не рассчитывается."));
        return;
    }
    for(const record of S.recurring.items){
        const name=record.title+" · "+(record.basis==="planned"?"план":"заявлено");
        const x=row(name,
            record.reference+" · месяцы "+record.start_month+"–"+record.end_month+
            " · "+record.evidence_note,
            record.state==="active"?rub(record.amount_minor)+"/мес.":"Отменено",
            record.state==="active"?"":"muted");
        if(record.state==="active"){
            const b=el("button","","Отменить");b.type="button";
            b.onclick=()=>voidRecurring(record);x.right.append(b);
        }
        list.append(x.root);
    }
}
async function addRecurring(e){
    e.preventDefault();if(!S.plan)return;
    try{
        await api("commerce.recurring.add",{
            plan_id:S.plan.id,basis:$("recurringBasis").value,
            title:$("recurringTitle").value,
            amount_minor:positiveRubles($("recurringAmount").value),
            start_month:integer("startMonth",1,36),
            end_month:integer("endMonth",1,36),
            evidence_note:$("recurringEvidence").value,
            reference:$("recurringRef").value
        },true);
        flash("Регулярный расход добавлен по заданным месяцам.");
        $("recurringAmount").value="";$("recurringTitle").value="";
        $("recurringRef").value="";$("recurringEvidence").value="";
        await refresh();
    }catch(error){flash(error.message);}
}
async function voidRecurring(record){
    const reason=window.prompt("Почему регулярный расход отменяется?");
    if(reason===null)return;
    try{
        await api("commerce.recurring.void",{
            recurring_id:record.id,expected_version:record.version,reason
        },true);
        flash("Расход исключён из будущих расчётов, история сохранена.");
        await refresh();
    }catch(error){flash(error.message);}
}
function percent(n){return n==null?"Не рассчитан":(n/100).toFixed(2)+"%";}
function showScenario(model){
    const root=$("scenarioCards");root.replaceChildren();
    const cases=model.scenarios;
    const titles=["Сдержанный","Базовый","Высокий"];
    cases.forEach((item,index)=>{
        const c=el("div","scenario");
        c.append(
            el("h3","",titles[index]+" · "+item.rate_bp/100+"%"),
            el("strong","value",percent(item.projected_roi_bp)),
            el("p","",modelStatuses[item.status]||item.status)
        );
        if(item.projected_roi_bp!==null){
            c.append(
                el("p","","Модельный остаток за период: "+rub(item.net_end_minor)),
                el("p","","Первый выход в ноль: "+
                    (item.payback_month==null?"не достигнут":item.payback_month+" мес.")),
                el("p","","Устойчивое возвращение: "+
                    (item.sustained_payback_month==null?"не достигнуто":item.sustained_payback_month+" мес."))
            );
        }
        root.append(c);
    });
    const details=$("scenarioDetails");details.replaceChildren();
    if(cases[1]?.months?.length){
        details.append(el("h3","","Помесячный расчёт базового сценария"));
        const wrap=el("div","table-wrap");
        const table=el("table","model-table"),header=el("tr");
        for(const cell of ["Месяц","Прогноз выгоды","Регулярные затраты","Чистый поток","Остаток после вложений"])
            header.append(el("th","",cell));
        const thead=el("thead");thead.append(header);table.append(thead);
        const tbody=el("tbody");
        for(const m of cases[1].months){
            const tr=el("tr");
            for(const value of [
                String(m.month),
                rub(m.projected_gross_benefit_minor),
                rub(m.operating_cost_minor),
                rub(m.projected_net_before_investment_minor),
                rub(m.cumulative_after_investment_minor)
            ])tr.append(el("td","",value));
            tbody.append(tr);
        }
        table.append(tbody);wrap.append(table);details.append(wrap);
    }
    details.append(el("p","muted small",
        "Формула использует одни разовые вложения M204; M198 служит только локальным источником сверки. Прогнозная выгода не считается установленной прибылью."));
}
async function calculate(e){
    e.preventDefault();if(!S.plan)return;
    try{
        const rates=["rateLow","rateMid","rateHigh"].map(id=>integer(id,0,100)*100);
        const result=await api("commerce.economics.net_scenarios",{
            plan_id:S.plan.id,
            cost_basis:$("investmentBasis").value,
            recurring_basis:$("operatingBasis").value,
            horizon_months:integer("horizon",1,36),
            realization_rates_bp:rates,
            require_reconciled_costs:$("requireMatch").checked,
            assume_zero_recurring:$("assumeZero").checked
        });
        showScenario(result);
        flash("Сценарии построены из локальных записей и ваших допущений.");
    }catch(error){flash(error.message);}
}
function renderPortfolio(){
    const container=$("portfolio");container.replaceChildren();
    if(!S.portfolio?.items.length){
        container.append(el("p","muted","В организации пока нет планов решений."));
        return;
    }
    for(const item of S.portfolio.items){
        const out=row(item.title,
            "Связей "+item.linked_costs_valid+
            " · устарело "+item.stale_source_links+
            " · не привязано "+item.manual_cost_entries_unlinked+
            " · регулярные плановые за 12 мес. "+rub(item.recurring_planned_12_month_minor)+
            " · заявленные "+rub(item.recurring_reported_12_month_minor),
            (item.stale_source_links>0?"Требует сверки":
                item.manual_cost_entries_unlinked>0?"Неполная сверка":"Проверено локально"),
            item.stale_source_links>0?"warn":"good");
        container.append(out.root);
    }
}
async function exportCsv(){
    try{
        const report=await api("commerce.reconcile.portfolio.csv");
        const url=URL.createObjectURL(new Blob([report.content],{type:report.mime}));
        const a=el("a");a.href=url;a.download=report.filename;document.body.append(a);
        a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);
        flash("Экспортировано "+report.rows+" планов. Все суммы отмечены как ручные.");
    }catch(error){flash(error.message);}
}
for(let m=1;m<=36;m++){
    for(const key of ("startMonth","endMonth")){
        const opt=el("option","",String(m));opt.value=String(m);$(key).append(opt);
    }
}
$("startMonth").value="1";$("endMonth").value="12";
$("loginForm").onsubmit=logIn;$("logout").onclick=logOut;
$("refresh").onclick=refresh;$("reloadPortfolio").onclick=refresh;
$("planSelect").onchange=choosePlan;
$("checkSources").onclick=refresh;
$("recurringForm").onsubmit=addRecurring;
$("scenarioForm").onsubmit=calculate;
$("exportCsv").onclick=exportCsv;
