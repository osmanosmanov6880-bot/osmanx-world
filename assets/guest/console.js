// OSMANX Guest Intelligence R4 — authenticated SAME-ORIGIN UI.
// No tokens, passwords, customer records, or personal data in local/session storage.
// No demo success states: all workspace data comes from authenticated PostgreSQL API.
const API='/api/industry/v1';
const $=id=>document.getElementById(id);
const flags=['repeatDefinition','sameWindow','independentGroups','marginVerified','contactConsent','ownerAgreed'];
const currencies=new Intl.NumberFormat('ru-RU',{style:'currency',currency:'RUB',maximumFractionDigits:2});
const model={me:null,requests:[],pilots:[],selected:null,report:null,
  staffMembers:[],diagnostic:null,bulkPreview:null,operations:null,selectedAction:null};
const manage=()=>['owner','manager'].includes(model.me?.role);
const write=()=>['owner','manager','operator'].includes(model.me?.role);
function setStatus(message,error=false){
  const p=$('globalStatus');p.textContent=message;p.className=error?'error':'';
}
function csrfCookie(){
  const raw=document.cookie.split(';').map(s=>s.trim());
  const matching=raw.find(s=>s.startsWith('__Host-osmanx_industry_csrf=')||s.startsWith('osmanx_industry_csrf='));
  return matching?decodeURIComponent(matching.slice(matching.indexOf('=')+1)):'';
}
async function api(path,{method='GET',body,headers={}}={}){
  const opts={method,credentials:'same-origin',cache:'no-store',headers:{Accept:'application/json',...headers}};
  if(body!==undefined){opts.headers['Content-Type']='application/json';opts.body=JSON.stringify(body);}
  if(!['GET','HEAD'].includes(method)&&path!=='/auth/login'){
    const csrf=csrfCookie();
    if(!csrf)throw Error('Нет CSRF-токена. Войдите повторно.');
    opts.headers['X-CSRF-Token']=csrf;
  }
  let response;
  try{response=await fetch(API+path,opts)}
  catch{throw Error('Нет соединения с Industry API. Сервер может быть ещё не развёрнут.');}
  const contentType=response.headers.get('content-type')||'';
  if(!contentType.includes('application/json')){
    if(!response.ok)throw Error('API не отвечает ожидаемым форматом (HTTP '+response.status+'). Проверьте развёртывание сервера.');
    throw Error('Некорректный ответ сервера.');
  }
  const data=await response.json();
  if(!response.ok){
    if(response.status===401){model.me=null;showAuth();}
    throw Error(data?.error||'Ошибка сервера '+response.status);
  }
  return data;
}
async function downloadCsv(path){
  const csrf=csrfCookie();
  if(!csrf)throw Error('Требуется вход.');
  const response=await fetch(API+path,{credentials:'same-origin',cache:'no-store',
    headers:{Accept:'text/csv'}});
  if(!response.ok)throw Error('Не удалось скачать отчёт (HTTP '+response.status+').');
  if(!(response.headers.get('content-type')||'').includes('text/csv'))throw Error('Неверный формат отчёта');
  const blob=await response.blob();
  if(blob.size>1000000)throw Error('Слишком большой отчёт');
  const objectUrl=URL.createObjectURL(blob);
  const a=document.createElement('a');
  a.href=objectUrl;a.download='osmanx-guest-r4-report.csv';
  document.body.append(a);a.click();a.remove();
  setTimeout(()=>URL.revokeObjectURL(objectUrl),1000);
}
async function safely(task){
  try{setStatus('');await task()}
  catch(e){setStatus(e.message||'Непредвиденная ошибка',true)}
}
function showAuth(){
  $('loginPanel').hidden=false;$('workPanel').hidden=true;
  $('password').value='';
  $('newInvite').hidden=true;$('inviteToken').value='';
  $('staffPanel').hidden=true;
  $('overviewPanel').hidden=true;$('operationsPanel').hidden=true;
  $('actionAssignmentForm').hidden=true;$('actionHistoryPanel').hidden=true;
  model.bulkPreview=null;model.diagnostic=null;model.operations=null;
  model.selectedAction=null;model.staffMembers=[];
}
function showWorkspace(){
  $('loginPanel').hidden=true;$('workPanel').hidden=false;
  $('tenantLabel').textContent=model.me.tenant.name;
  $('accountLabel').textContent=model.me.account.email+' · роль: '+model.me.role;
  $('requestForm').querySelector('button[type=submit]').disabled=!write();
  $('pilotForm').querySelector('button[type=submit]').disabled=!manage();
  $('staffPanel').hidden=!manage();
  $('overviewPanel').hidden=!manage();
  $('operationsPanel').hidden=!manage();
  $('retentionRun').hidden=model.me.role!=='owner';
  $('actionForm').hidden=!manage();
  const managerRole=$('inviteRole').querySelector('option[value=manager]');
  managerRole.hidden=model.me.role!=='owner';
  if(model.me.role!=='owner' && $('inviteRole').value==='manager')$('inviteRole').value='viewer';
}
async function loadMe(){
  const data=await api('/auth/me');
  model.me=data;showWorkspace();await refresh();
}
async function refresh(){
  if(!model.me)return;
  const [requests,pilots]=await Promise.all([api('/guest/requests'),api('/guest/pilots')]);
  model.requests=requests.items;model.pilots=pilots.items;
  drawRequests();drawPilots();
  if(manage()){
    await loadStaff();
    await loadOverview();
    await loadOperations();
  }
  if(model.selected?.item)await openPilot(model.selected.item.id);
}
function appendText(parent,tag,text,css){
  const node=document.createElement(tag);node.textContent=String(text);
  if(css)node.className=css;
  parent.append(node);return node;
}
function actionButton(label,onClick,secondary=false){
  const button=document.createElement('button');button.type='button';
  button.className=secondary?'secondary':'';
  button.textContent=label;
  button.addEventListener('click',()=>safely(()=>onClick()));
  return button;
}
async function loadOverview(){
  const data=await api('/guest/overview');
  const r=data.requests,p=data.pilots,q=data.quotas;
  if(data.schema!=='osmanx.guest.overview.v1')throw Error('Неверная версия данных руководителя');
  $('overviewRequests').textContent='Новые: '+r.new+' · квалифицированы: '+r.qualified+
    ' · отклонены: '+r.declined+' · переведены в пилот: '+r.converted;
  $('overviewPilots').textContent='Черновики: '+p.draft+' · идут: '+p.running+
    ' · на разборе: '+p.in_review+' · возвращены: '+p.returned+
    ' · рассмотрены: '+p.reviewed+' · архив: '+p.archived;
  $('overviewQuotas').textContent='Заявки: '+q.requests.used+' / '+q.requests.limit+
    ' за '+q.requests.windowDays+' дней. Активные пилоты: '+q.activePilots.used+
    ' / '+q.activePilots.limit+'.';
}
async function loadOperations(){
  if(!manage())return;
  const data=await api('/guest/operations');
  if(data.schema!=='osmanx.guest.operations.v1'||!Array.isArray(data.items))
    throw Error('Неожиданный формат операционной очереди.');
  model.operations=data;
  $('operationsSummary').textContent='Критичные: '+data.totals.atRisk+
    ' · предупреждения: '+data.totals.warning+
    ' · просроченных действий: '+data.totals.overdueActions+
    ' · показано пилотов: '+data.returned+
    (data.truncated?' (есть дополнительные записи)':'')+'. '+data.disclaimer;
  const list=$('operationsList');list.replaceChildren();
  if(!data.items.length)appendText(list,'li','Нет активных пилотов.','small');
  for(const item of data.items){
    const row=document.createElement('li'),detail=document.createElement('div');
    appendText(detail,'strong',item.title+' · '+item.phase+
      ' · приоритет '+(item.priority==='high'?'высокий':item.priority==='medium'?'средний':'обычный'));
    appendText(detail,'p','Периодов: '+item.activePeriods+
      ' · открытых действий: '+item.openActions+
      ' · просроченных: '+item.overdueActions,'small');
    for(const signal of item.alerts)
      appendText(detail,'p',signal.reason+' '+signal.nextStep,'small');
    row.append(detail);
    row.append(actionButton('Открыть пилот',async()=>{
      await openPilot(item.id);
      $('detailPanel').scrollIntoView({behavior:'smooth',block:'start'});
    },true));
    list.append(row);
  }
}
async function actionHistory(pilotId,actionId){
  const result=await api('/guest/pilots/'+pilotId+'/actions/'+actionId+'/history');
  if(result.schema!=='osmanx.guest.action.history.v1'||!Array.isArray(result.items))
    throw Error('Неожиданный формат истории действий');
  $('actionHistoryPanel').hidden=false;
  $('actionHistory').textContent=result.items.length?result.items.map(e=>{
    const staff=model.staffMembers.find(m=>m.account_id===e.actor_id);
    return 'Версия '+e.action_version+' · '+e.event_type+' · '+
      (e.from_status||'—')+' → '+e.to_status+
      ' · срок '+(e.previousDueDate||'—')+' → '+e.nextDueDate+
      ' · исполнил '+(staff?.email||'ID '+e.actor_id.slice(0,8))+
      ' · '+new Date(e.recorded_at).toLocaleString('ru-RU');
  }).join('\n'):'Событий нет; для исторических действий может существовать только миграционный baseline.';
}
async function downloadVerifiedOperations(){
  const pilot=currentPilot();
  if(!manage())throw Error('Экспорт доступен владельцу и управляющему.');
  const res=await fetch(API+'/guest/pilots/'+pilot.id+'/operations/export.json',{
    method:'GET',credentials:'same-origin',cache:'no-store',
    headers:{Accept:'application/json'}
  });
  const type=res.headers.get('content-type')||'';
  if(!type.includes('application/json'))throw Error('Неверный ответ сервера для экспорта.');
  if(!res.ok){
    const error=await res.json();
    throw Error(error?.error||'Ошибка экспорта: '+res.status);
  }
  if(Number(res.headers.get('content-length')||'0')>2000000)
    throw Error('Пакет слишком большой для браузерной проверки.');
  const packet=await res.json();
  if(packet.format!=='osmanx.guest.operations.export.v1'||
     !/^[a-f0-9]{64}$/.test(packet.sha256)||!packet.snapshot||
     !/^[a-f0-9]{64}$/.test(packet.snapshot.evidenceSha256))
    throw Error('Неподтверждённый формат экспортируемого пакета.');
  const digest=async value=>{
    const data=new TextEncoder().encode(JSON.stringify(value));
    if(data.byteLength>2000000)throw Error('Пакет превышает допустимый размер.');
    const buffer=await crypto.subtle.digest('SHA-256',data);
    return [...new Uint8Array(buffer)].map(n=>n.toString(16).padStart(2,'0')).join('');
  };
  if(await digest(packet.snapshot)!==packet.sha256||
     await digest(packet.snapshot.evidence)!==packet.snapshot.evidenceSha256)
    throw Error('Контрольная сумма пакета не совпадает с содержимым; файл не сохранён.');
  const data=JSON.stringify(packet,null,2);
  const objectUrl=URL.createObjectURL(new Blob([data],{type:'application/json'}));
  try{
    const a=document.createElement('a');a.href=objectUrl;
    a.download='osmanx-guest-r11-operational-proof.json';
    document.body.append(a);a.click();a.remove();
  }finally{setTimeout(()=>URL.revokeObjectURL(objectUrl),1000);}
  setStatus('Экспорт сохранён: SHA-256 пакета и исходных агрегатов проверены в браузере.');
}
async function loadStaff(){
  const data=await api('/staff');
  model.staffMembers=data.members; 
  const assignees=$('actionAssignee'),selected=assignees.value;
  assignees.replaceChildren();
  const placeholder=document.createElement('option');
  placeholder.value='';placeholder.textContent='Выберите сотрудника';assignees.append(placeholder);
  for(const member of data.members.filter(m=>m.role!=='viewer')){
    const option=document.createElement('option');option.value=member.account_id;
    option.textContent=member.email+' · '+member.role;assignees.append(option);
  }
  if([...assignees.options].some(o=>o.value===selected))assignees.value=selected;
  const list=$('staffList');list.replaceChildren();
  if(!data.members.length && !data.invitations.length)
    appendText(list,'li','Сотрудников и приглашений пока нет.','small');
  for(const member of data.members){
    const row=document.createElement('li');
    appendText(row,'span',member.email+' · '+member.role);
    list.append(row);
  }
  for(const inv of data.invitations){
    const row=document.createElement('li'),detail=document.createElement('div');
    const expired=Date.parse(inv.expires_at)<=Date.now();
    const state=inv.accepted_at?'принято':inv.revoked_at?'отозвано':expired?'истекло':'ожидает принятия';
    appendText(detail,'strong',inv.email);
    appendText(detail,'span',inv.role+' · '+state,'small');row.append(detail);
    if(!inv.accepted_at&&!inv.revoked_at&&!expired && (model.me.role==='owner'||inv.role!=='manager')){
      row.append(actionButton('Отозвать приглашение',async()=>{
        await api('/staff/invitations/'+inv.id+'/revoke',{method:'POST',body:{}});
        await loadStaff();
        setStatus('Приглашение отозвано; одноразовый токен больше не действителен.');
      },true));
    }
    list.append(row);
  }
}
function drawRequests(){
  const list=$('requestsList');
  list.replaceChildren();
  const select=$('requestId');select.replaceChildren();
  const option=document.createElement('option');option.value='';option.textContent='Без заявки';select.append(option);
  if(!model.requests.length)appendText(list,'li','Заявок пока нет','small');
  for(const request of model.requests){
    const row=document.createElement('li');const left=document.createElement('div');
    appendText(left,'strong',request.title);
    appendText(left,'span',' '+request.source+' · '+request.state,'small');
    row.append(left);
    if(request.state==='new'&&manage()){
      const controls=document.createElement('div');controls.className='actions';
      for(const [state,caption] of [['qualified','Квалифицировать'],['declined','Отказать']]){
        controls.append(actionButton(caption,async()=>{
          await api('/guest/requests/'+request.id,{method:'PATCH',body:{state}});
          await refresh();setStatus('Статус заявки обновлён.');
        },state==='declined'));
      }
      row.append(controls);
    }
    list.append(row);
    if(request.state==='qualified'){
      const entry=document.createElement('option');entry.value=request.id;entry.textContent=request.title;
      select.append(entry);
    }
  }
}
function drawPilots(){
  const list=$('pilotsList');list.replaceChildren();
  if(!model.pilots.length)appendText(list,'li','Пилотов пока нет','small');
  for(const pilot of model.pilots){
    const row=document.createElement('li');const left=document.createElement('div');
    appendText(left,'strong',pilot.title);
    appendText(left,'span',' '+pilot.phase+' · версия '+pilot.version,'small');
    row.append(left,actionButton('Открыть',()=>openPilot(pilot.id),true));
    list.append(row);
  }
}
function enablePilotActions(){
  const item=model.selected?.item;
  if(!item)return;
  const phase=item.phase;
  const isManage=manage(),isWrite=write();
  $('saveReady').disabled=!isManage||phase!=='draft';
  $('start').disabled=!isManage||phase!=='draft';
  $('observationForm').querySelector('button[type=submit]').disabled=!isWrite||phase!=='running';
  $('submitReview').disabled=!isManage||phase!=='running';
  $('resume').disabled=!isManage||phase!=='returned';
  $('accept').disabled=!isManage||phase!=='in_review'||item.submittedBy===model.me.account.id;
  $('return').disabled=!isManage||phase!=='in_review'||item.submittedBy===model.me.account.id;
  $('archivePanel').hidden=!(model.me.role==='owner'&&phase==='reviewed');
  $('archivePilot').disabled=model.me.role!=='owner'||phase!=='reviewed';
  $('downloadEvidence').disabled=!(model.selected.observations?.length);
  $('bulkPreview').disabled=!isWrite||phase!=='running';
  $('bulkCommit').disabled=!isWrite||phase!=='running'||!model.bulkPreview;
  $('actionForm').hidden=!isManage;
  for(const checkbox of document.querySelectorAll('[data-ready]'))checkbox.disabled=!isManage||phase!=='draft';
}
async function openPilot(id){
  const switched=model.selected?.item?.id!==id;
  const data=await api('/guest/pilots/'+id);
  model.selected=data;
  if(switched){model.bulkPreview=null;model.selectedAction=null;
    $('bulkCommit').disabled=true;$('actionHistoryPanel').hidden=true;
    $('actionAssignmentForm').hidden=true;
    $('bulkResult').textContent='CSV ещё не проверен.';}
  $('detailPanel').hidden=false;
  const item=data.item;
  $('pilotHeading').textContent=item.title;
  $('phase').textContent=item.phase;
  const p=item.protocol;
  $('protocolStatus').textContent=p
    ?'Зафиксированный протокол: '+p.startDate+' — '+p.endDate+
      '; повторный визит за '+p.outcomeWindowDays+' дней; группы: '+p.allocation+
      '; источник: '+p.source+'. '+(item.prospectivelyRegistered===true
        ?'Зарегистрирован до начала периода.'
        :'Создан после начала периода — ретроспективный риск, не заявлять предрегистрацию.')
    :'Архивный пилот предыдущей версии: подтверждённый протокол отсутствует.';
  $('version').textContent=String(item.version);
  $('sample').textContent=String(item.targetPerGroup);
  for(const k of flags)document.querySelector('[data-ready="'+k+'"]').checked=item.readiness[k]===true;
  const rows=$('observationList');rows.replaceChildren();
  if(!data.observations.length){
    const tr=document.createElement('tr');const td=document.createElement('td');
    td.colSpan=4;td.textContent='Наблюдений пока нет';tr.append(td);rows.append(tr);
  }
  for(const obs of data.observations){
    const tr=document.createElement('tr');
    for(const text of [obs.date,obs.controlReturn+' / '+obs.control,obs.offerReturn+' / '+obs.offer]){
      appendText(tr,'td',text);
    }
    const cell=document.createElement('td');
    if(manage()&&item.phase==='running'){
      const button=actionButton('Отозвать',async()=>{
        if(!window.confirm('Отозвать агрегированный период? Оригинальная запись сохранится в истории изменений.'))return;
        await api('/guest/pilots/'+item.id+'/observations/'+obs.id+'/void',{
          method:'POST',body:{expectedVersion:model.selected.item.version}
        });
        await refresh();setStatus('Наблюдение отозвано. Добавьте исправленный период с новым ключом.');
      },true);
      button.classList.add('danger');cell.append(button);
    }else cell.textContent='—';
    tr.append(cell);rows.append(tr);
  }
  enablePilotActions();
  await loadReport();
  await Promise.all([loadDiagnostics(),loadActions()]);
}
async function loadReport(){
  if(!model.selected)return;
  model.report=await api('/guest/pilots/'+model.selected.item.id+'/report');
  $('reportBox').textContent=model.report.report ||
    'Нет наблюдений. Загрузите обезличенные показатели после запуска пилота.';
}
async function loadDiagnostics(){
  const pilot=currentPilot();
  const result=await api('/guest/pilots/'+pilot.id+'/diagnostics');
  if(result.diagnostic?.schema!=='osmanx.guest.diagnostic.v1')
    throw Error('Неожиданный формат диагностики');
  model.diagnostic=result;
  const d=result.diagnostic;
  $('diagnosticSummary').textContent=
    'Периоды: '+d.observedPeriods+' · контроль: '+d.sample.control+
    ' · предложение: '+d.sample.offer+
    ' · повторные визиты: '+(d.rates.controlPct??'—')+'% / '+
    (d.rates.offerPct??'—')+'% · разница: '+(d.rates.differencePp??'—')+
    ' п.п. · замечаний: '+d.findingCount+'. '+d.disclaimer;
  const list=$('diagnosticFindings');list.replaceChildren();
  if(!d.recommendations.length)appendText(list,'li','Правила не обнаружили приоритетных предупреждений; это не означает отсутствие проблем.','small');
  for(const r of d.recommendations){
    const li=document.createElement('li'),info=document.createElement('div');
    appendText(info,'strong',r.title+' · '+r.severity);
    appendText(info,'p',r.why+' '+r.nextStep,'small');li.append(info);list.append(li);
  }
  const dropdown=$('actionCode'),selected=dropdown.value;
  dropdown.replaceChildren();
  const placeholder=document.createElement('option');placeholder.value='';
  placeholder.textContent='Выберите вывод диагностики';dropdown.append(placeholder);
  for(const r of d.recommendations){
    const opt=document.createElement('option');opt.value=r.code;
    opt.textContent=r.title;dropdown.append(opt);
  }
  if([...dropdown.options].some(o=>o.value===selected))dropdown.value=selected;
}
async function loadActions(){
  const pilot=currentPilot(),response=await api('/guest/pilots/'+pilot.id+'/actions');
  const list=$('actionList');list.replaceChildren();
  if(!response.items.length)appendText(list,'li','Назначенных действий пока нет.','small');
  for(const item of response.items){
    const row=document.createElement('li'),info=document.createElement('div');
    const title=model.diagnostic?.diagnostic.recommendations
      .find(r=>r.code===item.code)?.title||item.code;
    const staff=model.staffMembers.find(m=>m.account_id===item.assigned_to);
    appendText(info,'strong',title);
    appendText(info,'p','Статус: '+item.status+' · срок: '+item.dueDate+
      ' · ответственный: '+(staff?.email||'назначенный сотрудник'),'small');
    row.append(info);
    const operatorControls=document.createElement('div');operatorControls.className='actions';
    operatorControls.append(actionButton('История',async()=>{
      await actionHistory(pilot.id,item.id);
    },true));
    if(manage()&&['open','in_progress'].includes(item.status)){
      operatorControls.append(actionButton('Изменить ответственного',async()=>{
        model.selectedAction={pilotId:pilot.id,id:item.id,version:item.version};
        const select=$('assignmentAssignee');select.replaceChildren();
        for(const member of model.staffMembers.filter(m=>m.role!=='viewer')){
          const option=document.createElement('option');option.value=member.account_id;
          option.textContent=member.email+' · '+member.role;select.append(option);
        }
        select.value=item.assigned_to;
        $('assignmentDue').value=item.dueDate;
        $('actionAssignmentForm').hidden=false;
      },true));
    }
    row.append(operatorControls);
    const mayUpdate=manage()||(write()&&item.assigned_to===model.me?.account?.id);
    if(mayUpdate){
      const next=item.status==='open'?[['in_progress','Взять в работу'],['dismissed','Отклонить']]:
        item.status==='in_progress'?[['done','Завершить'],['dismissed','Отклонить']]:[];
      const controls=document.createElement('div');controls.className='actions';
      for(const [state,caption] of next){
        controls.append(actionButton(caption,async()=>{
          if(state==='dismissed'&&!window.confirm('Отметить действие как отклонённое?'))return;
          await api('/guest/pilots/'+pilot.id+'/actions/'+item.id,{
            method:'PATCH',body:{expectedVersion:item.version,status:state}
          });
          await loadActions();
          setStatus('Действие обновлено в журнале компании.');
        },state==='dismissed'));
      }
      row.append(controls);
    }
    list.append(row);
  }
}
function currentPilot(){
  if(!model.selected)throw Error('Сначала откройте пилот.');
  return model.selected.item;
}
function refreshCurrent(){return refresh();}
function idempotency(){return 'guest-'+crypto.randomUUID();}
$('loginForm').addEventListener('submit',event=>{
  event.preventDefault();safely(async()=>{
    const tenantSlug=$('tenant').value.trim();
    await api('/auth/login',{method:'POST',body:{tenantSlug,email:$('email').value.trim(),password:$('password').value}});
    $('password').value='';
    await loadMe();setStatus('Вход выполнен. Права определяются ролью сотрудника.');
  });
});
$('inviteForm').addEventListener('submit',event=>{
  event.preventDefault();safely(async()=>{
    if(!manage())throw Error('Недостаточно прав.');
    const email=$('inviteEmail').value.trim().toLowerCase();
    const role=$('inviteRole').value;
    const data=await api('/staff/invitations',{method:'POST',body:{email,role}});
    // This raw 256-bit token is returned by the server exactly once.
    // Keep it in the current tab only, never in a URL or persistent storage.
    $('inviteToken').value=data.token;
    $('newInvite').hidden=false;
    $('inviteEmail').value='';
    await loadStaff();
    setStatus('Приглашение создано. Передайте токен лично адресату и сообщите код компании отдельно.');
  });
});
$('copyInvite').addEventListener('click',()=>safely(async()=>{
  const token=$('inviteToken').value;
  if(!/^[a-f0-9]{64}$/.test(token))throw Error('Токен уже очищен. Создайте новое приглашение.');
  try{await navigator.clipboard.writeText(token);setStatus('Токен скопирован. Сохраните его только у адресата.');}
  catch{$('inviteToken').focus();$('inviteToken').select();setStatus('Токен выделен для ручного копирования.');}
}));
$('logout').addEventListener('click',()=>safely(async()=>{
  await api('/auth/logout',{method:'POST',body:{}});
  model.me=null;model.selected=null;model.report=null;showAuth();setStatus('Сессия завершена.');
}));
$('refresh').addEventListener('click',()=>safely(()=>refresh()));
$('requestForm').addEventListener('submit',event=>{
  event.preventDefault();safely(async()=>{
    await api('/guest/requests',{method:'POST',headers:{'Idempotency-Key':idempotency()},
      body:{title:$('requestTitle').value.trim(),source:$('requestSource').value}});
    $('requestForm').reset();await refresh();setStatus('Заявка внесена в базу вашей компании.');
  });
});
$('pilotForm').addEventListener('submit',event=>{
  event.preventDefault();safely(async()=>{
    const plan=Object.fromEntries(['baselinePct','liftPp','margin','discount','fixed','fee'].map(k=>[k,$(k).value]));
    const requestId=$('requestId').value||null;
    const protocol={
      startDate:$('studyStart').value,endDate:$('studyEnd').value,
      outcomeWindowDays:Number($('studyWindow').value),
      allocation:$('studyAllocation').value,source:$('studySource').value,
      primaryMetric:'repeat_visit'
    };
    const output=await api('/guest/pilots',{method:'POST',body:{title:$('pilotTitle').value.trim(),plan,requestId,protocol}});
    await refresh();await openPilot(output.item.id);setStatus('Пилот создан. Согласуйте условия готовности до запуска.');
  });
});
$('saveReady').addEventListener('click',()=>safely(async()=>{
  const pilot=currentPilot();
  const checks=Object.fromEntries(flags.map(k=>[k,document.querySelector('[data-ready="'+k+'"]').checked]));
  const result=await api('/guest/pilots/'+pilot.id+'/readiness',{
    method:'PATCH',body:{expectedVersion:pilot.version,readiness:checks}
  });
  await refreshCurrent();
  setStatus(result.ready?'Все условия отмечены. Данные и согласия должны быть подтверждены вне системы.':
    'Не все условия выполнены: '+result.blocking.join(' '));
}));
$('start').addEventListener('click',()=>safely(async()=>{
  const pilot=currentPilot();
  await api('/guest/pilots/'+pilot.id+'/start',{method:'POST',body:{expectedVersion:pilot.version}});
  await refreshCurrent();setStatus('Пилот переведён в стадию наблюдения.');
}));
$('observationForm').addEventListener('submit',event=>{
  event.preventDefault();safely(async()=>{
    const pilot=currentPilot();
    const observation={date:$('obsDate').value,...Object.fromEntries(
      ['control','controlReturn','offer','offerReturn'].map(k=>[k,$(k).value]))};
    await api('/guest/pilots/'+pilot.id+'/observations',{
      method:'POST',headers:{'Idempotency-Key':idempotency()},
      body:{expectedVersion:pilot.version,observation}
    });
    $('observationForm').reset();await refreshCurrent();
    setStatus('Агрегированный период сохранён. Персональные сведения не отправлялись.');
  });
});
$('submitReview').addEventListener('click',()=>safely(async()=>{
  const pilot=currentPilot();
  await api('/guest/pilots/'+pilot.id+'/submit',{method:'POST',body:{expectedVersion:pilot.version}});
  await refreshCurrent();setStatus('Данные направлены на независимый разбор.');
}));
$('resume').addEventListener('click',()=>safely(async()=>{
  const pilot=currentPilot();
  await api('/guest/pilots/'+pilot.id+'/resume',{method:'POST',body:{expectedVersion:pilot.version}});
  await refreshCurrent();setStatus('Пилот снова открыт для корректировки наблюдений.');
}));
for(const [id,decision] of [['accept','accept_for_discussion'],['return','request_revision']]){
  $(id).addEventListener('click',()=>safely(async()=>{
    const pilot=currentPilot();const report=model.report||await api('/guest/pilots/'+pilot.id+'/report');
    const data=await api('/guest/pilots/'+pilot.id+'/review',{method:'POST',body:{
      expectedVersion:pilot.version,decision,evidenceDigest:report.evidenceDigest
    }});
    await refreshCurrent();setStatus(data.disclaimer);
  }));
}
async function saveEvidence(){
  const pilot=currentPilot();
  const response=await fetch(API+'/guest/pilots/'+pilot.id+'/evidence.json',{
    method:'GET',credentials:'same-origin',cache:'no-store',headers:{Accept:'application/json'}
  });
  const type=response.headers.get('content-type')||'';
  if(!type.includes('application/json'))throw Error('Сервер вернул неверный формат доказательств.');
  const data=await response.json();
  if(!response.ok)throw Error(data?.error||'Не удалось скачать доказательства');
  if(data.format!=='osmanx.guest.evidence.export.v1'||!data.evidence||
     !/^[a-f0-9]{64}$/.test(String(data.sha256)))
    throw Error('Неверная структура доказательств');
  const encoded=new TextEncoder().encode(JSON.stringify(data.evidence));
  const hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',encoded)))
    .map(x=>x.toString(16).padStart(2,'0')).join('');
  if(hash!==data.sha256)throw Error('Контрольная сумма JSON не совпала с SHA-256 сервера.');
  const blob=new Blob([JSON.stringify(data,null,2)+'\n'],{type:'application/json;charset=utf-8'});
  if(blob.size>1000000)throw Error('Слишком большой архив доказательств.');
  const url=URL.createObjectURL(blob),a=document.createElement('a');
  a.href=url;a.download='osmanx-guest-evidence.json';document.body.append(a);a.click();a.remove();
  setTimeout(()=>URL.revokeObjectURL(url),1500);
  setStatus('Проверенный экспорт JSON сохранён. SHA-256: '+data.sha256);
}
$('downloadEvidence').addEventListener('click',()=>safely(saveEvidence));
$('archivePilot').addEventListener('click',()=>safely(async()=>{
  if(model.me?.role!=='owner')throw Error('Архивация доступна только владельцу компании.');
  const pilot=currentPilot(),reason=$('archiveReason').value.trim();
  if(reason.length<6||reason.length>160)throw Error('Укажите причину от 6 до 160 символов.');
  if(!window.confirm('Заархивировать проверенный пилот? Вернуть его в работу через кабинет будет нельзя.'))return;
  const response=await api('/guest/pilots/'+pilot.id+'/archive',{
    method:'POST',body:{expectedVersion:pilot.version,reason}
  });
  $('archiveReason').value='';
  await refreshCurrent();
  setStatus('Пилот заархивирован, исходные данные сохранены. SHA-256: '+response.sha256);
}));
$('overviewRefresh').addEventListener('click',()=>safely(()=>loadOverview()));
$('retentionRun').addEventListener('click',()=>safely(async()=>{
  if(model.me?.role!=='owner')throw Error('Требуются права владельца.');
  if(!window.confirm('Очистить свободный текст отклонённых несвязанных заявок старше 90 дней? История решений останется.'))return;
  const result=await api('/guest/requests/retention',{
    method:'POST',body:{confirm:true}
  });
  await refresh();
  setStatus('Очищено '+result.redacted+' старых заявок. Вся история аудита сохранена.');
}));
function defaultStudyDates(){
  const now=new Date();
  const plus=new Date(now.getTime()+13*86400000);
  $('studyStart').value=now.toISOString().slice(0,10);
  $('studyEnd').value=plus.toISOString().slice(0,10);
  $('obsDate').max=now.toISOString().slice(0,10);
  $('actionDue').value=new Date(now.getTime()+7*86400000).toISOString().slice(0,10);
}
defaultStudyDates();
$('operationsRefresh').addEventListener('click',()=>safely(async()=>{
  await loadOperations();setStatus('Очередь руководителя пересчитана по серверным данным.');
}));
$('assignmentCancel').addEventListener('click',()=>{
  model.selectedAction=null;$('actionAssignmentForm').hidden=true;
});
$('actionAssignmentForm').addEventListener('submit',event=>{
  event.preventDefault();safely(async()=>{
    if(!manage())throw Error('Изменение ответственного доступно руководителю.');
    const selected=model.selectedAction,pilot=currentPilot();
    if(!selected||selected.pilotId!==pilot.id)throw Error('Сначала выберите задачу.');
    await api('/guest/pilots/'+pilot.id+'/actions/'+selected.id+'/assignment',{
      method:'PATCH',body:{
        expectedVersion:selected.version,assigneeId:$('assignmentAssignee').value,
        dueDate:$('assignmentDue').value
      }
    });
    $('actionAssignmentForm').hidden=true;model.selectedAction=null;
    await Promise.all([loadActions(),loadOperations()]);
    await actionHistory(pilot.id,selected.id);
    setStatus('Ответственный/срок обновлены с новой версией и записью в истории.');
  });
});
$('downloadOperations').addEventListener('click',()=>safely(()=>downloadVerifiedOperations()));
$('refreshDiagnostics').addEventListener('click',()=>safely(async()=>{
  await loadDiagnostics();await loadActions();
  setStatus('Диагностика обновлена по сохранённым данным.');
}));
$('actionForm').addEventListener('submit',event=>{
  event.preventDefault();safely(async()=>{
    if(!manage())throw Error('Назначать действия могут владелец и управляющий.');
    const pilot=currentPilot();
    await api('/guest/pilots/'+pilot.id+'/actions',{method:'POST',body:{
      expectedPilotVersion:pilot.version,
      code:$('actionCode').value,
      assigneeId:$('actionAssignee').value,
      dueDate:$('actionDue').value
    }});
    await loadActions();
    setStatus('Задача зарегистрирована с ответственным и сроком. Это не доказательство эффекта.');
  });
});
function resetBatchPreview(){
  model.bulkPreview=null;$('bulkCommit').disabled=true;
  $('bulkResult').textContent='CSV изменён. Требуется новая проверка без сохранения.';
}
$('bulkCsv').addEventListener('input',resetBatchPreview);
$('bulkFile').addEventListener('change',()=>safely(async()=>{
  const file=$('bulkFile').files?.[0];
  if(!file)return;
  if(file.size>4096)throw Error('Допускаются только небольшие CSV до 4 КБ.');
  const csv=await file.text();
  if(new TextEncoder().encode(csv).byteLength>4096)throw Error('CSV слишком большой.');
  $('bulkCsv').value=csv;
  resetBatchPreview();
  setStatus('Файл загружен только в память этой вкладки. Проверьте CSV перед записью.');
}));
$('bulkPreview').addEventListener('click',()=>safely(async()=>{
  const pilot=currentPilot(),csv=$('bulkCsv').value;
  if(pilot.phase!=='running'||!write())throw Error('Запись разрешена только в открытом пилоте.');
  const data=await api('/guest/pilots/'+pilot.id+'/observations/import/preview',{
    method:'POST',body:{expectedVersion:pilot.version,csv}
  });
  if(data.schema!=='osmanx.guest.csv.preview.v1'||!/^[a-f0-9]{64}$/.test(data.sha256))
    throw Error('Сервер вернул неверный формат предварительной проверки');
  model.bulkPreview={pilotId:pilot.id,version:pilot.version,csv,sha256:data.sha256};
  $('bulkCommit').disabled=false;
  $('bulkResult').textContent='Проверено '+data.summary.rowCount+' периодов: '+
    data.summary.firstDate+' — '+data.summary.lastDate+
    '. Контроль: '+data.summary.totals.control+'; предложение: '+
    data.summary.totals.offer+'. Контрольная сумма SHA-256: '+data.sha256+
    '. Пока ничего не сохранено.';
}));
$('bulkCommit').addEventListener('click',()=>safely(async()=>{
  const pilot=currentPilot(),preview=model.bulkPreview;
  if(!preview||preview.pilotId!==pilot.id||preview.version!==pilot.version||
     preview.csv!==$('bulkCsv').value)
    throw Error('CSV изменился или версия пилота устарела. Проверьте повторно.');
  if(!window.confirm('Сохранить '+$('bulkResult').textContent.split(' ')[1]+
    ' проверенных периодов одной транзакцией?'))return;
  $('bulkCommit').disabled=true;
  const result=await api('/guest/pilots/'+pilot.id+'/observations/import',{
    method:'POST',headers:{'Idempotency-Key':idempotency()},
    body:{expectedVersion:preview.version,csv:preview.csv,sha256:preview.sha256}
  });
  model.bulkPreview=null;$('bulkCsv').value='';$('bulkFile').value='';
  $('bulkResult').textContent='Сохранено '+result.rowsImported+' периодов. SHA-256: '+result.sha256;
  await refreshCurrent();
  setStatus('Пакет агрегатов записан атомарно; все строки подтверждены сервером.');
}));
$('loadReport').addEventListener('click',()=>safely(()=>loadReport()));
$('downloadReport').addEventListener('click',()=>safely(async()=>{
  await downloadCsv('/guest/pilots/'+currentPilot().id+'/report.csv');
  setStatus('CSV отчёт сохранён локально.');
}));
(async()=>{
  try{await loadMe();}
  catch(error){
    showAuth();
    if(!error.message?.includes('Требуется вход'))
      setStatus('API: '+error.message,true);
  }
})();
