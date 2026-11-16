/* osmanx-industry-console-r3: real API only, never falls back to simulated business data */
(()=>{'use strict';
const ROOT='/api/industry/v1';
const root=document.getElementById('console-app');
const state={auth:null,tab:'overview',stats:{},items:{customers:[],services:[],resources:[],appointments:[],audit:[]},notice:'',loading:true,offline:false};
const e=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const rub=v=>new Intl.NumberFormat('ru-RU',{style:'currency',currency:'RUB',maximumFractionDigits:0}).format(Number(v||0)/100);
const date=v=>v?new Date(v).toLocaleString('ru-RU',{dateStyle:'short',timeStyle:'short'}):'—';
const canWrite=()=>['owner','manager','operator'].includes(state.auth?.role);
const canManage=()=>['owner','manager'].includes(state.auth?.role);
const allowedStatus={new:['confirmed','cancelled'],confirmed:['done','cancelled'],done:[],cancelled:[]};
const labels={new:'Новая',confirmed:'Подтверждена',done:'Выполнена',cancelled:'Отменена'};
const sections={overview:'Обзор',appointments:'Записи',customers:'Клиенты',services:'Услуги',resources:'Календари',audit:'Журнал'};
function csrf(){
  const value=document.cookie.split('; ').find(x=>x.startsWith('__Host-osmanx_industry_csrf=')||x.startsWith('osmanx_industry_csrf='));
  return value?decodeURIComponent(value.slice(value.indexOf('=')+1)):'';
}
async function api(path,method='GET',body,extra={}){
  let response;
  try{
    response=await fetch(ROOT+path,{method,credentials:'same-origin',cache:'no-store',
      headers:{'Accept':'application/json',...(body?{'Content-Type':'application/json'}:{}),...(['POST','PATCH','PUT','DELETE'].includes(method)?{'X-CSRF-Token':csrf()}:{}),...extra},
      ...(body?{body:JSON.stringify(body)}:{})});
  }catch{throw new Error('Нет соединения с сервером OSMANX Industry API');}
  const contentType=response.headers.get('content-type')||'';
  if(!contentType.includes('application/json'))throw new Error('Сервер API не развёрнут на этом домене');
  const data=await response.json();
  if(!response.ok){const err=new Error(data.error||'Ошибка '+response.status);err.status=response.status;throw err;}
  return data;
}
function shell(content){root.innerHTML='<div class="console-shell"><header class="console-head"><div class="console-brand">OSMAN<em>X</em><small>INDUSTRY OS · SECURE CONSOLE</small></div><div class="console-inline"><span class="micro-pill">Серверные данные · без демо-подмены</span><a class="btn secondary" href="./">Открыть демо ↗</a></div></header>'+content+'<footer class="console-footer">OSMANX INDUSTRY OS R3 · Для реальных организаций требуются настроенные API, TLS, аудит, правовые основания обработки и проверка интеграций.</footer></div>'}
function alert(){return state.notice?'<div class="console-alert" role="alert">'+e(state.notice)+'</div>':''}
function formLabel(name,type='text',key='',placeholder='',value='',other=''){return '<label>'+e(name)+'<input type="'+type+'" name="'+key+'" placeholder="'+e(placeholder)+'" value="'+e(value)+'" '+other+' required></label>'}
function login(){
  shell('<div class="login-layout"><div><span class="eyebrow">ENTERPRISE OPERATIONS</span><h1>Управление сервисом.<br><span style="color:#8856df">На ваших данных.</span></h1><p class="muted">Защищённый кабинет для компаний: клиенты, услуги, рабочие календари, записи и контроль действий. Доступ работает только после подключения серверной инфраструктуры.</p><div class="console-warning">На этой странице нет тестового аккаунта или общего пароля. Учётные записи создаются администратором на сервере.</div><a class="btn secondary" href="./">← Публичная демонстрация</a></div><div class="login-card"><span class="eyebrow">Вход сотрудника</span><h2 style="margin:10px 0 19px">Войти в организацию</h2>'+alert()+'<form id="login-form" class="console-form">'+formLabel('Код компании','text','tenantSlug','Например, dental-center','','minlength="2" maxlength="64"')+formLabel('Рабочая почта','email','email','director@company.ru','','autocomplete="username" maxlength="254"')+formLabel('Пароль','password','password','Не менее 12 символов','','autocomplete="current-password"')+'<button class="btn primary" type="submit">Войти безопасно →</button></form><p class="console-muted" style="margin-top:17px">Сессия — HttpOnly cookie, действия защищены CSRF-токеном. Пароль не сохраняется в браузере.</p></div></div>');
}
function offline(){
  shell('<div class="api-offline"><span class="chip orange">Серверная часть не подключена</span><h1 style="margin:17px 0 10px">Кабинет ожидает API</h1><p class="muted">Публичный сайт работает как демонстрация. Сервер OSMANX Industry API пока не подключён к этому домену, поэтому реальные данные, записи и вход не доступны — никаких поддельных подключений.</p>'+alert()+'<div class="cta-row"><button class="btn primary" data-action="retry">Проверить соединение</button><a class="btn secondary" href="./">Перейти к демо</a></div><p class="console-muted" style="margin-top:17px">Требуется reverse proxy для /api/industry/v1, PostgreSQL и отдельная защищённая инфраструктура.</p></div>');
}
function display(){
  if(state.loading){shell('<div class="console-spinner" role="status">Проверка защищённого сервера…</div>');return;}
  if(state.offline){offline();return;}
  if(!state.auth){login();return;}
  const tenant=state.auth.tenant;
  const nav='<aside class="console-nav" aria-label="Разделы">'+Object.entries(sections).map(([key,label])=>'<button type="button" data-tab="'+key+'" class="'+(state.tab===key?'selected':'')+'">'+e(label)+'</button>').join('')+'<button type="button" data-action="logout">Выйти ↗</button></aside>';
  const content='<div class="console-layout">'+nav+'<main class="console-main"><div class="row between"><div><span class="eyebrow">'+e(tenant.name)+' · '+e(tenant.vertical)+'</span><h1 style="margin:6px 0 10px">'+e(sections[state.tab])+'</h1></div><span class="chip green">'+e(state.auth.role)+' · '+e(state.auth.account.email)+'</span></div>'+alert()+view()+'</main></div>';
  shell(content);
}
function table(headers,rows){return '<div class="console-table"><table class="data-table"><thead><tr>'+headers.map(h=>'<th>'+e(h)+'</th>').join('')+'</tr></thead><tbody>'+rows.join('')+'</tbody></table></div>'}
function overview(){
  const k=state.stats;
  return '<div class="console-stats">'+[['Клиенты',k.customers],['Услуги',k.services],['Активные записи',k.active_appointments],['Завершённые',k.completed_appointments]].map(([label,value])=>'<div class="kpi"><small>'+e(label)+'</small><strong>'+Number(value||0)+'</strong><p>Из базы этой компании</p></div>').join('')+'</div><div class="console-box" style="margin-top:16px"><h3>Измеряемые процессы</h3><p>Все показатели загружаются с PostgreSQL через авторизованный API и принадлежат только выбранной организации.</p><div class="feature-list"><div class="feature"><span class="feature-icon">01</span><div><b>Новые заявки и статусы</b><small>Начальная запись → подтверждение → выполнение / отмена</small></div></div><div class="feature"><span class="feature-icon">02</span><div><b>Контроль рабочего календаря</b><small>Двойное бронирование ресурса блокируется PostgreSQL</small></div></div><div class="feature"><span class="feature-icon">03</span><div><b>Аудит и интеграции</b><small>События сохраняются и передаются только через настроенную очередь</small></div></div></div></div>';
}
function customerRows(){return state.items.customers.map(c=>'<tr><td class="strong">'+e(c.display_name)+'</td><td>'+e(c.phone||'—')+'</td><td>'+e(c.email||'—')+'</td><td>'+date(c.created_at)+'</td></tr>')}
function customers(){
  return '<div class="console-two"><div class="console-box"><div class="row between"><h3>Клиентская база</h3><button class="btn ghost" data-action="csv-customers">CSV ↓</button></div>'+table(['Клиент','Телефон','Email','Создан'],customerRows())+'</div><div class="console-box"><h3>Добавить клиента</h3>'+(!canWrite()?'<p class="console-muted">У вас только право просмотра.</p>':'<form id="customer-form" class="console-form">'+formLabel('Имя','text','displayName','Клиент','','minlength="2" maxlength="120"')+'<label>Телефон (необязательно)<input name="phone" type="tel" maxlength="32"></label><label>Email (необязательно)<input name="email" type="email" maxlength="254"></label><button type="submit" class="btn primary">Сохранить</button></form>')+'<p class="console-muted">Добавляйте персональные сведения только при наличии законного основания и настроенного безопасного хранения.</p></div></div>';
}
function services(){
  const rows=state.items.services.map(v=>'<tr><td class="strong">'+e(v.name)+'</td><td>'+v.duration_minutes+' мин</td><td>'+rub(v.price_minor)+'</td><td>'+(v.active?'Активна':'Выключена')+'</td></tr>');
  return '<div class="console-two"><div class="console-box"><div class="row between"><h3>Услуги компании</h3><button class="btn ghost" data-action="csv-services">CSV ↓</button></div>'+table(['Услуга','Время','Цена','Статус'],rows)+'</div><div class="console-box"><h3>Создать услугу</h3>'+(!canManage()?'<p class="console-muted">Требуется роль управляющего.</p>':'<form id="service-form" class="console-form">'+formLabel('Название','text','name','Название услуги','','minlength="2" maxlength="120"')+formLabel('Длительность, минуты','number','durationMinutes','60','60','min="5" max="480"')+formLabel('Цена, ₽','number','priceRub','2500','2500','min="0" step="0.01"')+'<button type="submit" class="btn primary">Сохранить услугу</button></form>')+'</div></div>';
}
function resources(){
  const rows=state.items.resources.map(v=>'<tr><td class="strong">'+e(v.name)+'</td><td>'+(v.active?'Активен':'Неактивен')+'</td></tr>');
  return '<div class="console-two"><div class="console-box"><h3>Специалисты / рабочие календари</h3>'+table(['Ресурс','Статус'],rows)+'</div><div class="console-box"><h3>Добавить календарь</h3>'+(!canManage()?'<p class="console-muted">Требуется роль управляющего.</p>':'<form id="resource-form" class="console-form">'+formLabel('Название','text','name','Кабинет 1 / Пост 2','','minlength="2" maxlength="100"')+'<button type="submit" class="btn primary">Создать ресурс</button></form>')+'</div></div>';
}
function select(name,list,label){return '<select name="'+name+'" required>'+list.map(item=>'<option value="'+e(item.id)+'">'+e(item[label])+'</option>').join('')+'</select>'}
function appointments(){
  const a=state.items.appointments;
  const rows=a.map(v=>{
    const steps=allowedStatus[v.status]||[];
    const actions=canWrite()&&steps.length?'<select data-status-id="'+e(v.id)+'" aria-label="Изменение статуса"><option value="">Выберите</option>'+steps.map(x=>'<option value="'+x+'">'+labels[x]+'</option>').join('')+'</select>':'—';
    return '<tr><td class="strong">'+e(v.customer_name)+'</td><td>'+e(v.service_name)+'</td><td>'+e(v.resource_name)+'</td><td>'+date(v.starts_at)+'</td><td><span class="status '+e(v.status)+'">'+labels[v.status]+'</span></td><td>'+actions+'</td></tr>';
  });
  const canCreate=state.items.customers.length&&state.items.services.length&&state.items.resources.length;
  return '<div class="console-two"><div class="console-box"><div class="row between"><h3>Записи</h3><button class="btn ghost" data-action="csv-appointments">CSV ↓</button></div>'+table(['Клиент','Услуга','Календарь','Дата','Статус','Действие'],rows)+'</div><div class="console-box"><h3>Новая запись</h3>'+(!canWrite()?'<p class="console-muted">У вас только просмотр.</p>':!canCreate?'<p class="console-muted">Сначала добавьте клиента, услугу и календарь.</p>':'<form class="console-form" id="booking-form"><label>Клиент'+select('customerId',state.items.customers,'display_name')+'</label><label>Услуга'+select('serviceId',state.items.services.filter(x=>x.active),'name')+'</label><label>Календарь'+select('resourceId',state.items.resources.filter(x=>x.active),'name')+'</label><label>Дата и время<input type="datetime-local" name="startsAt" required></label><button type="submit" class="btn primary">Создать запись</button></form>')+'<p class="console-muted">Конфликт по времени одного ресурса сервер отклонит с кодом 409. Отменённые и завершённые записи не занимают слот.</p></div></div>';
}
function audit(){
  if(!canManage())return '<div class="console-alert">Для просмотра журнала нужна роль управляющего.</div>';
  const rows=state.items.audit.map(v=>'<tr><td>'+e(v.action)+'</td><td>'+e(v.target_id||'—')+'</td><td>'+date(v.occurred_at)+'</td></tr>');
  return '<div class="console-box"><h3>Журнал операций (последние 100)</h3>'+table(['Событие','Объект','Дата'],rows)+'</div>';
}
function view(){return ({overview,appointments,customers,services,resources,audit}[state.tab]||overview)()}
async function refresh(){
  state.loading=true;display();
  try{
    state.auth=await api('/auth/me');state.offline=false;
    const [dashboard,customers,services,resources,appointments]=await Promise.all([
      api('/dashboard'),api('/customers'),api('/services'),api('/resources'),api('/appointments')]);
    state.stats=dashboard.stats;
    state.items={...state.items,customers:customers.items,services:services.items,resources:resources.items,appointments:appointments.items};
    state.items.audit=canManage()?(await api('/audit')).items:[];
    state.notice='';
  }catch(error){
    if(error.status===401){state.auth=null;state.stats={};state.items={customers:[],services:[],resources:[],appointments:[],audit:[]};state.offline=false;state.notice='';}
    else if(!state.auth)state.offline=!(error.message.includes('Сессия')||error.message.includes('Требуется вход'));
    if(state.offline)state.notice=error.message;
    else if(state.auth)state.notice=error.message;
  }finally{state.loading=false;display();}
}
function setBusy(value){state.loading=value;display()}
async function createFromForm(form){
  const f=new FormData(form),type=form.id;
  if(type==='login-form'){
    state.notice='';state.loading=true;display();
    try{await api('/auth/login','POST',{tenantSlug:String(f.get('tenantSlug')||'').trim(),email:String(f.get('email')||'').trim(),password:String(f.get('password')||'')});await refresh()}
    catch(error){state.loading=false;state.notice=error.message;login()}
    return;
  }
  let path='',body={};
  if(type==='customer-form'){path='/customers';body={displayName:String(f.get('displayName')||'').trim(),phone:String(f.get('phone')||'').trim()||undefined,email:String(f.get('email')||'').trim()||undefined};}
  if(type==='service-form'){path='/services';body={name:String(f.get('name')||'').trim(),durationMinutes:Number(f.get('durationMinutes')),priceMinor:Math.round(Number(f.get('priceRub'))*100)};}
  if(type==='resource-form'){path='/resources';body={name:String(f.get('name')||'').trim()};}
  if(type==='booking-form'){
    path='/appointments';
    const raw=String(f.get('startsAt')||'');
    const time=new Date(raw);
    if(!Number.isFinite(time.getTime()))throw new Error('Неверная дата');
    body={customerId:String(f.get('customerId')),serviceId:String(f.get('serviceId')),resourceId:String(f.get('resourceId')),startsAt:time.toISOString()};
  }
  if(!path)return;
  await api(path,'POST',body,type==='booking-form'?{'Idempotency-Key':(crypto.randomUUID?crypto.randomUUID():'booking-'+Date.now())}:{});
  await refresh();
}
function csv(table){
  let rows=[];
  if(table==='customers')rows=state.items.customers.map(x=>[x.display_name,x.phone,x.email,x.created_at]);
  if(table==='services')rows=state.items.services.map(x=>[x.name,x.duration_minutes,x.price_minor,x.active]);
  if(table==='appointments')rows=state.items.appointments.map(x=>[x.customer_name,x.service_name,x.resource_name,x.starts_at,x.status]);
  const data='\ufeff'+rows.map(row=>row.map(v=>'"'+String(v??'').replace(/"/g,'""')+'"').join(';')).join('\r\n');
  const url=URL.createObjectURL(new Blob([data],{type:'text/csv;charset=utf-8'}));
  const a=document.createElement('a');a.href=url;a.download='osmanx-industry-'+table+'.csv';document.body.append(a);a.click();a.remove();
  setTimeout(()=>URL.revokeObjectURL(url),1000);
}
root.addEventListener('click',async ev=>{
  const tab=ev.target.closest('[data-tab]');if(tab){state.tab=tab.dataset.tab;state.notice='';display();return;}
  const action=ev.target.closest('[data-action]');if(!action)return;
  if(action.dataset.action==='retry')return refresh();
  if(action.dataset.action.startsWith('csv-')){csv(action.dataset.action.slice(4));return;}
  if(action.dataset.action==='logout'){
    try{await api('/auth/logout','POST')}catch{}
    state.auth=null;state.stats={};state.items={customers:[],services:[],resources:[],appointments:[],audit:[]};state.notice='';state.tab='overview';login();
  }
});
root.addEventListener('submit',async ev=>{
  const form=ev.target;if(!form.id.endsWith('-form'))return;
  ev.preventDefault();
  try{await createFromForm(form)}catch(error){state.loading=false;state.notice=error.message;display();}
});
root.addEventListener('change',async ev=>{
  const select=ev.target.closest('[data-status-id]');if(!select||!select.value)return;
  try{await api('/appointments/'+encodeURIComponent(select.dataset.statusId)+'/status','PATCH',{status:select.value});await refresh()}
  catch(error){state.notice=error.message;display();}
});
refresh();
})();