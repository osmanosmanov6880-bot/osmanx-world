// OSMANX Guest Intelligence R4 — authenticated SAME-ORIGIN UI.
// No tokens, passwords, customer records, or personal data in local/session storage.
// No demo success states: all workspace data comes from authenticated PostgreSQL API.
const API='/api/industry/v1';
const $=id=>document.getElementById(id);
const flags=['repeatDefinition','sameWindow','independentGroups','marginVerified','contactConsent','ownerAgreed'];
const currencies=new Intl.NumberFormat('ru-RU',{style:'currency',currency:'RUB',maximumFractionDigits:2});
const model={me:null,requests:[],pilots:[],selected:null,report:null};
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
}
function showWorkspace(){
  $('loginPanel').hidden=true;$('workPanel').hidden=false;
  $('tenantLabel').textContent=model.me.tenant.name;
  $('accountLabel').textContent=model.me.account.email+' · роль: '+model.me.role;
  $('requestForm').querySelector('button[type=submit]').disabled=!write();
  $('pilotForm').querySelector('button[type=submit]').disabled=!manage();
  $('staffPanel').hidden=!manage();
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
  if(manage())await loadStaff();
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
async function loadStaff(){
  const data=await api('/staff');
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
  for(const checkbox of document.querySelectorAll('[data-ready]'))checkbox.disabled=!isManage||phase!=='draft';
}
async function openPilot(id){
  const data=await api('/guest/pilots/'+id);
  model.selected=data;
  $('detailPanel').hidden=false;
  const item=data.item;
  $('pilotHeading').textContent=item.title;
  $('phase').textContent=item.phase;
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
}
async function loadReport(){
  if(!model.selected)return;
  model.report=await api('/guest/pilots/'+model.selected.item.id+'/report');
  $('reportBox').textContent=model.report.report ||
    'Нет наблюдений. Загрузите обезличенные показатели после запуска пилота.';
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
    const output=await api('/guest/pilots',{method:'POST',body:{title:$('pilotTitle').value.trim(),plan,requestId}});
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
