// OSMANX Guest Intelligence R4 — authenticated SAME-ORIGIN UI.
// No tokens, passwords, customer records, or personal data in local/session storage.
// No demo success states: all workspace data comes from authenticated PostgreSQL API.
const API='/api/industry/v1';
const $=id=>document.getElementById(id);
const flags=['repeatDefinition','sameWindow','independentGroups','marginVerified','contactConsent','ownerAgreed'];
const currencies=new Intl.NumberFormat('ru-RU',{style:'currency',currency:'RUB',maximumFractionDigits:2});
const model={me:null,requests:[],pilots:[],selected:null,report:null,
  staffMembers:[],diagnostic:null,bulkPreview:null,operations:null,selectedAction:null,launchGate:null,safety:null};
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
async function downloadCsv(path,filename='osmanx-guest-r4-report.csv'){
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
  a.href=objectUrl;a.download=filename;
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
  model.selectedAction=null;model.launchGate=null;model.safety=null;model.staffMembers=[];
  model.admission=null;$('admissionPanel').hidden=true;
  $('r19Panel').hidden=true;
  $('r20Panel').hidden=true;
  $('r21Panel').hidden=true;
  $('r22Panel').hidden=true;
  $('r23Panel').hidden=true;
  $('r24Panel').hidden=true;
  $('r25Panel').hidden=true;
  $('r26Panel').hidden=true;
  $('r27Panel').hidden=true;
  $('r28Panel').hidden=true;
  $('r29Panel').hidden=true;
  $('r30Panel').hidden=true;
  $('r31Panel').hidden=true;
  $('r32Panel').hidden=true;
  $('r33Panel').hidden=true;
}
function showWorkspace(){
  $('loginPanel').hidden=true;$('workPanel').hidden=false;
  $('tenantLabel').textContent=model.me.tenant.name;
  $('accountLabel').textContent=model.me.account.email+' · роль: '+model.me.role;
  $('requestForm').querySelector('button[type=submit]').disabled=!write();
  $('pilotForm').querySelector('button[type=submit]').disabled=!manage();
  $('staffPanel').hidden=!manage();
  $('admissionPanel').hidden=!manage();
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
    await loadAdmission();
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
async function loadAdmission(){
  const output=$('admissionStatus');
  const expiry=$('admissionExpiration');
  try{
    const value=await api('/guest/admission/self');
    if(value.schema!=='osmanx.guest.r16.self-status.v1')throw Error('Неверная версия допуска');
    model.admission=value;
    const authorized=value.permitValid===true;
    const reason={
      authorized:'разрешение подтверждено',
      guest_writes_disabled:'сбор данных отключён',
      revoked:'разрешение отозвано',
      global_emergency_stop:'экстренная остановка всех компаний',
      tenant_emergency_stop:'экстренная остановка этой компании',
      registry_changed_or_stopped:'реестр обновляется или остановлен',
      not_enrolled:'организация ещё не допущена',
      invalid_signed_tenant_permit:'подписи или доказательства недействительны',
      registry_unavailable:'подписанный реестр недоступен',
      private_evidence_unavailable:'документы подтверждения недоступны',
      invalid_or_missing_permit:'нет действующего подтверждения',
      r17_witness_or_fence_unavailable:'не удалось проверить независимые подтверждения R17 или защиту PostgreSQL',
      r18_anchor_or_fence_unavailable:'внешний хранитель R18 или контроль восстановления недоступен'
    }[value.reason]||'допуск не подтверждён';
    const r17=value.witnessVerified===null||value.witnessVerified===undefined?
      ' · R17 не включён':' · R17: '+(value.witnessVerified===true&&value.witnessFenceReady===true?
        'подписи и контрольная точка подтверждены':'проверка не пройдена')+
        (Number.isSafeInteger(value.witnessSequence)?', запись №'+value.witnessSequence:'');
    const r18=value.externalAnchorVerified===null||value.externalAnchorVerified===undefined?
      ' · R18 не включён':' · R18: '+(value.externalAnchorVerified===true&&
        value.externalAnchorFenceReady===true?
          'независимый хранитель и PostgreSQL проверены':'внешняя проверка не пройдена')+
        (Number.isSafeInteger(value.externalAnchorSequence)?
          ', событие №'+value.externalAnchorSequence:'');
    const r19=value.pilotCollection===null||value.pilotCollection===undefined?
      ' · R19 не включён':
      value.pilotCollection.valid===true?
        ' · R19: один пилот подтверждён до '+new Date(value.pilotCollection.expiresAt).toLocaleString('ru-RU'):
        ' · R19: допуск первого пилота недоступен или остановлен';
    output.textContent='Режим: '+(value.mode==='multi'?'несколько компаний':value.mode==='single'?'одна компания':'отключён')+
      ' · '+(authorized?'Допуск действителен':'Запись недоступна')+' · '+reason+r17+r18+r19+'.';
    output.className=authorized?'info':'alert';
    expiry.textContent=authorized&&value.validUntil?
      'Срок действия до '+new Date(value.validUntil).toLocaleString('ru-RU')+
      '. После окончания требуется новое подтверждение.':
      'Оператор должен проверить причину; браузер не снимает ограничения.';
  }catch{
    model.admission=null;
    output.className='alert';
    output.textContent='Проверка допуска недоступна на текущем сервере. Не считайте статус разрешённым.';
    expiry.textContent='';
  }
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
  updateLaunchButtons();
  for(const checkbox of document.querySelectorAll('[data-ready]'))checkbox.disabled=!isManage||phase!=='draft';
}
async function openPilot(id){
  const switched=model.selected?.item?.id!==id;
  const data=await api('/guest/pilots/'+id);
  model.selected=data;
  if(switched){model.bulkPreview=null;model.selectedAction=null;model.launchGate=null;model.safety=null;
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
  await Promise.all([loadDiagnostics(),loadActions(),loadLaunchGate()]);
  await loadSafety();
  await loadR19Preflight();
  await loadR20Inspection();
  await loadR21Posture();
  await loadR22LaunchReview();
  await loadR23Handoff();
  await loadR24Intelligence();
  await loadR25Insights();
  await loadR26Reliability();
  await loadR27Readiness();
  await loadR28OperatorStatus();
  await loadR29Acceptance();
  await loadR30Acceptance();
  await loadR31Acceptance();
  await loadR32Acceptance();
  await loadR33Acceptance();
}
const R19_LABELS={
  signedTenantAndPilot:'Разрешение подписано именно для этой компании и пилота',
  exactRegisteredProtocol:'SHA-256 протокола совпадает с подписанным планом',
  launchTwoHumans:'Действующие подтверждения владельца и управляющего',
  correctLifecycle:'Разрешённая стадия пилота',
  noSafetyHold:'Нет аварийной остановки R13',
  withinDailyLimit:'Остались доступные операции за текущие сутки UTC'
};
async function loadR19Preflight(){
  const panel=$('r19Panel'),out=$('r19Status'),list=$('r19Checklist');
  panel.hidden=!manage();list.replaceChildren();
  if(!manage()||!model.selected?.item)return;
  const pilotId=model.selected.item.id;
  try{
    const data=await api('/guest/pilots/'+pilotId+'/r19/preflight');
    if(data.schema!=='osmanx.guest.r19.first-pilot-preflight.v1'||
       !data.checks||typeof data.checks!=='object')
      throw Error('Неверный ответ контроля R19');
    const ready=data.technicalCollectionPreflight===true;
    out.className=ready?'info':'alert';
    out.textContent=ready?
      'Проверки R19 пройдены. Использовано сегодня '+data.usedToday+
      ' из '+data.maxDailyWrites+' операций. Допуск до '+new Date(data.scopeExpiresAt).toLocaleString('ru-RU')+'.':
      'Сбор для первого пилота пока не разрешён. Проверьте причины ниже.';
    for(const [code,title] of Object.entries(R19_LABELS)){
      appendText(list,'li',(data.checks[code]===true?'Пройдено: ':'Заблокировано: ')+title,'small');
    }
    $('r19ProtocolHash').textContent='SHA-256 зафиксированного протокола: '+
      (data.protocolDigest||'протокол отсутствует')+
      '. Сверяйте его с подписанным разрешением вне сайта.';
    if(model.admission?.pilotCollection!==null&&
       model.admission?.pilotCollection!==undefined&&!ready){
      $('start').disabled=true;
      $('observationForm').querySelector('button[type=submit]').disabled=true;
      $('bulkCommit').disabled=true;
    }
  }catch{
    out.className='alert';
    out.textContent='R19: серверная проверка недоступна. Не считайте сбор разрешённым.';
    $('r19ProtocolHash').textContent='';
    if(model.admission?.pilotCollection!==null&&model.admission?.pilotCollection!==undefined){
      $('start').disabled=true;
      $('observationForm').querySelector('button[type=submit]').disabled=true;
      $('bulkCommit').disabled=true;
    }
  }
}
const R20_LABELS={
  registeredProtocol:'Зафиксированный неизменяемый протокол',
  launchEnrolled:'Действует запись о включении двухсотрудникового допуска R12',
  noSafetyHold:'Нет активной R13 остановки пилота',
  r16TenantPermit:'Действующее разрешение компании R16',
  r17SignedCheckpoint:'Криптографическая контрольная точка R17',
  r18ExternalReceipt:'Независимая квитанция хранителя R18',
  r19ScopeExact:'Подписанный допуск относится к этой компании и пилоту',
  scopeInDate:'Срок действия допуска ещё не завершился',
  withinDailyBudget:'Есть свободные операции в дневной квоте',
  dailyAuditMatchesQuota:'Сохранённые операции совпадают с журналом',
  retentionWindowCurrent:'Срок хранения требует соблюдения и отдельной проверки',
  releaseChainVerified:'Слияние и проверка всей цепочки R14–R19',
  externalDrAttested:'Восстановление и WORM-хранение подтверждены независимо',
  legalEvidenceReviewed:'Правовые основания подтверждены человеком'
};
async function loadR20Inspection(){
  const panel=$('r20Panel'),output=$('r20Status'),list=$('r20Checklist');
  panel.hidden=!manage();list.replaceChildren();
  if(!manage()||!model.selected?.item)return;
  try{
    const report=await api('/guest/pilots/'+model.selected.item.id+'/r20/inspection');
    if(report.schema!=='osmanx.guest.r20.pilot-inspection.v1'||
       !report.checks||!Array.isArray(report.technicalBlockers))
      throw Error('Неверный формат технической приёмки');
    output.className=report.technicalReviewPossible?'info':'alert';
    output.textContent=report.technicalReviewPossible?
      'Внутренние технические признаки проверены. Запуск реального клиента всё ещё запрещён до независимой приёмки.':
      'К запуску не готово: '+report.technicalBlockers.length+
      ' технических блокирующих условий. Клиентская запись не разрешена.';
    for(const [code,label] of Object.entries(R20_LABELS)){
      const pass=report.checks[code]===true;
      appendText(list,'li',(pass?'Проверено: ':'Требует проверки: ')+label,'small');
    }
    $('r20Budget').textContent=report.daily?.used===null?
      'Сведения о дневных операциях недоступны.':
      'Операций за сегодня: '+report.daily.used+' из '+report.daily.max+
      '; в журнале '+report.daily.auditEvents+
      '. Внешние юридические и резервные подтверждения в кабинет не передаются.';
  }catch{
    output.className='alert';
    output.textContent='Проверка R20 недоступна. Это означает NO-GO, а не разрешение на работу.';
    $('r20Budget').textContent='';
  }
}
const R21_LABELS={
  allMigrationsPresent:'Миграции безопасности до версии 014 применены',
  allSecurityTablesForcedRls:'Все служебные таблицы имеют принудительный RLS',
  runtimeRoleUnprivileged:'Сервисная роль не суперпользователь и не BYPASSRLS',
  immutableHistoryNotWritable:'Журналы не допускают UPDATE/DELETE от API',
  dailyBudgetDoesNotAllowDelete:'Счётчик дневного лимита нельзя удалить через API',
  checkpointsConsistent:'Контрольные точки R17 и R18 согласованы',
  auditMatchesQuota:'Журнал операций совпадает с расходом лимита',
  noOverRetentionDrift:'Нет просроченных дней журнала по подписанному сроку'
};
async function loadR21Posture(){
  const panel=$('r21Panel'),out=$('r21Status'),list=$('r21Checks');
  panel.hidden=!manage();list.replaceChildren();
  if(!manage()||!model.selected?.item)return;
  try{
    const report=await api('/guest/pilots/'+model.selected.item.id+'/r21/posture');
    if(report.schema!=='osmanx.guest.r21.database-posture.v1'||
       !report.checks||!Array.isArray(report.blockers))
      throw Error('Неверный ответ диагностики R21');
    out.className='alert';
    out.textContent=report.technicalPostureReady?
      'База и подписанный пилот проходят локальный аудит. До независимой проверки VPS и документов клиентский запуск остаётся NO-GO.':
      'Контроль R21 обнаружил '+report.blockers.length+
        ' блокирующих причин. Сбор реальных данных не разрешён.';
    for(const [key,label] of Object.entries(R21_LABELS))
      appendText(list,'li',(report.checks[key]===true?'Проверено: ':'Не подтверждено: ')+label,'small');
    for(const label of [
      'Независимый аудит реального VPS',
      'Подтверждение слияния всей цепочки R14–R20',
      'Действующий договор, юридические основания и внешнее WORM-хранилище'
    ])appendText(list,'li','Требует независимой проверки: '+label,'small');
    $('r21Summary').textContent=
      'Записей дневного журнала: '+(Number.isSafeInteger(report.auditEventCount)?
        report.auditEventCount:'неизвестно')+
      '. Проверяемый срок истории: '+(report.retainedDays||'нет')+
      ' суток. Отчёт не включает ключи, чужие компании или персональные данные.';
  }catch{
    out.className='alert';
    out.textContent='Невозможно проверить состояние R21. Решение — NO-GO.';
    $('r21Summary').textContent='';
  }
}
const R22_LABELS={
  tenantIsolated:'Проверка относится к текущей компании',
  signedPilotScope:'Действует подписанный допуск именно этого пилота',
  emergencyHoldInactive:'Отсутствует аварийная остановка',
  sourceProtocolLocked:'Исследование имеет зафиксированный протокол',
  quotaMatchesAppendOnlyEvents:'Лимит операций совпадает с неизменяемым журналом',
  retentionRequiresNoAction:'Нет просроченных записей журнала',
  databaseSecurityPasses:'PostgreSQL: миграции, RLS и полномочия проверены',
  historicalTechnicalPasses:'Условия запуска и данные R12–R21 технически согласованы',
  independentVpsWitness:'Независимый свидетель фактической конфигурации VPS',
  twoDistinctDrCopiesVerified:'Восстановлены и сверены две отдельные DR-копии',
  twoHumanReleaseTicketVerified:'Два независимых оператора подтвердили релиз',
  allPrsMergedAndMainProtected:'Все зависимые PR слиты, ветка main защищена',
  legalAndOffsiteApproved:'Договор, правовые основания и WORM-хранение подтверждены'
};
async function loadR22LaunchReview(){
  const panel=$('r22Panel'),output=$('r22Status'),list=$('r22Checklist');
  panel.hidden=!manage();list.replaceChildren();
  if(!manage()||!model.selected?.item)return;
  try{
    const report=await api('/guest/pilots/'+model.selected.item.id+'/r22/launch-review');
    if(report.schema!=='osmanx.guest.r22.launch-review.v1'||
       !report.checks||!Array.isArray(report.pending)||
       report.customerGo!==false||report.productionAuthorized!==false)
      throw Error('Недостоверный R22 ответ');
    output.className='alert';
    const passed=report.localTechnicalReviewPossible===true;
    output.textContent=passed?
      'Локальные проверки пройдены. Реальный запуск заблокирован до независимых подписей, внешнего восстановления, правового допуска и выпуска через main.':
      'Внутренние технические условия не выполнены. Сбор данных первого клиента запрещён.';
    for(const [code,label] of Object.entries(R22_LABELS))
      appendText(list,'li',
        (report.checks[code]===true?'Проверено: ':'Ожидает подтверждения: ')+label,
        'small');
    const daily=report.daily;
    $('r22Budget').textContent=daily&&Number.isSafeInteger(daily.used)?
      'Операций сегодня: '+daily.used+' из '+daily.max+
      ', в аудите '+daily.auditEvents+
      '. Успешные тесты не заменяют самостоятельный допуск клиента.':
      'Дневной лимит и состояние аудита не подтверждены.';
  }catch{
    output.className='alert';
    output.textContent='R22: проверка недоступна. Это NO-GO.';
    $('r22Budget').textContent='';
  }
}
const R23_CHECKS={
  membershipScopedPilot:'Проверяется только собственная компания',
  noEmergencyStop:'Аварийная остановка не активна',
  frozenProtocol:'Протокол зафиксирован',
  independentSignedPilot:'Сфера допуска подписана для этого пилота',
  r12LaunchEnrolled:'Два ответственных сотрудника подтвердили запуск',
  r13ToR19Technical:'Сохранены предварительные технические допуски',
  securityMigrationsAndRls:'Применены миграции и принудительный RLS',
  noElevatedRuntimeRole:'Рабочая роль не имеет привилегий администратора',
  immutableLedgerInSync:'Аудит операций совпадает с квотой',
  retentionNeedsNoAction:'Не выявлены просроченные записи',
  orderedPrMergesVerified:'Независимое слияние девяти PR',
  realVpsCanaryVerified:'Тест реального VPS и публичного HTTPS',
  twoTenantRlsWitnessVerified:'Реальная проверка двух компаний в PostgreSQL',
  independentOffsiteDrVerified:'Независимое восстановление с внешнего хранилища',
  signedLegalDocumentsVerified:'Правовое основание и договоры проверены',
  authorizedChangeWindowVerified:'Подписано окно выпуска двумя операторами'
};
const R23_STEPS={
  review_r14_to_r22_ordered_pr_merges:'Независимо проверить и слить релизы R14–R22 по порядку',
  verify_final_main_ci_and_protected_branch:'Проверить итоговый main, актуальный CI и правила ветки',
  inspect_real_vps_https_and_loopback:'На VPS проверить loopback API и публичный HTTPS',
  run_two_tenant_rls_rehearsal:'На тестовой среде подтвердить RLS двух компаний',
  verify_independent_offsite_age_dr:'Восстановить две независимые внешние AGE-копии',
  verify_client_contract_consent_and_retention:'Проверить договор, законные основания и сроки хранения',
  independent_change_window_signoff:'Оформить независимые подписи и разрешённое окно изменения'
};
async function loadR23Handoff(){
  const panel=$('r23Panel'),status=$('r23Status'),checks=$('r23Checks'),
    steps=$('r23Steps');
  panel.hidden=!manage();checks.replaceChildren();steps.replaceChildren();
  if(!manage()||!model.selected?.item)return;
  try{
    const report=await api('/guest/pilots/'+model.selected.item.id+'/r23/handoff');
    if(report.schema!=='osmanx.guest.r23.first-customer-handoff.v1'||
      report.customerGo!==false||report.productionAuthorized!==false||
      !Array.isArray(report.pending)||!Array.isArray(report.operatorSequence))
      throw Error('Некорректный ответ R23');
    status.className='alert';
    status.textContent=report.localTechnicalPossible?
      'Внутренний контроль доступен. Публикация и сбор данных пока заблокированы до независимых проверок.':
      'Есть неподтверждённые технические условия. Запуск клиента запрещён.';
    for(const [code,label] of Object.entries(R23_CHECKS))
      appendText(checks,'li',(report.checks[code]===true?'Проверено: ':'Ожидается: ')+label,'small');
    for(const code of report.operatorSequence)
      if(R23_STEPS[code])appendText(steps,'li',R23_STEPS[code],'small');
  }catch{
    status.className='alert';
    status.textContent='R23 недоступен. Решение — NO-GO.';
  }
}
const R24_ISSUES={
  PROTOCOL_MISSING_OR_INVALID:'Не указан действующий протокол эксперимента',
  PROTOCOL_NOT_PREREGISTERED:'Регистрация протокола нуждается в проверке',
  NON_RANDOM_ASSIGNMENT:'Случайное распределение не подтверждено',
  MANUAL_AGGREGATE_SOURCE:'Необходима независимая сверка ручного источника',
  NO_OBSERVATIONS:'Нет наблюдений',
  OBSERVATION_IN_FUTURE:'Обнаружена дата из будущего',
  OBSERVATION_OUTSIDE_PROTOCOL:'Дата за границей протокола',
  UNBALANCED_PERIOD_GROUPS:'В одном из периодов группы существенно различаются',
  TARGET_SAMPLE_NOT_REACHED:'Выборка ещё не достигла целевого объёма',
  UNBALANCED_TOTAL_GROUPS:'Суммарные объёмы групп несопоставимы',
  OUTCOME_WINDOW_NOT_COMPLETED:'Окно наблюдения повторных визитов ещё не завершилось'
};
const percent=number=>typeof number==='number'&&Number.isFinite(number)?
  number.toLocaleString('ru-RU',{maximumFractionDigits:2})+' %':'Нет данных';
async function loadR24Intelligence(){
  const panel=$('r24Panel'),summary=$('r24Status'),
    warnings=$('r24Quality'),actions=$('r24Decisions');
  panel.hidden=!manage();warnings.replaceChildren();actions.replaceChildren();
  if(!manage()||!model.selected?.item)return;
  try{
    const report=await api('/guest/pilots/'+model.selected.item.id+'/r24/intelligence');
    if(report.schema!=='osmanx.guest.r24.manager-brief.v1'||
       !report.statistics||!report.scenario||!Array.isArray(report.decisions)||
       report.customerGo!==false||report.productionAuthorized!==false||
       report.causalEffectProven!==false)
      throw Error('Неверная структура аналитического отчёта');
    const stats=report.statistics,econ=report.scenario;
    summary.className=report.stopped||report.quality.analysisStatus==='BLOCKED'?'alert':'info';
    summary.textContent=(report.stopped?'Сбор остановлен. ':'')+
      'Изучено '+report.observedPeriods+' периодов; статус: '+
      ({NO_DATA:'нет данных',QUALITY_BLOCKED:'ошибки качества',
        EXPLORATORY:'предварительный результат',
        ELIGIBLE_FOR_INDEPENDENT_REVIEW:'нужна независимая проверка'}[stats.state]||stats.state)+
      '. Причинный эффект не подтверждён.';
    $('r24ControlRate').textContent=percent(stats.controlRatePct);
    $('r24OfferRate').textContent=percent(stats.offerRatePct);
    $('r24Difference').textContent=typeof stats.differencePp==='number'?
      stats.differencePp.toLocaleString('ru-RU',{maximumFractionDigits:2})+' п.п.':'—';
    $('r24Interval').textContent=stats.interval95Pp?
      'Приблизительный 95% интервал разницы: '+
      stats.interval95Pp.map(v=>v.toLocaleString('ru-RU')).join(' — ')+
      ' п.п. Не учитывает кластеризацию и ошибки отбора.':
      'Статистический интервал ещё не доступен.';
    $('r24Economics').textContent=econ.state==='SCENARIO_ONLY'&&
       typeof econ.observedDifferenceScenarioRub==='number'?
      'Сценарная модель: '+currencies.format(econ.observedDifferenceScenarioRub)+
      '; безубыточная разница: '+percent(econ.breakEvenDifferencePp)+
      '. Это не реальная прибыль.':
      'Финансовая модель не готова: требуется проверить исходные допущения.';
    for(const code of report.quality.issues)
      appendText(warnings,'li',R24_ISSUES[code]||'Требует проверки: '+code,'small');
    if(report.quality.issues.length===0)
      appendText(warnings,'li','Автоматические проверки не выявили нарушений. Первичные данные всё ещё требуют подтверждения.','small');
    for(const action of report.decisions)
      appendText(actions,'li',action.title+'. '+action.next+
        ' Подтверждение: '+action.evidence,'small');
  }catch{
    summary.className='alert';
    summary.textContent='Аналитика R24 недоступна. Нельзя принимать решения без проверенных данных.';
    $('r24ControlRate').textContent='—';$('r24OfferRate').textContent='—';
    $('r24Difference').textContent='—';$('r24Interval').textContent='';
    $('r24Economics').textContent='';
  }
}
const R25_BARRIER_LABELS={
  wait:'Ожидание',stockout:'Нет нужной позиции',
  ordering:'Сложность заказа',price:'Неясная цена',
  service:'Обслуживание',unknown:'Нет подтверждённого признака'
};
const R25_SHIFT_LABELS={morning:'утро',afternoon:'день',evening:'вечер'};
const R25_BLOCKER_LABELS={
  NO_PRIOR_OPERATIONAL_SIGNALS:'Мало анонимных наблюдений',
  SAMPLE_TARGET_UNAVAILABLE:'Не задан целевой объём',
  RETURN_WINDOW_UNAVAILABLE:'Нет окна повторного визита',
  EMERGENCY_HOLD_REQUIRES_REVIEW:'Сбор остановлен',
  DATA_QUALITY_REVIEW_REQUIRED:'Ошибки качества первичных агрегатов',
  EXISTING_PILOT_NOT_FINALIZED:'Текущий пилот ещё не завершён'
};
async function loadR25Insights(){
  const panel=$('r25Panel'),status=$('r25Status'),categories=$('r25Categories'),
    periods=$('r25Comparison'),hypotheses=$('r25Hypotheses');
  panel.hidden=!manage();
  categories.replaceChildren();periods.replaceChildren();hypotheses.replaceChildren();
  $('r25EntryFieldset').disabled=true;
  if(!manage()||!model.selected?.item)return;
  try{
    const report=await api('/guest/pilots/'+model.selected.item.id+'/r25/insights');
    if(report.schema!=='osmanx.guest.r25.operational-brief.v1'||
       report.customerGo!==false||report.productionAuthorized!==false||
       report.causalExplanationProven!==false||
       report.individualGuestsLinked!==false||report.signed!==false||
       report.profile?.schema!=='osmanx.guest.r25.operational-profile.v1'||
       !report.board||!report.nextExperiment)
      throw Error('Недостоверная версия операционного отчёта');
    const p=report.profile,comparison=p.periodComparison;
    status.className=report.emergencyStopActive?'alert':'info';
    status.textContent=report.emergencyStopActive?
      'Аварийная остановка активна. Разрешён только просмотр уже собранных агрегатов.':
      'Сводки относятся к наблюдаемым препятствиям, а не к доказанным причинам ухода.';
    $('r25Sampled').textContent=String(p.totalSampled);
    $('r25Shifts').textContent=String(p.recordedShifts);
    $('r25Leader').textContent=p.dominantObservedBarrier?
      R25_BARRIER_LABELS[p.dominantObservedBarrier.code]:'Недостаточно данных';
    for(const [code,label] of Object.entries(R25_BARRIER_LABELS)){
      const item=p.categoryShares[code];
      const li=appendText(categories,'li',label+': '+percent(item.sharePct)+
        ' (агрегат '+item.observed+')','small');
      if(typeof item.sharePct==='number'){
        const meter=document.createElement('meter');
        meter.min=0;meter.max=100;meter.value=item.sharePct;
        meter.setAttribute('aria-label',label+' '+percent(item.sharePct));
        li.append(meter);
      }
    }
    if(comparison.comparable){
      for(const [code,label] of Object.entries(R25_BARRIER_LABELS)){
        const item=comparison.changes[code];
        appendText(periods,'li',label+': раньше '+percent(item.earlyPct)+
          ', позже '+percent(item.latePct)+
          '; изменение '+(item.changePp??0).toLocaleString('ru-RU')+
          ' п.п. (не причинная оценка)','small');
      }
    }else appendText(periods,'li',
      'Недостаточно разных дат и наблюдений, чтобы сравнить ранний и поздний периоды.','small');
    for(const idea of report.board.hypotheses.filter(x=>x.signalAvailable).slice(0,5)){
      appendText(hypotheses,'li',idea.title+': '+percent(idea.sharePct)+
        '. Проверка: '+idea.test+
        ' Независимое доказательство: '+idea.verification,'small');
    }
    if(!hypotheses.childNodes.length)
      appendText(hypotheses,'li','Подтверждённых данных для ранжирования гипотез пока недостаточно.','small');
    const draft=report.nextExperiment;
    $('r25NextTest').textContent=draft.eligibleForHumanDesignReview?
      'Черновик нового эксперимента: '+draft.selectedHypothesis.title+
      '. Период '+draft.protocolDraft.exposureStart+' — '+
      draft.protocolDraft.exposureEnd+
      '. Нужны предрегистрация, независимая контрольная группа, правовой допуск и проверка выборки.':
      'Начинать новый эксперимент нельзя: '+draft.blockers.map(x=>R25_BLOCKER_LABELS[x]||x).join('; ')+'.';
    $('r25EntryFieldset').disabled=report.recordingAvailable!==true;
  }catch{
    status.className='alert';
    status.textContent='Операционная диагностика R25 недоступна; выводы и ввод запрещены.';
    $('r25Sampled').textContent='—';$('r25Shifts').textContent='—';
    $('r25Leader').textContent='—';$('r25NextTest').textContent='';
  }
}
const R26_BIAS_LABELS={
  LIMITED_ANONYMOUS_SAMPLE:'Малая выборка анонимных агрегатов',
  SHIFT_COVERAGE_LIMITED:'Недостаточно разных смен',
  ONE_SHIFT_DOMINATES_SAMPLE:'Одна смена преобладает над остальными',
  STAFF_ESTIMATE_DOMINATES_SOURCE:'Большинство сигналов — оценки персонала',
  UNKNOWN_CATEGORY_TOO_LARGE:'Много наблюдений без подтверждённого признака',
  SHIFT_COMPOSITION_CHANGED:'В раннем и позднем периодах разный состав смен',
  SOURCE_COMPOSITION_CHANGED:'Сменился способ подсчёта',
  LEADER_UNSTABLE_LEAVE_ONE_DAY_OUT:'Лидер категорий меняется при исключении одного дня',
  POSSIBLE_AGGREGATE_TREND_REVERSAL:'Есть риск противоречия общей и посменной тенденции',
  NO_ANONYMOUS_TALLIES:'Данные ещё не собраны'
};
const R26_REVIEW_BLOCKERS={
  NO_SIGNALS_TO_AUDIT:'Нет анонимных данных для сверки',
  EMERGENCY_STOP_ACTIVE:'Активна аварийная остановка',
  OWNER_REVIEW_MISSING_OR_DUPLICATE:'Нет актуального решения владельца',
  MANAGER_REVIEW_MISSING_OR_DUPLICATE:'Нет актуального решения управляющего',
  INTERNAL_REVIEW_REJECTED:'Одна из проверок отклонила источник',
  REVIEW_ACTORS_NOT_SEPARATE:'Ответственные лица не разделены',
  REVIEW_WORKPAPERS_NOT_DISTINCT:'Оба ответственных указали одинаковый документ'
};
const R26_METHOD_NAMES={
  staff_shift_crosscheck:'Сверка сменных оценок',
  anonymous_counter_audit:'Проверка счётчика',
  independent_aggregate_recount:'Пересчёт агрегатов'
};
let currentR26=null;
async function loadR26Reliability(){
  const panel=$('r26Panel'),status=$('r26Status'),
    notes=$('r26BiasWarnings'),reviews=$('r26ReviewList');
  panel.hidden=!manage();notes.replaceChildren();reviews.replaceChildren();
  currentR26=null;$('r26ReviewFieldset').disabled=true;
  if(!manage()||!model.selected?.item)return;
  try{
    const data=await api('/guest/pilots/'+model.selected.item.id+'/r26/reliability');
    if(data.schema!=='osmanx.guest.r26.source-reliability-brief.v1'||
      data.productionAuthorized!==false||data.customerGo!==false||
      data.customerMotivesEstablished!==false||
      data.externalAuditCompleted!==false||
      data.review?.schema!=='osmanx.guest.r26.source-review-gate.v1'||
      data.bias?.schema!=='osmanx.guest.r26.source-bias.v1'||
      data.decision?.schema!=='osmanx.guest.r26.owner-decision.v1')
      throw Error('Данные R26 не прошли проверку формата');
    currentR26=data;
    $('r26Rows').textContent=String(data.sourceRowCount);
    $('r26StaffShare').textContent=percent(data.bias.sourceMix.staffPct);
    $('r26ShiftDrift').textContent=percent(data.bias.earlyLateShiftDriftPct);
    status.className=data.stopActive||data.review.blockers.length?'alert':'info';
    status.textContent=data.stopActive?
      'Экстренная остановка. Просмотр доступен, новые проверки запрещены.':
      data.review.internalDeclarationsComplete?
      'Внутренние сверки зафиксированы. Независимая внешняя проверка всё ещё необходима.':
      'Внутренние сверки не завершены. Не делайте причинных выводов.';
    if(data.bias.warnings.length===0)
      appendText(notes,'li','Автоматических признаков искажений не найдено. Первичный источник всё ещё требует внешней проверки.','small');
    for(const code of data.bias.warnings)
      appendText(notes,'li',R26_BIAS_LABELS[code]||'Дополнительная проверка: '+code,'small');
    for(const role of ['owner','manager']){
      const record=data.review.current[role];
      appendText(reviews,'li',
        (role==='owner'?'Владелец':'Управляющий')+': '+
        (!record.present?'ожидается независимая сверка':
         (record.verdict==='reconciled'?'сверено':'отклонено')+
         ' / '+(R26_METHOD_NAMES[record.method]||'проверка источника')),'small');
    }
    for(const code of data.review.blockers)
      appendText(reviews,'li',R26_REVIEW_BLOCKERS[code]||code,'small');
    const d=data.decision.firstAction;
    $('r26NextAction').textContent=d.title+': '+d.task;
    $('r26EvidenceRequired').textContent='Подтвердить: '+d.evidence+
      '. Это рекомендация, а не автоматически запущенное действие.';
    const role=model.me?.role;
    $('r26ReviewFieldset').disabled=
      data.reviewEnabled!==true||data.stopActive===true||
      data.review.current?.[role]?.present!==false;
  }catch{
    status.className='alert';
    status.textContent='R26 недоступен. Источники не подтверждены, новый ввод запрещён.';
    $('r26Rows').textContent='—';$('r26StaffShare').textContent='—';
    $('r26ShiftDrift').textContent='—';$('r26NextAction').textContent='';
    $('r26EvidenceRequired').textContent='';
  }
}
const R27_CASE_LABELS={
  normal:'Нормальный обезличенный сценарий',
  emergency_stop:'Аварийная остановка',
  no_operational_signals:'Нет операционных сигналов',
  rejected_internal_review:'Сотрудник отклонил первичный источник',
  source_mix_shift:'Сменился способ подсчёта',
  stale_version_reviews:'Подтверждения устарели после изменения версии',
  negative_observed_difference:'Отрицательная наблюдаемая разница'
};
const R27_STAGE_LABELS={
  INTEGRITY_CONFLICT:'Конфликт версий данных',
  SAFETY_HOLD:'Аварийная остановка',
  DATA_BLOCKED:'Недостоверные агрегаты',
  SOURCE_REVIEW_PENDING:'Внутренние сверки не завершены',
  SHIFT_BIAS_REVIEW:'Возможны искажения состава смен',
  MORE_EVIDENCE_REQUIRED:'Нужны дополнительные наблюдения',
  EXTERNAL_REVIEW_REQUIRED:'Ожидается независимый аудит'
};
const R27_BLOCKERS={
  R27_CROSS_LAYER_SNAPSHOT_CONFLICT:'Разные версии или SHA-256 сводок',
  R27_EXTERNAL_SOURCE_AUDIT_REQUIRED:'Независимая проверка источников не проведена',
  R27_LEGAL_AND_PRODUCTION_APPROVAL_REQUIRED:'Нет отдельного юридического и эксплуатационного допуска',
  R27_REAL_CLIENT_CONTRACT_AND_LAWFUL_BASIS_REQUIRED:'Договор и законное основание обработки не подтверждены',
  R27_INDEPENDENT_VPS_AND_DR_REVIEW_REQUIRED:'Физический VPS и внешнее восстановление не прошли приёмку',
  R27_HUMAN_MERGE_AND_CHANGE_TICKET_REQUIRED:'Не выполнены ручные слияния PR и change-ticket',
  R27_TECHNICAL_OR_MODEL_REVIEW_REQUIRED:'Не все технические сценарии завершились успешно'
};
const R27_NEXT_ACTIONS={
  SAFETY_STOP:'Проверить аварийную остановку',
  COLLECT_EVIDENCE:'Проверить достаточность анонимных данных',
  SOURCE_AUDIT:'Получить две независимые внутренние сверки',
  EXTERNAL_AUDIT:'Организовать внешний аудит источников',
  SHIFT_REBALANCE:'Проверить смещение смен и способов подсчёта',
  EXPLORATORY_REVIEW:'Проверить рабочую гипотезу',
  PROTOCOL_DESIGN:'Подготовить новый предрегистрированный эксперимент'
};
async function loadR27Readiness(){
  const panel=$('r27Panel'),status=$('r27Status'),
    cases=$('r27Cases'),blockers=$('r27Blockers');
  panel.hidden=!manage();cases.replaceChildren();blockers.replaceChildren();
  if(!manage()||!model.selected?.item)return;
  try{
    const id=model.selected.item.id;
    const [packet,rehearsal]=await Promise.all([
      api('/guest/pilots/'+id+'/r27/readiness'),
      api('/guest/pilots/'+id+'/r27/rehearsal')
    ]);
    if(packet.schema!=='osmanx.guest.r27.operator-handoff.v1'||
       packet.pilotId!==id||
       packet.customerGo!==false||packet.productionAuthorized!==false||
       packet.externalAuditVerified!==false||
       packet.authorizedOperatorSignature!==false||
       packet.productionDeploymentExecuted!==false||
       packet.rehearsal?.allSynthetic!==true||
       packet.rehearsal?.sha256!==rehearsal.sha256||
       rehearsal.schema!=='osmanx.guest.r27.synthetic-first-client-rehearsal.v1'||
       rehearsal.realCustomerDataUsed!==false||
       rehearsal.runtimeExternalCalls!==0||
       !Array.isArray(rehearsal.cases)||rehearsal.cases.length!==7||
       !Array.isArray(packet.blockers))
      throw Error('Не удалось доказать подлинность структуры технического отчёта');
    $('r27Passed').textContent=String(rehearsal.passedCases)+' / '+
      String(rehearsal.totalCases);
    $('r27Stage').textContent=R27_STAGE_LABELS[packet.decision.stage]||
      'Нужен независимый разбор';
    $('r27Expiry').textContent=new Date(packet.expiresAt).toLocaleString('ru-RU',{
      year:'numeric',month:'2-digit',day:'2-digit',
      hour:'2-digit',minute:'2-digit'
    });
    status.className='alert';
    status.textContent='NO-GO · '+(rehearsal.allPassed?
      'Синтетический сквозной прогон завершён. Коммерческая приёмка ещё не пройдена.':
      'Часть синтетических проверок завершилась ошибкой. Реальный запуск запрещён.');
    for(const item of rehearsal.cases)
      appendText(cases,'li',(item.passed?'ПРОЙДЕНО · ':'НЕ ПРОЙДЕНО · ')+
        (R27_CASE_LABELS[item.caseId]||'Технический сценарий'),'small');
    for(const code of packet.blockers)
      appendText(blockers,'li',R27_BLOCKERS[code]||
        'Требуется дополнительная проверка: '+code,'small');
    $('r27NextAction').textContent=R27_NEXT_ACTIONS[packet.decision.firstActionCode]||
      'Независимая оценка первичных доказательств';
    $('r27Evidence').textContent='Нужны независимая проверка источников, '+
      'юридическое основание, восстановление на VPS и отдельное решение оператора. '+
      'В пакете нет цифровой подписи или разрешения на production.';
  }catch{
    status.className='alert';
    status.textContent='R27 недоступен. Не принимать решения по непроверенным данным.';
    $('r27Passed').textContent='—';$('r27Stage').textContent='—';
    $('r27Expiry').textContent='—';$('r27NextAction').textContent='';
    $('r27Evidence').textContent='';
  }
}
const R28_STAGES={
  STOP:'Аварийная остановка',
  SOURCE_CHAIN_UNVERIFIED:'Цепочка исходных PR ещё не удостоверена',
  MANUAL_MERGE_PENDING:'Требуются ручные слияния',
  MAIN_CI_PENDING:'CI на итоговом main не проверен',
  EXTERNAL_RECEIPTS_PENDING:'Внешние подписи ещё не подтверждены',
  EXTERNAL_HOST_LEGAL_AND_ROLLBACK_PENDING:'Требуются внешний аудит, правовое основание и откат'
};
const R28_BLOCKER_LABELS={
  R28_SOURCE_CI_NOT_INDEPENDENTLY_REVIEWED:'Не выполнена независимая проверка исходных 14 PR',
  R28_MANUAL_MERGES_OUTSTANDING:'Не проведены ручные последовательные слияния',
  R28_MAIN_MERGED_TREE_CI_NOT_RUN:'Нет новой приёмки на итоговом main',
  R28_FOUR_INDEPENDENT_RECEIPTS_MISSING:'Нет четырёх проверенных подписанных квитанций',
  R28_EMERGENCY_STOP_ACTIVE:'Действует аварийная остановка',
  R28_PILOT_EVIDENCE_CONFLICT:'Снимки данных пилота противоречат друг другу',
  R28_LIVE_VPS_NOT_INDEPENDENTLY_VERIFIED:'Настоящий VPS не проверен независимым оператором',
  R28_OFFSITE_DR_NOT_INDEPENDENTLY_VERIFIED:'Внешние восстановленные архивы не подтверждены',
  R28_LAWFUL_BASIS_NOT_VERIFIED:'Не подтверждено законное основание обработки',
  R28_MANUAL_CHANGE_WINDOW_AND_ROLLBACK_NOT_APPROVED:'Не утверждены окно изменений и репетиция отката'
};
async function loadR28OperatorStatus(){
  const panel=$('r28Panel'),status=$('r28Status'),
    tasks=$('r28Tasks'),issues=$('r28Blockers');
  panel.hidden=!manage();tasks.replaceChildren();issues.replaceChildren();
  if(!manage()||!model.selected?.item)return;
  try{
    const packet=await api('/guest/pilots/'+model.selected.item.id+'/r28/readiness');
    if(packet.schema!=='osmanx.guest.r28.manual-operator-packet.v1'||
       packet.pilotId!==model.selected.item.id||
       packet.customerGo!==false||
       packet.productionAuthorized!==false||
       packet.automaticMergeAllowed!==false||
       packet.actualProductionInspected!==false||
       packet.cryptographicPublisherSignature!==false||
       packet.generatedAsHumanReviewOnly!==true||
       !Array.isArray(packet.operatorSteps)||
       packet.operatorSteps.length!==7||
       !Array.isArray(packet.blockers)||
       !packet.blockers.includes('R28_LIVE_VPS_NOT_INDEPENDENTLY_VERIFIED'))
      throw Error('R28 requires complete signed-evidence gap report');
    status.className='alert';
    status.textContent='NO-GO — автоматический запуск и сбор данных запрещены. '+
      'Выпуск возможен только после независимой внешней приёмки.';
    $('r28Stage').textContent=R28_STAGES[packet.stage]||
      'Требуется ручная проверка';
    $('r28Verified').textContent=String(packet.verifiedSourcePrs)+' / 14';
    $('r28Expiry').textContent=new Date(packet.expiresAt).toLocaleString('ru-RU',{
      year:'numeric',month:'2-digit',day:'2-digit',
      hour:'2-digit',minute:'2-digit'
    });
    for(const item of packet.operatorSteps)
      appendText(tasks,'li',item.label+
        '. Доказательство: '+item.proofRequired+
        '. Статус: не выполнено в этой системе.','small');
    for(const code of packet.blockers)
      appendText(issues,'li',R28_BLOCKER_LABELS[code]||code,'small');
    $('r28Next').textContent='Первое действие: проверить цепочку GitHub из 14 PR '+
      'и получить независимый review. Обработка настоящих гостей не разрешена.';
  }catch{
    status.className='alert';
    status.textContent='R28 недоступен. Нельзя принимать решение о запуске.';
    $('r28Stage').textContent='NO-GO';
    $('r28Verified').textContent='—';
    $('r28Expiry').textContent='—';
    $('r28Next').textContent='Проверка не выполнена.';
  }
}
const R29_GAPS={
  R29_FIFTEEN_PR_SOURCE_TREE_NOT_VERIFIED_IN_API:'15 PR и Git-деревья требуют независимой проверки',
  R29_MERGED_MAIN_CI_NOT_VERIFIED:'CI на итоговом main ещё не проверен',
  R29_REAL_STAGING_ORIGIN_NOT_PROBED:'Реальный staging HTTPS не проверен',
  R29_ACTUAL_ROLLBACK_NOT_PERFORMED:'Реальный откат не проводился',
  R29_EXTERNAL_VPS_DR_LEGAL_REVIEW_REQUIRED:'Не проведён независимый VPS/DR и правовой аудит'
};
async function loadR29Acceptance(){
  const panel=$('r29Panel'),list=$('r29Blockers');
  panel.hidden=!manage();list.replaceChildren();
  if(!manage()||!model.selected?.item)return;
  try{
    const x=await api('/guest/pilots/'+model.selected.item.id+'/r29/readiness');
    if(x.schema!=='osmanx.guest.r29.manual-staging-review.v1'||
       x.pilotId!==model.selected.item.id||
       x.sourcePrsRequired!==15||
       x.verifiedSourcePrsInApi!==0||
       x.customerGo!==false||x.productionAuthorized!==false||
       x.mainChanged!==false||x.stopLifted!==false||
       x.actualStagingVerified!==false||
       x.stagedSynthetic?.total!==6||
       !Array.isArray(x.blockers)||
       !x.blockers.includes('R29_ACTUAL_ROLLBACK_NOT_PERFORMED'))
      throw Error('R29 evidence invalid or unauthorized');
    $('r29Status').textContent='NO-GO — независимая эксплуатационная приёмка не проведена.';
    $('r29PrCount').textContent='0 / 15';
    $('r29Synthetic').textContent=String(x.stagedSynthetic.passed)+' / 6';
    $('r29Expires').textContent=new Date(x.expiresAt).toLocaleString('ru-RU',{
      year:'numeric',month:'2-digit',day:'2-digit',
      hour:'2-digit',minute:'2-digit'
    });
    for(const code of x.blockers)
      appendText(list,'li',R29_GAPS[code]||code,'small');
  }catch{
    $('r29Status').textContent='NO-GO — R29 недоступен; результаты неподтверждены.';
    $('r29PrCount').textContent='—';$('r29Synthetic').textContent='—';
    $('r29Expires').textContent='—';
  }
}
const R30_GAPS={
  R30_SIXTEEN_PRS_REQUIRE_INDEPENDENT_REVIEW:'16 PR нуждаются в независимом код-ревью и ручном объединении',
  R30_FRESH_MERGED_MAIN_CI_REQUIRED:'Нет свежего успешного CI итогового main',
  R30_ACTUAL_STAGING_WITNESS_REQUIRED:'Нет подтверждённой реальной staging-проверки',
  R30_INDEPENDENT_ED25519_QUORUM_REQUIRED:'Нет четырёх независимых подписанных свидетельств',
  R30_OFFSITE_DR_AND_ACTUAL_ROLLBACK_REQUIRED:'Не доказано внешнее восстановление и настоящий откат',
  R30_LAWFUL_BASIS_AND_CLIENT_APPROVAL_REQUIRED:'Не подтверждены правовое основание и договор клиента',
  R30_OPERATOR_CHANGE_WINDOW_REQUIRED:'Не утверждено окно ручного изменения'
};
async function loadR30Acceptance(){
  const panel=$('r30Panel'),list=$('r30Blockers');
  panel.hidden=!manage();list.replaceChildren();
  if(!manage()||!model.selected?.item)return;
  try{
    const x=await api('/guest/pilots/'+model.selected.item.id+'/r30/readiness');
    if(x.schema!=='osmanx.guest.r30.independent-acceptance.v1'||
      x.pilotId!==model.selected.item.id||x.sourcePrsRequired!==16||
      x.sourcePrsVerifiedInApi!==0||x.productionAuthorized!==false||
      x.customerGo!==false||x.actualStagingVerified!==false||
      x.guestWritesEnabled!==false||x.stopLifted!==false||
      x.externalReceipts?.verifiedInApi!==0||
      !Array.isArray(x.blockers)||
      !x.blockers.includes('R30_FRESH_MERGED_MAIN_CI_REQUIRED'))
      throw Error('R30 failed closed');
    $('r30Status').textContent='NO-GO — нет независимых эксплуатационных свидетельств';
    $('r30PrCount').textContent='0 / 16';
    $('r30Signers').textContent='0 / 4';
    $('r30Expires').textContent=new Date(x.expiresAt).toLocaleString('ru-RU',{
      year:'numeric',month:'2-digit',day:'2-digit',
      hour:'2-digit',minute:'2-digit'
    });
    for(const code of x.blockers)
      appendText(list,'li',R30_GAPS[code]||R29_GAPS[code]||code,'small');
  }catch{
    $('r30Status').textContent='NO-GO — статус R30 недоступен или неподтверждён';
    $('r30PrCount').textContent='—';$('r30Signers').textContent='—';
    $('r30Expires').textContent='—';
  }
}
const R31_GAPS={
  R31_SEVENTEEN_PRS_REQUIRE_HUMAN_REVIEW:'17 PR требуют ручного code review и поочерёдного объединения',
  R31_FRESH_POST_MERGE_MAIN_CI_MISSING:'Нет CI окончательной объединённой ветки main',
  R31_REAL_STAGING_OPERATOR_GET_NOT_EXECUTED_IN_API:'Реальный staging проверяется отдельно одобренным оператором',
  R31_FOUR_SIGNED_INDEPENDENT_WITNESSES_MISSING:'Нет четырёх независимых Ed25519 подтверждений',
  R31_OFFSITE_DR_PROOF_AND_ROLLBACK_NOT_VERIFIED:'Не доказаны внешнее восстановление и настоящий откат',
  R31_LAWFUL_BASIS_AND_CLIENT_CONTRACT_NOT_VERIFIED:'Не проверены законное основание и договор',
  R31_MANUAL_CHANGE_WINDOW_UNAPPROVED:'Не утверждено окно изменений'
};
async function loadR31Acceptance(){
  const panel=$('r31Panel'),list=$('r31Blockers');
  panel.hidden=!manage();list.replaceChildren();
  if(!manage()||!model.selected?.item)return;
  try{
    const x=await api('/guest/pilots/'+model.selected.item.id+'/r31/readiness');
    if(x.schema!=='osmanx.guest.r31.operator-handoff.v1'||
      x.pilotId!==model.selected.item.id||x.sourcePrsRequired!==17||
      x.sourcePrsCheckedInApi!==0||x.customerGo!==false||
      x.productionGo!==false||x.guestWritesEnabled!==false||
      x.stopLifted!==false||x.staging?.realVpsProbedInApi!==false||
      x.witnesses?.verifiedInApi!==0||
      !Array.isArray(x.blockers)||
      !x.blockers.includes('R31_FRESH_POST_MERGE_MAIN_CI_MISSING'))
      throw Error('R31 evidence rejected');
    $('r31Status').textContent='NO-GO — внешние доказательства не подтверждены';
    $('r31Sources').textContent='0 / 17';
    $('r31Witnesses').textContent='0 / 4';
    $('r31Expiry').textContent=new Date(x.expiresAt).toLocaleString('ru-RU',{
      year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'
    });
    for(const code of x.blockers)
      appendText(list,'li',R31_GAPS[code]||R30_GAPS[code]||R29_GAPS[code]||code,'small');
  }catch{
    $('r31Status').textContent='NO-GO — проверка R31 недоступна';
    $('r31Sources').textContent='—';
    $('r31Witnesses').textContent='—';
    $('r31Expiry').textContent='—';
  }
}
const R32_GAPS={
  R32_EIGHTEEN_PRS_NEED_HUMAN_REVIEW:'18 PR требуют независимого ревью и ручного объединения',
  R32_SIGNED_CHANGE_WINDOW_NOT_VERIFIED:'Окно изменений не подписано двумя ответственными',
  R32_TWO_REAL_STAGING_SAMPLES_NOT_OBSERVED:'Нет двух независимых staging-наблюдений',
  R32_RECOVERY_RTO_RPO_NOT_INDEPENDENTLY_ATTESTED:'Не подтверждены сроки восстановления и RPO',
  R32_REAL_OFFSITE_AND_ROLLBACK_EVIDENCE_MISSING:'Нет доказательств внешнего хранения и реального отката',
  R32_CLIENT_CONTRACT_AND_LAWFUL_BASIS_UNVERIFIED:'Не проверены договор и правовое основание',
  R32_FRESH_POST_MERGE_MAIN_CI_MISSING:'Не завершён CI итогового объединённого main'
};
async function loadR32Acceptance(){
  const panel=$('r32Panel'),list=$('r32Blockers');
  panel.hidden=!manage();list.replaceChildren();
  if(!manage()||!model.selected?.item)return;
  try{
    const x=await api('/guest/pilots/'+model.selected.item.id+'/r32/readiness');
    if(x.schema!=='osmanx.guest.r32.manual-release-readiness.v1'||
      x.pilotId!==model.selected.item.id||x.sourcePrsRequired!==18||
      x.sourcePrsVerifiedInApi!==0||x.productionAuthorized!==false||
      x.customerGo!==false||x.stopLifted!==false||
      x.staging?.realSamplesVerifiedInApi!==0||
      x.changeWindow?.verifiedInApi!==0||
      x.recovery?.rtoRpoIndependentlyWitnessed!==false||
      !Array.isArray(x.blockers)||
      !x.blockers.includes('R32_FRESH_POST_MERGE_MAIN_CI_MISSING'))
      throw Error('R32 unsafe or incomplete');
    $('r32Status').textContent='NO-GO — реальные доказательства не проверены';
    $('r32Sources').textContent='0 / 18 PR';
    $('r32Snapshots').textContent='0 / 2';
    $('r32Expiry').textContent=new Date(x.expiresAt).toLocaleString('ru-RU',{
      year:'numeric',month:'2-digit',day:'2-digit',
      hour:'2-digit',minute:'2-digit'
    });
    for(const code of x.blockers)
      appendText(list,'li',R32_GAPS[code]||
        R31_GAPS[code]||R30_GAPS[code]||R29_GAPS[code]||code,'small');
  }catch{
    $('r32Status').textContent='NO-GO — статус R32 не подтверждён';
    $('r32Sources').textContent='—';$('r32Snapshots').textContent='—';
    $('r32Expiry').textContent='—';
  }
}
const R33_GAPS={
  R33_NINETEEN_PRS_REQUIRE_HUMAN_MERGE:'19 PR требуют независимого ревью и последовательного ручного объединения',
  R33_POST_MERGE_MAIN_CI_REQUIRED:'Нет успешного CI финального main после объединения',
  R33_TWO_SIGNED_STAGING_WITNESSES_MISSING:'Нет двух подписей независимых свидетелей staging',
  R33_LIVE_TLS_DNS_AND_VPS_NOT_WITNESSED:'Реальные TLS, DNS и VPS не проверены независимым оператором',
  R33_DISPOSABLE_ROLLBACK_ONLY:'Проверка отката пока ограничена одноразовой тестовой базой',
  R33_ACTUAL_OFFSITE_RESTORE_NOT_PROVED:'Отсутствует подтверждение реального внешнего восстановления',
  R33_CLIENT_PRIVACY_AND_LAWFUL_BASIS_MISSING:'Не проверены договор, политика данных и законное основание',
  R33_CHANGE_WINDOW_AND_PRODUCTION_APPROVAL_MISSING:'Нет согласованного окна изменения и допуска production'
};
async function loadR33Acceptance(){
  const panel=$('r33Panel'),list=$('r33Blockers');
  panel.hidden=!manage();list.replaceChildren();
  if(!manage()||!model.selected?.item)return;
  try{
    const x=await api('/guest/pilots/'+model.selected.item.id+'/r33/readiness');
    if(x.schema!=='osmanx.guest.r33.independent-review-readiness.v1'||
      x.pilotId!==model.selected.item.id||x.source?.prsRequired!==19||
      x.source?.prsVerifiedInApi!==0||
      x.staging?.verifiedInApi!==0||
      x.privacy?.signaturesVerifiedInApi!==0||
      x.rollback?.liveRollbackPerformed!==false||
      x.productionAuthorized!==false||x.customerGo!==false||
      x.stopLifted!==false||x.guestWritesEnabled!==false||
      !Array.isArray(x.blockers)||
      !x.blockers.includes('R33_POST_MERGE_MAIN_CI_REQUIRED'))
      throw Error('R33 status failed closed');
    $('r33Status').textContent='NO-GO — нужна независимая эксплуатационная приёмка';
    $('r33Sources').textContent='0 / 19';
    $('r33Staging').textContent='0 / 2';
    $('r33Privacy').textContent='0 / 2';
    $('r33Expiry').textContent='Отчёт действителен до: '+
      new Date(x.expiresAt).toLocaleString('ru-RU',{
        year:'numeric',month:'2-digit',day:'2-digit',
        hour:'2-digit',minute:'2-digit'
      });
    for(const code of x.blockers)
      appendText(list,'li',R33_GAPS[code]||R32_GAPS[code]||
        R31_GAPS[code]||R30_GAPS[code]||R29_GAPS[code]||code,'small');
  }catch{
    $('r33Status').textContent='NO-GO — статус R33 не подтверждён';
    $('r33Sources').textContent='—';$('r33Staging').textContent='—';
    $('r33Privacy').textContent='—';$('r33Expiry').textContent='Срок отчёта: —';
  }
}
async function loadReport(){
  if(!model.selected)return;
  model.report=await api('/guest/pilots/'+model.selected.item.id+'/report');
  $('reportBox').textContent=model.report.report ||
    'Нет наблюдений. Загрузите обезличенные показатели после запуска пилота.';
}
const LAUNCH_LABELS={
  enrolled:'Режим R12 включён',
  draft:'Пилот в черновике',
  protocol:'Зафиксирован протокол',
  prospective:'Протокол зарегистрирован заблаговременно',
  measurementWindow:'Срок наблюдения ещё не завершён',
  sixReadiness:'Шесть условий подготовлены',
  ownerPresent:'Действующий владелец',
  managerPresent:'Действующий управляющий',
  ownerSigned:'Актуальное подтверждение владельца',
  managerSigned:'Актуальное подтверждение управляющего',
  independent:'Подтверждения от разных сотрудников'
};
function updateLaunchButtons(){
  const pilot=model.selected?.item,gate=model.launchGate;
  if(!pilot)return;
  const draft=pilot.phase==='draft',isManage=manage();
  $('launchGateEnroll').hidden=!draft||!!gate?.enrolled||model.me?.role!=='owner';
  $('launchGateEnroll').disabled=!draft||model.me?.role!=='owner'||!!gate?.enrolled;
  const role=model.me?.role;
  const otherBlockers=gate?.blockers?.filter(b=>
    !['ownerSigned','managerSigned','independent'].includes(b.code))||[];
  $('launchGateAttest').hidden=!draft||!gate?.enrolled||!isManage;
  $('launchGateAttest').disabled=!draft||!gate?.enrolled||!isManage||
    otherBlockers.length>0||!!gate?.attestations?.[role]?.current;
  $('launchGateExport').hidden=!isManage;
  $('launchGateExport').disabled=!isManage;
  $('start').disabled=!isManage||!draft||(gate?.enrolled&&!gate.canStartIsolatedPilot);
}
const SAFETY_CODES={
  source_integrity:'Недостоверность источника',
  consent_review:'Проверка согласий',
  data_quality:'Качество данных',
  operational_incident:'Операционный инцидент'
};
async function loadSafety(){
  const pilot=currentPilot();
  const data=await api('/guest/pilots/'+pilot.id+'/safety');
  if(data.schema!=='osmanx.guest.safety.v1'||data.quality?.schema!=='osmanx.guest.quality.v1'||
     !Array.isArray(data.quality.flags))
    throw Error('Неверная версия безопасности R13. Новые записи заблокированы до обновления.');
  model.safety=data;
  const held=data.guestCollectionPaused;
  $('safetyStatus').textContent=held
    ?'СБОР ОСТАНОВЛЕН · причина: '+(SAFETY_CODES[data.hold.reason_code]||data.hold.reason_code)+
      '. Новые наблюдения, CSV и отправка результатов заблокированы до независимого решения.'
    :pilot.phase==='running'
      ?'Пилот работает. При угрозе достоверности можно немедленно остановить сбор.'
      :'Пилот не находится в стадии измерения; экстренная остановка недоступна.';
  $('safetyQualitySummary').textContent='Агрегированных периодов: '+data.quality.periods+
    ' · контроль: '+data.quality.totals.control+
    ' · предложение: '+data.quality.totals.offer+
    ' · предупреждений: '+data.quality.flags.length+'. '+data.quality.disclaimer;
  const list=$('safetyQualityList');list.replaceChildren();
  if(!data.quality.flags.length)
    appendText(list,'li','Объективные правила не обнаружили предупреждений. Это не гарантирует правильность данных.','small');
  for(const signal of data.quality.flags){
    const li=document.createElement('li');
    appendText(li,'strong',signal.title+' · '+signal.severity);
    appendText(li,'p',signal.detail+' '+signal.nextStep,'small');
    list.append(li);
  }
  const running=pilot.phase==='running';
  $('safetyHold').hidden=!running||!write()||held;
  $('safetyHold').disabled=!running||!write()||held;
  const canResume=running&&held&&manage()&&data.hold.held_by!==model.me?.account?.id;
  $('safetyResume').hidden=!canResume;
  $('safetyResume').disabled=!canResume;
  $('safetyExport').hidden=!manage();
  $('safetyExport').disabled=!manage();
  // These are UX hints. Every write is independently guarded in the API.
  for(const input of $('observationForm').querySelectorAll('button,input,select,textarea'))
    input.disabled=held||!write()||!running;
  $('bulkPreview').disabled=held||!write()||!running;
  $('bulkCommit').disabled=held||!model.bulkPreview||!running;
  $('submitReview').disabled=held||!manage()||!running;
  if(held){
    model.bulkPreview=null;
    $('bulkCommit').disabled=true;
    $('bulkResult').textContent='Сбор приостановлен. Ранее проверенный CSV недействителен.';
    for(const button of $('observationList').querySelectorAll('button'))
      button.disabled=true;
  }
}
async function downloadSafetyProof(){
  if(!manage())throw Error('Журнал безопасности доступен только владельцу и управляющему.');
  const pilot=currentPilot(),response=await fetch(
    API+'/guest/pilots/'+pilot.id+'/safety/export.json',{
      method:'GET',credentials:'same-origin',cache:'no-store',
      headers:{Accept:'application/json'}
    });
  if(!(response.headers.get('content-type')||'').includes('application/json'))
    throw Error('Сервер не вернул ожидаемый JSON журнала безопасности.');
  if(!response.ok){
    const error=await response.json();throw Error(error?.error||'Сбой выгрузки '+response.status);
  }
  if(Number(response.headers.get('content-length')||0)>2000000)
    throw Error('Слишком большой отчёт безопасности.');
  const packet=await response.json();
  if(packet.format!=='osmanx.guest.safety.export.v1'||!packet.snapshot||
     !/^[a-f0-9]{64}$/.test(packet.sha256)||
     !/^[a-f0-9]{64}$/.test(packet.snapshot.originalEvidenceSha256))
    throw Error('Неподтверждённый формат журнала R13.');
  const bytes=new TextEncoder().encode(JSON.stringify(packet.snapshot));
  if(bytes.byteLength>2000000)throw Error('Отчёт превышает допустимый размер.');
  const digest=[...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))]
    .map(n=>n.toString(16).padStart(2,'0')).join('');
  if(digest!==packet.sha256)throw Error('SHA-256 журнала неверна; скачивание отменено.');
  const url=URL.createObjectURL(new Blob([JSON.stringify(packet,null,2)],{
    type:'application/json'
  }));
  try{
    const a=document.createElement('a');a.href=url;
    a.download='osmanx-guest-r13-safety.json';
    document.body.append(a);a.click();a.remove();
  }finally{setTimeout(()=>URL.revokeObjectURL(url),1000);}
  setStatus('Сохранён журнал R13 с проверенным SHA-256. Это не цифровая подпись.');
}
async function loadLaunchGate(){
  const pilot=currentPilot();
  const gate=await api('/guest/pilots/'+pilot.id+'/launch/gate');
  if(gate.schema!=='osmanx.guest.launch.gate.v1'||!Array.isArray(gate.blockers))
    throw Error('Неверная версия допуска R12. Не запускайте пилот.');
  model.launchGate=gate;
  $('launchGateState').textContent=gate.canStartIsolatedPilot
    ?'Оба сотрудника подтвердили текущий протокол и готовность. Можно начать только изолированный пилот; production отдельно не разрешён.'
    :gate.enrolled
      ?'Запуск с контролем R12 заблокирован. Устраните '+gate.blockers.length+
        ' препятствий и получите подтверждения двух сотрудников.'
      :'Контроль R12 ещё не включён. Владелец может активировать необратимый двухсотрудниковый допуск.';
  const items=$('launchGateChecklist');items.replaceChildren();
  for(const [key,value] of Object.entries(gate.checks)){
    const row=document.createElement('li'),reason=gate.blockers.find(b=>b.code===key);
    appendText(row,'span',(value?'Пройдено: ':'Требуется: ')+
      (LAUNCH_LABELS[key]||key)+(reason?' — '+reason.reason:''),'small');
    items.append(row);
  }
  const approvals=['owner','manager'].map(role=>{
    const current=gate.attestations?.[role];
    return (role==='owner'?'Владелец':'Управляющий')+': '+
      (current?.current?'подтверждено до '+new Date(current.expiresAt).toLocaleDateString('ru-RU'):
        'нужно актуальное подтверждение');
  });
  $('launchGateApprovals').textContent=approvals.join(' · ')+
    ' · SHA-256 условий: '+gate.snapshotDigest;
  updateLaunchButtons();
}
async function downloadLaunchGateProof(){
  if(!manage())throw Error('Журнал запуска доступен только руководителю.');
  const pilot=currentPilot();
  const response=await fetch(API+'/guest/pilots/'+pilot.id+'/launch/evidence.json',{
    method:'GET',credentials:'same-origin',cache:'no-store',
    headers:{Accept:'application/json'}
  });
  if(!(response.headers.get('content-type')||'').includes('application/json'))
    throw Error('Сервер не вернул JSON журнала допуска.');
  if(!response.ok){
    const error=await response.json();
    throw Error(error?.error||'Ошибка выгрузки '+response.status);
  }
  if(Number(response.headers.get('content-length')||0)>2000000)
    throw Error('Превышен размер пакета.');
  const packet=await response.json();
  if(packet.format!=='osmanx.guest.launch.export.v1'||!packet.snapshot||
    !/^[a-f0-9]{64}$/.test(packet.sha256)||
    !/^[a-f0-9]{64}$/.test(packet.snapshot.originalEvidenceSha256))
    throw Error('Неверный формат проверяемого пакета.');
  const bytes=new TextEncoder().encode(JSON.stringify(packet.snapshot));
  if(bytes.byteLength>2000000)throw Error('Пакет слишком большой.');
  const value=await crypto.subtle.digest('SHA-256',bytes);
  const digest=[...new Uint8Array(value)].map(x=>x.toString(16).padStart(2,'0')).join('');
  if(digest!==packet.sha256)throw Error('SHA-256 пакета не совпадает. Файл не сохранён.');
  const objectUrl=URL.createObjectURL(new Blob([JSON.stringify(packet,null,2)],{
    type:'application/json'
  }));
  try{
    const a=document.createElement('a');a.href=objectUrl;
    a.download='osmanx-guest-r12-launch-proof.json';
    document.body.append(a);a.click();a.remove();
  }finally{setTimeout(()=>URL.revokeObjectURL(objectUrl),1000);}
  setStatus('Журнал допуска выгружен. SHA-256 проверен в браузере. Это не цифровая подпись.');
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
$('safetyRefresh').addEventListener('click',()=>safely(async()=>{
  await loadSafety();setStatus('Контроль качества и остановки пересчитан по серверным данным.');
}));
$('safetyHold').addEventListener('click',()=>safely(async()=>{
  const pilot=currentPilot();
  if(!write()||pilot.phase!=='running')throw Error('Нельзя остановить пилот в этом состоянии.');
  if(!window.confirm('Экстренно остановить все новые агрегированные записи и отправку результатов по этому пилоту?'))return;
  await api('/guest/pilots/'+pilot.id+'/safety/hold',{
    method:'POST',body:{expectedVersion:pilot.version,reasonCode:$('safetyReason').value}
  });
  await refreshCurrent();
  setStatus('Сбор остановлен. Для возобновления требуется ДРУГОЙ действующий руководитель.');
}));
$('safetyResume').addEventListener('click',()=>safely(async()=>{
  const pilot=currentPilot();
  if(!manage()||!model.safety?.guestCollectionPaused)
    throw Error('Нет полномочий или активной остановки.');
  if(model.safety.hold?.held_by===model.me?.account?.id)
    throw Error('Независимую проверку должен провести другой сотрудник.');
  if(!window.confirm('Подтверждаете независимую проверку причины остановки и разрешаете возобновление сбора?'))return;
  await api('/guest/pilots/'+pilot.id+'/safety/resume',{
    method:'POST',body:{expectedVersion:pilot.version,acknowledge:true}
  });
  await refreshCurrent();
  setStatus('Сбор возобновлён другим руководителем, решение сохранено в неизменяемом журнале.');
}));
$('safetyExport').addEventListener('click',()=>safely(()=>downloadSafetyProof()));
$('launchGateRefresh').addEventListener('click',()=>safely(async()=>{
  await loadLaunchGate();setStatus('Условия запуска пересчитаны на сервере.');
}));
$('launchGateEnroll').addEventListener('click',()=>safely(async()=>{
  const pilot=currentPilot();
  if(model.me?.role!=='owner'||pilot.phase!=='draft')
    throw Error('Только владелец может включить режим R12 для черновика.');
  if(!window.confirm('Включить необратимый двухсотрудниковый контроль запуска? Отключить его будет нельзя.'))return;
  await api('/guest/pilots/'+pilot.id+'/launch/enroll',{
    method:'POST',body:{expectedVersion:pilot.version,confirm:true}
  });
  await refresh();
  setStatus('R12 включён. Теперь требуются действующие подтверждения владельца и управляющего.');
}));
$('launchGateAttest').addEventListener('click',()=>safely(async()=>{
  const pilot=currentPilot(),gate=model.launchGate;
  if(!manage()||!gate?.enrolled||pilot.phase!=='draft')
    throw Error('Подтверждение в этом состоянии запрещено.');
  if(!window.confirm('Подтвердить текущий протокол, проверку согласий и шесть условий запуска именно вашей учётной записью?'))return;
  await api('/guest/pilots/'+pilot.id+'/launch/attest',{
    method:'POST',headers:{'Idempotency-Key':idempotency()},
    body:{expectedVersion:pilot.version,acknowledge:true}
  });
  await loadLaunchGate();
  setStatus('Ваше подтверждение сохранено в неизменяемом журнале на 14 дней.');
}));
$('launchGateExport').addEventListener('click',()=>safely(()=>downloadLaunchGateProof()));
$('r19Refresh').addEventListener('click',()=>safely(()=>loadR19Preflight()));
$('r20Refresh').addEventListener('click',()=>safely(()=>loadR20Inspection()));
$('r21Refresh').addEventListener('click',()=>safely(()=>loadR21Posture()));
$('r22Refresh').addEventListener('click',()=>safely(()=>loadR22LaunchReview()));
$('r23Refresh').addEventListener('click',()=>safely(()=>loadR23Handoff()));
$('r24Refresh').addEventListener('click',()=>safely(()=>loadR24Intelligence()));
$('r33Refresh').addEventListener('click',()=>safely(()=>loadR33Acceptance()));
$('r33Download').addEventListener('click',()=>safely(async()=>{
  if(!manage()||!model.selected?.item)throw Error('Выберите пилот.');
  await downloadCsv('/guest/pilots/'+model.selected.item.id+'/r33/report.csv',
    'osmanx-guest-r33-independent-review.csv');
  setStatus('R33: экспорт NO-GO завершён. Коммерческий запуск запрещён.');
}));
$('r32Refresh').addEventListener('click',()=>safely(()=>loadR32Acceptance()));
$('r32Download').addEventListener('click',()=>safely(async()=>{
  if(!manage()||!model.selected?.item)throw Error('Выберите пилот');
  await downloadCsv('/guest/pilots/'+model.selected.item.id+'/r32/report.csv',
    'osmanx-guest-r32-review.csv');
  setStatus('Отчёт R32 сохранён. Запуск запрещён до ручной приёмки.');
}));
$('r31Refresh').addEventListener('click',()=>safely(()=>loadR31Acceptance()));
$('r31Download').addEventListener('click',()=>safely(async()=>{
  if(!manage()||!model.selected?.item)throw Error('Выберите пилот.');
  await downloadCsv('/guest/pilots/'+model.selected.item.id+'/r31/report.csv',
    'osmanx-guest-r31-manual-handoff.csv');
  setStatus('Экспорт R31: NO-GO. Независимая приёмка обязательна.');
}));
$('r30Refresh').addEventListener('click',()=>safely(()=>loadR30Acceptance()));
$('r30Download').addEventListener('click',()=>safely(async()=>{
  if(!manage()||!model.selected?.item)throw Error('Выберите пилот');
  await downloadCsv('/guest/pilots/'+model.selected.item.id+'/r30/report.csv',
    'osmanx-guest-r30-independent-review.csv');
  setStatus('R30: отчёт NO-GO экспортирован; публикация не разрешена.');
}));
$('r29Refresh').addEventListener('click',()=>safely(()=>loadR29Acceptance()));
$('r29Download').addEventListener('click',()=>safely(async()=>{
  if(!manage()||!model.selected?.item)throw Error('Выберите пилот');
  await downloadCsv('/guest/pilots/'+model.selected.item.id+'/r29/report.csv',
    'osmanx-guest-r29-staging-review.csv');
  setStatus('R29 CSV сохранён. Автоматическая публикация запрещена.');
}));
$('r28Refresh').addEventListener('click',()=>safely(()=>loadR28OperatorStatus()));
$('r28Download').addEventListener('click',()=>safely(async()=>{
  if(!manage()||!model.selected?.item)throw Error('Выберите пилот.');
  await downloadCsv('/guest/pilots/'+model.selected.item.id+'/r28/handoff.csv',
    'osmanx-guest-r28-manual-review.csv');
  setStatus('Экспортирован R28 CSV для ручной проверки. Разрешение на запуск не выдавалось.');
}));
$('r27Refresh').addEventListener('click',()=>safely(()=>loadR27Readiness()));
$('r27Download').addEventListener('click',()=>safely(async()=>{
  if(!manage()||!model.selected?.item)throw Error('Выберите пилот руководителя.');
  await downloadCsv('/guest/pilots/'+model.selected.item.id+'/r27/handoff.csv',
    'osmanx-guest-r27-operator-handoff.csv');
  setStatus('Сохранён ограниченный по сроку R27 CSV. Реальный запуск не разрешён.');
}));
$('r26Refresh').addEventListener('click',()=>safely(()=>loadR26Reliability()));
$('r26Download').addEventListener('click',()=>safely(async()=>{
  if(!manage()||!model.selected?.item)throw Error('Выберите пилот.');
  await downloadCsv('/guest/pilots/'+model.selected.item.id+'/r26/report.csv',
    'osmanx-guest-r26-reliability.csv');
  setStatus('Отчёт R26 без персональных данных сохранён.');
}));
$('r26ReviewForm').addEventListener('submit',event=>{
  event.preventDefault();safely(async()=>{
    if(!manage()||$('r26ReviewFieldset').disabled||!currentR26)
      throw Error('Подтверждение запрещено без действующей версии и разрешения.');
    const sha=$('r26EvidenceSha').value.trim();
    if(!/^[a-f0-9]{64}$/.test(sha)||
       sha===currentR26.r25SourceSha||sha===currentR26.r24EvidenceSha)
      throw Error('Укажите SHA-256 отдельного проверочного документа.');
    const item=currentPilot();
    if(item.version!==currentR26.version)
      throw Error('Версия пилота изменилась. Обновите данные.');
    const saved=await api('/guest/pilots/'+item.id+'/r26/source-review',{
      method:'POST',headers:{'Idempotency-Key':idempotency()},
      body:{expectedVersion:currentR26.version,
        sourceSha:currentR26.r25SourceSha,
        r24EvidenceSha:currentR26.r24EvidenceSha,
        evidenceSha:sha,method:$('r26Method').value,
        verdict:$('r26Verdict').value}
    });
    if(!saved.reviewId)throw Error('API не подтвердил запись сверки.');
    $('r26EvidenceSha').value='';
    await loadR26Reliability();
    setStatus('Ваша внутренняя сверка зафиксирована неизменяемо. Это не внешний аудит.');
  });
});
$('r25Refresh').addEventListener('click',()=>safely(()=>loadR25Insights()));
$('r25Download').addEventListener('click',()=>safely(async()=>{
  if(!manage()||!model.selected?.item)throw Error('Выберите пилот.');
  await downloadCsv('/guest/pilots/'+model.selected.item.id+'/r25/report.csv',
    'osmanx-guest-r25-barriers.csv');
  setStatus('Экспортирован анонимный отчёт R25 без персональных данных.');
}));
$('r25EntryForm').addEventListener('submit',event=>{
  event.preventDefault();safely(async()=>{
    if(!manage()||$('r25EntryFieldset').disabled)
      throw Error('Ввод R25 разрешается только после отдельного допуска.');
    const integer=id=>{
      const raw=$(id).value;
      if(!/^(0|[1-9][0-9]*)$/.test(raw))throw Error('Только целые неотрицательные числа.');
      return Number(raw);
    };
    const sampled=integer('r25Sample');
    const counts={
      wait:integer('r25Wait'),stockout:integer('r25Stockout'),
      ordering:integer('r25Ordering'),price:integer('r25Price'),
      service:integer('r25Service'),unknown:integer('r25Unknown')
    };
    if(Object.values(counts).reduce((a,b)=>a+b,0)!==sampled)
      throw Error('Сумма шести категорий должна равняться числу наблюдений.');
    const pilot=currentPilot();
    const saved=await api('/guest/pilots/'+pilot.id+'/operational-signals',{
      method:'POST',headers:{'Idempotency-Key':idempotency()},
      body:{expectedVersion:pilot.version,tally:{
        date:$('r25Date').value,shift:$('r25Shift').value,
        source:$('r25Source').value,sampled,counts
      }}
    });
    if(!saved.signalId&&!saved.duplicate)throw Error('Сводка не подтверждена сервером.');
    await refreshCurrent();
    setStatus(saved.duplicate?'Анонимная сводка уже была сохранена.':
      'Новая анонимная сводка сохранена. Обновлена аналитика R25.');
  });
});
$('r24Download').addEventListener('click',()=>safely(async()=>{
  if(!manage()||!model.selected?.item)throw Error('Выберите пилот руководителя.');
  await downloadCsv('/guest/pilots/'+model.selected.item.id+'/r24/brief.csv',
    'osmanx-guest-r24-aggregate-brief.csv');
  setStatus('Проверяемый R24 CSV сохранён без персональных данных.');
}));
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
