"use strict";
/* M204 premium Russian local-only studio. Never persist tokens or inject HTML. */
const S={token:"",identity:null,plans:[],portfolio:null,board:null,
    plan:null,ledger:null,epoch:0};
const $=id=>document.getElementById(id);
const node=(tag,cls,value)=>{const x=document.createElement(tag);if(cls)x.className=cls;if(value!==undefined)x.textContent=String(value);return x;};
const money=minor=>minor==null?"—":new Intl.NumberFormat("ru-RU",
    {style:"currency",currency:"RUB"}).format(minor/100);
const date=t=>t==null?"Неизвестно":new Date(t*1000).toLocaleString("ru-RU",
    {dateStyle:"short",timeStyle:"short",timeZone:"UTC"})+" UTC";
const label={
    cost_planned:"Плановые затраты",
    cost_incurred:"Заявленные понесённые затраты",
    benefit_forecast_monthly:"Прогнозируемая ежемесячная выгода",
    benefit_reported_once:"Заявленная разовая выгода"
};
const status={
    draft:"Черновик",active:"В работе",
    model_reviewed:"Принята модельная оценка",cancelled:"Отменён"
};
function toast(text){const e=$("toast");e.textContent=String(text);e.hidden=false;
    clearTimeout(toast.timer);toast.timer=setTimeout(()=>e.hidden=true,4700);}
function key(){return "m204-"+crypto.randomUUID();}
function rubles(input){
    const text=String(input).trim().replace(",",".");
    if(!/^\d{1,11}(?:\.\d{1,2})?$/.test(text))
        throw Error("Введите положительную сумму в рублях (не более двух знаков после запятой)");
    const [whole,frac=""]=text.split(".");
    const result=BigInt(whole)*100n+BigInt((frac+"00").slice(0,2));
    if(result<1n||result>1000000000000n)
        throw Error("Сумма в копейках должна быть от 1 до 10¹²");
    return Number(result);
}
function rateValue(id){
    const value=Number($(id).value);
    if(!Number.isInteger(value)||value<0||value>100)
        throw Error("Коэффициент реализации должен быть целым числом от 0 до 100");
    return value*100;
}
function choice(select,field,value,text){
    const option=node("option","",text);option.value=value;select.append(option);
}
async function api(operation,payload={},write=false){
    if(!S.token)throw Error("Нет токена доступа");
    const response=await fetch("/v1/execute",{method:"POST",cache:"no-store",
        headers:{"Content-Type":"application/json","Authorization":"Bearer "+S.token},
        body:JSON.stringify({operation,payload,idempotency_key:write?key():null})});
    const data=await response.json();
    if(!response.ok||!data.ok){
        const error=new Error(data.message||data.error||"Неизвестная серверная ошибка");
        error.status=response.status;throw error;
    }
    return data.result;
}
async function login(e){
    e.preventDefault();S.token=$("token").value;$("loginError").textContent="";
    try{
        S.identity=await api("titan.session.get");
        if(S.identity.role!=="owner")
            throw Error("Экономические данные доступны только владельцу организации");
        $("login").hidden=true;$("shell").hidden=false;$("token").value="";
        $("actor").textContent=S.identity.actor+" · владелец";
        await refresh();
    }catch(error){
        S.token="";S.identity=null;$("loginError").textContent=error.message;
    }
}
function logout(){
    S.epoch++;S.token="";S.identity=null;S.plans=[];S.portfolio=null;
    S.board=null;S.plan=null;S.ledger=null;
    $("login").hidden=false;$("shell").hidden=true;$("token").value="";
}
async function refresh(){
    const current=++S.epoch;
    try{
        const [plans,portfolio,board]=await Promise.all([
            api("commerce.actions.list",{limit:200}),
            api("commerce.economics.portfolio"),
            api("commerce.economics.priority.board",{limit:200,include_closed:true})
        ]);
        if(current!==S.epoch)return;
        S.plans=plans.items;S.portfolio=portfolio;S.board=board;
        const before=S.plan?.id;
        S.plan=S.plans.find(x=>x.id===before)||S.plans[0]||null;
        renderStats();renderPlans();renderBoard();
        await loadLedger(current);
    }catch(error){toast(error.message);}
}
function renderStats(){
    const x=S.portfolio;
    $("statPlans").textContent=x?.plans_total??"—";
    const all=x?.totals_cover_entire_tenant;
    $("statPlanned").textContent=all?money(x.cost_planned_minor):"Не весь портфель";
    $("statIncurred").textContent=all?money(x.cost_incurred_minor):"Не весь портфель";
    $("statBenefit").textContent=all?money(x.forecast_monthly_minor):"Не весь портфель";
}
function renderPlans(){
    const field=$("planSelect");field.replaceChildren();
    if(!S.plans.length){
        choice(field,"","", "Планы отсутствуют — создайте их в M203");
        $("planPanels").hidden=true;
        $("planDetail").textContent="Нет планов финансовых решений.";
        return;
    }
    $("planPanels").hidden=false;
    for(const p of S.plans)choice(field,"",p.id,p.title+" · "+(status[p.status]||p.status));
    field.value=S.plan.id;
    $("planDetail").textContent="Риск "+S.plan.rule+
        " · версия "+S.plan.version+" · "+(status[S.plan.status]||S.plan.status)+
        " · до "+date(S.plan.due_at);
}
async function choosePlan(){
    S.plan=S.plans.find(x=>x.id===$("planSelect").value)||null;
    S.ledger=null;
    renderPlans();
    await loadLedger(S.epoch);
}
async function loadLedger(epoch){
    if(!S.plan){$("entries").replaceChildren(node("p","muted","Планы отсутствуют."));return;}
    try{
        const result=await api("commerce.economics.ledger",{
            plan_id:S.plan.id,limit:200
        });
        if(epoch!==S.epoch||!S.plan||result.plan_id!==S.plan.id)return;
        S.ledger=result;renderLedger();renderCurrentPriority();
        $("kind").dispatchEvent(new Event("change"));
    }catch(e){toast(e.message);}
}
function formatEvidence(x){
    return x.kind==="benefit_forecast_monthly"?
        "Прогноз / месяц" : x.kind==="benefit_reported_once"?
        "Заявлено вручную, не подтверждено банком":"Введено вручную";
}
function renderLedger(){
    const root=$("entries");root.replaceChildren();
    if(!S.ledger)return;
    if(!S.ledger.items.length){
        root.append(node("p","muted","Записей пока нет. Плановая стоимость ≠ фактическая."));
        return;
    }
    for(const record of S.ledger.items){
        const row=node("div","record");
        const info=node("div","record-info");
        info.append(node("strong","",record.title),
            node("small","",label[record.kind]+" · "+formatEvidence(record)+" · "+date(record.created_at)),
            node("small","",record.evidence_note+
                (record.reference?" · основание: "+record.reference:"")));
        const actions=node("div","record-actions");
        actions.append(node("strong","",money(record.amount_minor)));
        if(record.state==="active"){
            const b=node("button","","Отменить");b.type="button";
            b.onclick=()=>voidEntry(record);
            actions.append(b);
        }else{
            actions.append(node("span","muted small","Отменена: "+record.void_reason));
        }
        row.append(info,actions);root.append(row);
    }
    if(S.ledger.truncated)
        root.append(node("p","muted","Показаны первые 200 записей; сводка рассчитана по всем."));
}
async function addEntry(e){
    e.preventDefault();if(!S.plan)return;
    const kind=$("kind").value;
    const body={
        plan_id:S.plan.id,kind,
        title:$("entryTitle").value,
        evidence_note:$("evidence").value,
        amount_minor:rubles($("amount").value)
    };
    if($("reference").value.trim())body.reference=$("reference").value.trim();
    if(kind==="benefit_reported_once"){
        if(!S.plan.latest_evaluation_id){toast("Нет принятого результата M203.");return;}
        body.evaluation_id=S.plan.latest_evaluation_id;
    }
    try{
        await api("commerce.economics.entry.add",body,true);
        $("amount").value="";$("entryTitle").value="";$("evidence").value="";
        $("reference").value="";
        toast("Запись сохранена; независимая проверка не проводилась.");
        await refresh();
    }catch(error){toast(error.message);}
}
async function voidEntry(row){
    const reason=window.prompt("Причина отмены экономической записи:");
    if(reason===null)return;
    try{
        await api("commerce.economics.entry.void",{
            entry_id:row.id,expected_version:row.version,reason},true);
        toast("Запись отменена. История осталась в журнале.");
        await refresh();
    }catch(error){toast(error.message);}
}
function renderScenarios(result){
    const root=$("scenarios");root.replaceChildren();
    for(const scenario of result.projected_scenarios){
        const card=node("div","scenario-card");
        card.append(node("h3","",scenario.realization_rate_bp/100+"% реализации"),
                    node("span","amount",
                        scenario.projected_roi_bp===null?"Недостаточно данных":
                        (scenario.projected_roi_bp/100).toFixed(2)+"% ROI"),
                    node("p","",scenario.projected_payback_months===null?
                        "Срок окупаемости не рассчитан":
                        "Модельный срок окупаемости: "+scenario.projected_payback_months+" мес."),
                    node("p","",scenario.projected_benefit_horizon_minor===null?
                        "Выбранная база стоимости или прогноз выгоды отсутствует":
                        "Прогноз выгоды за период: "+money(scenario.projected_benefit_horizon_minor)),
                    node("span","note",scenario.status));
        root.append(card);
    }
    const actual=result.self_reported_return;
    root.append(node("p","muted small",
        actual.claimed_roi_bp===null?
            "Заявленную окупаемость нельзя рассчитать: нет понесённых затрат или заявленной разовой выгоды.":
            "Отдельная ЗАЯВЛЕННАЯ окупаемость (без проверки банка): "+(actual.claimed_roi_bp/100).toFixed(2)+"%."
    ));
}
async function calculate(e){
    e.preventDefault();if(!S.plan)return;
    try{
        const rates=[rateValue("rate1"),rateValue("rate2"),rateValue("rate3")];
        const months=Number($("horizon").value);
        const result=await api("commerce.economics.scenarios",{
            plan_id:S.plan.id,cost_basis:$("costBasis").value,
            horizon_months:months,realization_rates_bp:rates
        });
        renderScenarios(result);
        toast("Расчёт построен только по ручным допущениям.");
    }catch(error){toast(error.message);}
}
function setRatings(){
    for(const id of ("urgency","impact","confidence","effort")){
        const box=$(id);box.replaceChildren();
        for(let v=1;v<=5;v++)choice(box,"",String(v),String(v));
        box.value="3";
    }
}
function renderCurrentPriority(){
    const row=S.board?.items.find(x=>x.plan_id===S.plan?.id);
    const p=row?.priority;
    if(p){
        for(const id of ("urgency","impact","confidence","effort"))
            $(id).value=String(p[id]);
        $("rationale").value=p.rationale;
    }else{
        for(const id of ("urgency","impact","confidence","effort"))
            $(id).value="3";
        $("rationale").value="";
    }
}
async function savePriority(e){
    e.preventDefault();if(!S.plan)return;
    const item=S.board?.items.find(x=>x.plan_id===S.plan.id);
    const p=item?.priority;
    try{
        const result=await api("commerce.economics.priority.set",{
            plan_id:S.plan.id,expected_version:p?.version||0,
            urgency:Number($("urgency").value),
            impact:Number($("impact").value),
            confidence:Number($("confidence").value),
            effort:Number($("effort").value),
            rationale:$("rationale").value},true);
        toast("Оценка сохранена: "+(result.score_x100/100).toFixed(2)+" субъективных балла.");
        await refresh();
    }catch(error){toast(error.message);}
}
function renderBoard(){
    const root=$("board");root.replaceChildren();
    const board=S.board;
    if(!board||!board.items.length){
        root.append(node("p","muted","Планов пока нет."));return;
    }
    for(const item of board.items){
        const row=node("div","record"),left=node("div","record-info");
        const rank=item.rank?"№"+item.rank:"Без ранга";
        left.append(node("strong","",rank+" · "+item.title),
                    node("small","",item.rule+" · "+(status[item.status]||item.status)+
                         " · "+(item.manual_score_x100==null?
                              "Оценка не задана":
                              "баллы "+(item.manual_score_x100/100).toFixed(2))),
                    node("small","","Смета "+(item.projected_cost_basis_available?"есть":"нет")+
                        " · прогноз выгоды "+(item.monthly_benefit_forecast_available?"есть":"нет")+
                        " · данные без независимой проверки"));
        const right=node("div","record-actions");
        const b=node("button","","Открыть");b.type="button";
        b.onclick=async()=>{
            S.plan=S.plans.find(x=>x.id===item.plan_id)||null;
            renderPlans();await loadLedger(S.epoch);
            document.getElementById("planSelect").scrollIntoView({behavior:"smooth",block:"center"});
        };
        right.append(b);row.append(left,right);root.append(row);
    }
    if(board.truncated)root.append(node("p","muted","Показано не более "+board.items.length+" планов."));
}
async function exportBoard(){
    try{
        const result=await api("commerce.economics.portfolio.csv");
        const uri=URL.createObjectURL(new Blob([result.content],{type:result.mime}));
        const a=node("a");a.href=uri;a.download=result.filename;document.body.append(a);
        a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(uri),1000);
        toast("Сохранено "+result.rows+" планов без банковской верификации.");
    }catch(error){toast(error.message);}
}
$("loginForm").onsubmit=login;$("logout").onclick=logout;$("refresh").onclick=refresh;
$("planSelect").onchange=choosePlan;$("entryForm").onsubmit=addEntry;
$("scenarioForm").onsubmit=calculate;$("priorityForm").onsubmit=savePriority;
$("reloadBoard").onclick=refresh;$("export").onclick=exportBoard;
$("kind").onchange=()=>{
    const selected=$("kind").value;
    $("reportedWarning").hidden=selected!=="benefit_reported_once";
};
setRatings();
