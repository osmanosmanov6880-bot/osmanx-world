/* osmanx-industry-console-r3: real API only, never falls back to simulated business data */
(()=>{'use strict';
const ROOT='/api/industry/v1';
const root=document.getElementById('console-app');
const state={auth:null,tab:'overview',stats:{},items:{customers:[],services:[],resources:[],appointments:[],audit:[]},staff:null,integration:null,eventItems:[],calendarResourceId:null,calendarHours:null,availableSlots:[],inviteToken:'',acceptInvite:false,rescheduleId:null,schedule:{resourceId:null,serviceId:null,customerId:null,date:'',slots:[],hours:null,timezone:'UTC',slotIntervalMinutes:30,bufferMinutes:0,closedDates:[]},notice:'',loading:true,offline:false};
const e=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const rub=v=>new Intl.NumberFormat('ru-RU',{style:'currency',currency:'RUB',maximumFractionDigits:0}).format(Number(v||0)/100);
const date=v=>v?new Date(v).toLocaleString('ru-RU',{dateStyle:'short',timeStyle:'short'}):'—';
const canWrite=()=>['owner','manager','operator'].includes(state.auth?.role);
const canManage=()=>['owner','manager'].includes(state.auth?.role);
const allowedStatus={new:['confirmed','cancelled'],confirmed:['done','cancelled'],done:[],cancelled:[]};
const labels={new:'Новая',confirmed:'Подтверждена',done:'Выполнена',cancelled:'Отменена'};
const sections={overview:'Обзор',appointments:'Записи',schedule:'Расписание',customers:'Клиенты',services:'Услуги',resources:'Календари',staff:'Команда',integrations:'Интеграции',audit:'Журнал'};
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
function shell(content){root.innerHTML='<div class="console-shell"><header class="console-head"><div class="console-brand">OSMAN<em>X</em><small>INDUSTRY OS · SECURE CONSOLE</small></div><div class="console-inline"><span class="micro-pill">Серверные данные · без демо-подмены</span><a class="btn secondary" href="./">Открыть демо ↗</a></div></header>'+content+'<footer class="console-footer">OSMANX INDUSTRY OS R4 · Для реальных организаций требуются настроенные API, TLS, аудит, правовые основания обработки и проверка интеграций.</footer></div>'}
function alert(){return state.notice?'<div class="console-alert" role="alert">'+e(state.notice)+'</div>':''}
function formLabel(name,type='text',key='',placeholder='',value='',other=''){return '<label>'+e(name)+'<input type="'+type+'" name="'+key+'" placeholder="'+e(placeholder)+'" value="'+e(value)+'" '+other+' required></label>'}
function login(){
  const form=state.acceptInvite?
    '<span class="eyebrow">Присоединиться к команде</span><h2 style="margin:10px 0 19px">Принять приглашение</h2>'+alert()+
    '<form id="accept-form" class="console-form">'+formLabel('Одноразовый токен','text','token','64 символа','','minlength="64" maxlength="64"')+
    formLabel('Пароль аккаунта','password','password','12–200 символов','','minlength="12" maxlength="200" autocomplete="new-password"')+
    '<button class="btn primary" type="submit">Принять приглашение</button></form>'+
    '<p class="console-muted">Если рабочая почта уже зарегистрирована, укажите существующий пароль. Токен подтверждает только право вступления в организацию.</p>':
    '<span class="eyebrow">Вход сотрудника</span><h2 style="margin:10px 0 19px">Войти в организацию</h2>'+alert()+
    '<form id="login-form" class="console-form">'+formLabel('Код компании','text','tenantSlug','Например, dental-center','','minlength="2" maxlength="64"')+
    formLabel('Рабочая почта','email','email','director@company.ru','','autocomplete="username" maxlength="254"')+
    formLabel('Пароль','password','password','Не менее 12 символов','','autocomplete="current-password"')+
    '<button class="btn primary" type="submit">Войти безопасно →</button></form>';
  shell('<div class="login-layout"><div><span class="eyebrow">ENTERPRISE OPERATIONS</span><h1>Управление сервисом.<br><span style="color:#8856df">На ваших данных.</span></h1><p class="muted">Кабинет компании: клиенты, команда, календари, записи и интеграции. Доступ работает после подключения серверной инфраструктуры.</p><div class="console-warning">Нет общего демо-пароля и открытой регистрации. Новые аккаунты создаются по приглашению администратора.</div><a class="btn secondary" href="./">← Публичная демонстрация</a></div><div class="login-card">'+form+'<button type="button" class="btn ghost" data-action="toggle-invite" style="margin-top:16px">'+(state.acceptInvite?'← Вернуться к входу':'У меня есть приглашение →')+'</button><p class="console-muted" style="margin-top:17px">Сессия — HttpOnly cookie; операции защищены CSRF-токеном.</p></div></div>');
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
    return '<tr><td class="strong">'+e(v.customer_name)+'</td><td>'+e(v.service_name)+'</td><td>'+e(v.resource_name)+'</td><td>'+date(v.starts_at)+'</td><td><span class="status '+e(v.status)+'">'+labels[v.status]+'</span></td><td>'+actions+(canWrite()&&['new','confirmed'].includes(v.status)?'<button class="action-link" data-reschedule="'+e(v.id)+'">Перенести</button>':'')+'</td></tr>';
  });
  const canCreate=state.items.customers.length&&state.items.services.length&&state.items.resources.length;
  const activeReschedule=state.rescheduleId&&a.find(x=>x.id===state.rescheduleId);
  const moving=activeReschedule?'<div class="console-box" style="margin-top:14px"><h3>Перенести запись: '+e(activeReschedule.customer_name)+'</h3><form id="reschedule-form" class="console-form"><label>Рабочий календарь<select name="resourceId">'+state.items.resources.filter(x=>x.active).map(x=>'<option value="'+e(x.id)+'" '+(x.id===activeReschedule.resource_id?'selected':'')+'>'+e(x.name)+'</option>').join('')+'</select></label><label>Новая дата<input type="datetime-local" name="startsAt" required></label><button class="btn primary" type="submit">Проверить и перенести</button></form></div>':'';

  return '<div class="console-two"><div class="console-box"><div class="row between"><h3>Записи</h3><button class="btn ghost" data-action="csv-appointments">CSV ↓</button></div>'+table(['Клиент','Услуга','Календарь','Дата','Статус','Действие'],rows)+'</div><div class="console-box"><h3>Новая запись</h3>'+(!canWrite()?'<p class="console-muted">У вас только просмотр.</p>':!canCreate?'<p class="console-muted">Сначала добавьте клиента, услугу и календарь.</p>':'<form class="console-form" id="booking-form"><label>Клиент'+select('customerId',state.items.customers,'display_name')+'</label><label>Услуга'+select('serviceId',state.items.services.filter(x=>x.active),'name')+'</label><label>Календарь'+select('resourceId',state.items.resources.filter(x=>x.active),'name')+'</label><label>Дата и время<input type="datetime-local" name="startsAt" required></label><button type="submit" class="btn primary">Создать запись</button></form>')+'<p class="console-muted">Конфликт по времени одного ресурса сервер отклонит с кодом 409. Отменённые и завершённые записи не занимают слот.</p></div></div>'+moving;
}
function audit(){
  if(!canManage())return '<div class="console-alert">Для просмотра журнала нужна роль управляющего.</div>';
  const rows=state.items.audit.map(v=>'<tr><td>'+e(v.action)+'</td><td>'+e(v.target_id||'—')+'</td><td>'+date(v.occurred_at)+'</td></tr>');
  return '<div class="console-box"><h3>Журнал операций (последние 100)</h3>'+table(['Событие','Объект','Дата'],rows)+'</div>';
}

function staff(){
  if(!canManage())return '<div class="console-alert">Раздел доступен управляющим и владельцам.</div>';
  const members=state.staff?.members||[],invites=state.staff?.invitations||[];
  const rows=members.map(m=>{
    const change=m.role==='owner'?'Владелец':(state.auth.role==='manager'&&m.role==='manager'?'Управляющий':
      '<select data-staff-role="'+e(m.account_id)+'">'+['manager','operator','viewer'].filter(x=>state.auth.role==='owner'||x!=='manager').map(x=>'<option value="'+x+'" '+(m.role===x?'selected':'')+'>'+e(x)+'</option>').join('')+'</select>');
    return '<tr><td class="strong">'+e(m.email)+'</td><td>'+change+'</td><td>'+(m.role==='owner'||(state.auth.role==='manager'&&m.role==='manager')?'—':'<button class="action-link" data-staff-remove="'+e(m.account_id)+'">Удалить</button>')+'</td></tr>';
  });
  const pending=invites.filter(v=>!v.accepted_at&&!v.revoked_at&&new Date(v.expires_at)>new Date());
  const invitationRows=pending.map(v=>'<tr><td class="strong">'+e(v.email)+'</td><td>'+e(v.role)+'</td><td>'+date(v.expires_at)+'</td><td><button class="action-link" data-invite-revoke="'+e(v.id)+'">Отозвать</button></td></tr>');
  const roles=state.auth.role==='owner'?['manager','operator','viewer']:['operator','viewer'];
  return '<div class="console-two"><div class="console-box"><h3>Сотрудники · '+members.length+'</h3>'+table(['Почта','Роль','Доступ'],rows)+'<h3 style="margin-top:22px">Ожидают приглашение</h3>'+table(['Почта','Роль','Истекает','Действие'],invitationRows)+'</div><div class="console-box"><h3>Пригласить сотрудника</h3><p>Одноразовый токен, действителен 48 часов. Отправьте его адресату через защищённый канал.</p><form id="invite-form" class="console-form">'+formLabel('Email','email','email','colleague@business.com','','maxlength="254"')+'<label>Роль<select name="role">'+roles.map(role=>'<option value="'+role+'">'+role+'</option>').join('')+'</select></label><button class="btn primary" type="submit">Создать приглашение</button></form>'+(state.inviteToken?'<div class="console-warning"><strong>Одноразовое приглашение — скопируйте сейчас</strong><p class="console-muted">Токен больше не будет показан после обновления.</p><input class="console-input" readonly id="invitation-token" aria-label="Токен приглашения" value="'+e(state.inviteToken)+'"><button type="button" class="btn secondary" style="margin-top:10px" data-action="copy-invite">Скопировать токен</button></div>':'')+'<p class="console-muted">Создание аккаунта возможно только по действующему приглашению. Передать его следует адресату вне этой панели.</p></div></div>';
}
function integrations(){
  if(!canManage())return '<div class="console-alert">Раздел доступен управляющим и владельцам.</div>';
  const st=state.integration?.stats||{};
  const queued=Number(st.queued||0),delivered=Number(st.delivered||0),dead=Number(st.dead||0);
  const rows=state.eventItems.map(v=>'<tr><td class="strong">'+e(v.kind)+'</td><td>'+e(v.attempts)+'</td><td>'+date(v.created_at)+'</td><td>'+e(v.dead_at?'Ошибка':v.delivered_at?'Доставлено':'В очереди')+'</td><td>'+(v.dead_at?'<button class="action-link" data-event-retry="'+e(v.id)+'">Повторить</button>':'—')+'</td></tr>');
  return '<div class="console-stats"><div class="kpi highlight"><small>В очереди</small><strong>'+queued+'</strong></div><div class="kpi"><small>Доставлено</small><strong>'+delivered+'</strong></div><div class="kpi"><small>Требуют внимания</small><strong>'+dead+'</strong></div><div class="kpi"><small>Webhook</small><strong style="font-size:16px;margin-top:20px">'+(state.integration?.webhookConfigured?'Настроен':'Не настроен')+'</strong></div></div><div class="console-box" style="margin-top:16px"><div class="row between"><h3>История событий · последние 100</h3><button class="btn secondary" data-action="refresh-data">Обновить</button></div><p>Содержимое клиентских данных здесь не выводится. Повторять можно только события в статусе ошибки.</p>'+table(['Событие','Попытки','Создано','Статус','Действие'],rows)+'</div><div class="console-warning">Подключение к внешним CRM и мессенджерам не выполняется автоматически. Для доставки нужен разрешённый HTTPS-приёмник и секрет подписи в серверном окружении.</div>';
}

function schedule(){
  const v=state.schedule,resources=state.items.resources.filter(x=>x.active),services=state.items.services.filter(x=>x.active),customers=state.items.customers;
  const resourceId=v.resourceId||resources[0]?.id||'',serviceId=v.serviceId||services[0]?.id||'',customerId=v.customerId||customers[0]?.id||'';
  const day=v.date||new Date(Date.now()+86400000).toISOString().slice(0,10);
  const opts=(items,label,selected)=>items.map(x=>'<option value="'+e(x.id)+'" '+(x.id===selected?'selected':'')+'>'+e(x[label])+'</option>').join('');
  const slots=v.slots.map((x,i)=>'<button type="button" class="btn secondary" data-slot-book="'+i+'">'+new Intl.DateTimeFormat('ru-RU',{dateStyle:'short',timeStyle:'short',timeZone:v.timezone||'UTC'}).format(new Date(x.starts_at))+'</button>').join('');
  const weekdays=['Пн','Вт','Ср','Чт','Пт','Сб','Вс'],hours=v.hours?.hours||[];
  const hoursInput=weekdays.map((label,i)=>{const row=hours.find(x=>x.weekday===i+1);return '<div class="hours-day"><label><input type="checkbox" name="active_'+(i+1)+'" '+(row?'checked':'')+'>'+label+'</label><input class="console-input" type="time" name="open_'+(i+1)+'" value="'+(row?e(row.opens_at.slice(0,5)):'09:00')+'"><input class="console-input" type="time" name="close_'+(i+1)+'" value="'+(row?e(row.closes_at.slice(0,5)):'18:00')+'"></div>'}).join('');
  const off=(v.hours?.timeOff||[]).map(x=>'<div class="feature"><div><b>'+e(x.reason)+'</b><small>'+date(x.starts_at)+' — '+date(x.ends_at)+'</small></div>'+(canManage()?'<button class="action-link" data-timeoff-delete="'+e(x.id)+'">Удалить</button>':'')+'</div>').join('');
  const closed=(v.hours?.closedDates||[]).map(x=>'<div class="feature"><div><b>'+e(x.closed_date.slice(0,10))+'</b><small>'+e(x.reason)+'</small></div>'+(canManage()?'<button class="action-link" data-closed-date-delete="'+e(x.id)+'">Удалить</button>':'')+'</div>').join('');
  const timezones=Array.from(new Set(['UTC',v.timezone||'UTC',...(Intl.supportedValuesOf?Intl.supportedValuesOf('timeZone'):['Europe/Moscow','Europe/Berlin','Europe/Stockholm','Asia/Dubai'])])).sort();
  return '<div class="console-two"><div class="console-box"><h3>Свободные окна</h3><p>Слоты рассчитаны сервером с учётом часового пояса, шагов записи, буфера, календаря и исключённых дат.</p><form id="slots-form" class="console-form"><label>Рабочий календарь<select name="resourceId" required>'+opts(resources,'name',resourceId)+'</select></label><label>Услуга<select name="serviceId" required>'+opts(services,'name',serviceId)+'</select></label><label>Клиент<select name="customerId" required>'+opts(customers,'display_name',customerId)+'</select></label><label>Дата<input type="date" name="date" required value="'+e(day)+'"></label><button class="btn primary" type="submit">Найти свободное время</button></form><p class="console-muted" style="margin:13px 0">Часовой пояс: '+e(v.timezone||'UTC')+' · шаг '+e(v.slotIntervalMinutes)+' мин · буфер '+e(v.bufferMinutes)+' мин</p><div class="slots-grid">'+(slots||'<div class="empty">Выберите дату и нажмите «Найти»</div>')+'</div><p class="console-muted">Сервер заново проверяет сетку и буфер при сохранении, поэтому устаревший слот не пройдёт.</p></div><div class="console-box"><h3>Часовой пояс компании</h3>'+(state.auth.role==='owner'?'<form id="timezone-form" class="console-form"><label>IANA timezone<select name="timezone" class="console-input">'+timezones.map(z=>'<option value="'+e(z)+'" '+(z===(v.timezone||'UTC')?'selected':'')+'>'+e(z)+'</option>').join('')+'</select></label><button class="btn secondary" type="submit">Сохранить часовой пояс</button></form>':'<p class="console-muted">Часовой пояс: '+e(v.timezone||'UTC')+'</p>')+'<p class="console-muted">Изменение запрещено, пока в компании есть будущие активные записи, чтобы время визитов не сдвинулось незаметно.</p><h3>Рабочие часы и правила ресурса</h3><label class="console-muted">Календарь для настройки</label><select id="hours-resource" class="console-input">'+opts(resources,'name',resourceId)+'</select><button type="button" class="btn ghost" data-action="load-hours" style="margin:12px 0">Загрузить график</button>'+(v.hours?'<form id="hours-form" class="console-form"><div class="policy-grid"><label>Шаг записи<select name="slotIntervalMinutes" class="console-input">'+[15,30,60].map(n=>'<option value="'+n+'" '+(n===v.slotIntervalMinutes?'selected':'')+'>'+n+' минут</option>').join('')+'</select></label><label>Буфер вокруг визита<select name="bufferMinutes" class="console-input">'+[0,5,10,15,20,30,45,60,90,120].map(n=>'<option value="'+n+'" '+(n===v.bufferMinutes?'selected':'')+'>'+n+' минут</option>').join('')+'</select></label></div><div class="hours-grid">'+hoursInput+'</div>'+(canManage()?'<button type="submit" class="btn primary">Сохранить график и правила</button>':'')+'</form><h3 style="margin-top:22px">Закрытые даты</h3><div class="feature-list">'+(closed||'<p class="console-muted">Исключённых дат нет</p>')+'</div>'+(canManage()?'<form id="closed-date-form" class="console-form compact-form"><label>Дата<input type="date" name="date" required></label><label>Причина<input name="reason" maxlength="160" value="Выходной / праздник"></label><button type="submit" class="btn secondary">Закрыть дату</button></form>':'')+'<h3 style="margin-top:22px">Блокировки времени</h3><div class="feature-list">'+(off||'<p class="console-muted">Нет блокировок</p>')+'</div>'+(canManage()?'<form id="timeoff-form" class="console-form compact-form"><label>С<input type="datetime-local" name="startsAt" required></label><label>До<input type="datetime-local" name="endsAt" required></label><label>Причина<input name="reason" maxlength="160" value="Перерыв"></label><button type="submit" class="btn secondary">Заблокировать время</button></form>':''):'<div class="console-warning">Загрузите график выбранного календаря.</div>')+'</div></div>';
}
function view(){return ({overview,appointments,schedule,customers,services,resources,staff,integrations,audit}[state.tab]||overview)()}
async function refresh(){
  state.loading=true;display();
  try{
    state.auth=await api('/auth/me');state.offline=false;
    const [dashboard,customers,services,resources,appointments]=await Promise.all([
      api('/dashboard'),api('/customers'),api('/services'),api('/resources'),api('/appointments')]);
    state.stats=dashboard.stats;
    state.items={...state.items,customers:customers.items,services:services.items,resources:resources.items,appointments:appointments.items};
    if(canManage()){
      const [audit,staff,integration,events]=await Promise.all([api('/audit'),api('/staff'),api('/integrations/status'),api('/integrations/events')]);
      state.items.audit=audit.items;state.staff=staff;state.integration=integration;state.eventItems=events.items;
    }else{state.items.audit=[];state.staff=null;state.integration=null;state.eventItems=[];}
    state.notice='';
  }catch(error){
    if(error.status===401){state.auth=null;state.stats={};state.items={customers:[],services:[],resources:[],appointments:[],audit:[]};state.staff=null;state.integration=null;state.eventItems=[];state.inviteToken='';state.offline=false;state.notice='';}
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
  if(type==='accept-form'){
    await api('/staff/invitations/accept','POST',{token:String(f.get('token')||'').trim(),password:String(f.get('password')||'')});
    state.acceptInvite=false;state.notice='Приглашение принято. Войдите с почтой вашей организации.';login();return;
  }
  if(type==='invite-form'){
    const result=await api('/staff/invitations','POST',{email:String(f.get('email')||'').trim(),role:String(f.get('role')||'')});
    state.inviteToken=result.token;await refresh();return;
  }
  if(type==='slots-form'){
    const v=state.schedule;
    v.resourceId=String(f.get('resourceId')||'');v.serviceId=String(f.get('serviceId')||'');
    v.customerId=String(f.get('customerId')||'');v.date=String(f.get('date')||'');
    const result=await api('/availability?resourceId='+encodeURIComponent(v.resourceId)+'&serviceId='+encodeURIComponent(v.serviceId)+'&date='+encodeURIComponent(v.date));
    v.slots=result.items;v.timezone=result.timezone;v.slotIntervalMinutes=result.slotIntervalMinutes;v.bufferMinutes=result.bufferMinutes;state.notice='';display();return;
  }
  if(type==='timezone-form'){
    if(state.auth.role!=='owner')throw new Error('Часовой пояс может менять только владелец');
    const result=await api('/settings/timezone','PATCH',{timezone:String(f.get('timezone')||'')});
    state.schedule.timezone=result.timezone;state.schedule.slots=[];state.schedule.hours=null;state.notice='Часовой пояс компании обновлён';display();return;
  }
  if(type==='closed-date-form'){
    if(!canManage())throw new Error('Недостаточно прав');
    const v=state.schedule;await api('/resources/'+encodeURIComponent(v.resourceId)+'/closed-dates','POST',{date:String(f.get('date')||''),reason:String(f.get('reason')||'')});
    v.hours=await api('/resources/'+encodeURIComponent(v.resourceId)+'/hours');v.slots=[];state.notice='Дата исключена из записи';display();return;
  }
  if(type==='hours-form'){
    if(!canManage())throw new Error('Недостаточно прав');
    const v=state.schedule,hours=[];
    for(let d=1;d<=7;d++)if(f.get('active_'+d))hours.push({
      weekday:d,opensAt:String(f.get('open_'+d)),closesAt:String(f.get('close_'+d))
    });
    await api('/resources/'+encodeURIComponent(v.resourceId)+'/hours','PUT',{hours,slotIntervalMinutes:Number(f.get('slotIntervalMinutes')),bufferMinutes:Number(f.get('bufferMinutes'))});
    v.hours=await api('/resources/'+encodeURIComponent(v.resourceId)+'/hours');
    v.slots=[];state.notice='Рабочие часы обновлены';display();return;
  }
  if(type==='reschedule-form'){
    if(!state.rescheduleId)throw new Error('Запись не выбрана');
    const d=new Date(String(f.get('startsAt')||''));
    if(!Number.isFinite(d.getTime()))throw new Error('Некорректная дата');
    await api('/appointments/'+encodeURIComponent(state.rescheduleId)+'/reschedule','PATCH',
      {resourceId:String(f.get('resourceId')||''),startsAt:d.toISOString()});
    state.rescheduleId=null;await refresh();state.tab='appointments';display();return;
  }
  if(type==='timeoff-form'){
    if(!canManage())throw new Error('Недостаточно прав');
    const v=state.schedule,start=new Date(String(f.get('startsAt'))),end=new Date(String(f.get('endsAt')));
    if(!Number.isFinite(start.getTime())||!Number.isFinite(end.getTime()))throw new Error('Укажите даты и время');
    await api('/resources/'+encodeURIComponent(v.resourceId)+'/time-off','POST',{
      startsAt:start.toISOString(),endsAt:end.toISOString(),reason:String(f.get('reason')||'Перерыв')
    });
    v.hours=await api('/resources/'+encodeURIComponent(v.resourceId)+'/hours');
    v.slots=[];state.notice='Период заблокирован';display();return;
  }
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
  const move=ev.target.closest('[data-reschedule]');
  if(move){state.rescheduleId=move.dataset.reschedule;state.notice='';display();return;}
  const slot=ev.target.closest('[data-slot-book]');
  if(slot){
    const v=state.schedule,chosen=v.slots[Number(slot.dataset.slotBook)];
    if(!chosen||!canWrite())return;
    try{
      await api('/appointments','POST',{customerId:v.customerId,serviceId:v.serviceId,resourceId:v.resourceId,startsAt:chosen.starts_at},
        {'Idempotency-Key':crypto.randomUUID?crypto.randomUUID():'slot-'+Date.now()});
      v.slots=[];await refresh();state.tab='schedule';display();
    }catch(error){state.notice=error.message;display();}
    return;
  }
  const delClosed=ev.target.closest('[data-closed-date-delete]');
  if(delClosed){const v=state.schedule;try{await api('/resources/'+encodeURIComponent(v.resourceId)+'/closed-dates/'+encodeURIComponent(delClosed.dataset.closedDateDelete),'DELETE');v.hours=await api('/resources/'+encodeURIComponent(v.resourceId)+'/hours');v.slots=[];state.notice='Исключённая дата удалена';display()}catch(error){state.notice=error.message;display()}return;}
  const delTime=ev.target.closest('[data-timeoff-delete]');
  if(delTime){const v=state.schedule;
    try{await api('/resources/'+encodeURIComponent(v.resourceId)+'/time-off/'+encodeURIComponent(delTime.dataset.timeoffDelete),'DELETE');
      v.hours=await api('/resources/'+encodeURIComponent(v.resourceId)+'/hours');v.slots=[];display();
    }catch(error){state.notice=error.message;display()}return;
  }
  const remove=ev.target.closest('[data-staff-remove]');
  if(remove){if(!confirm('Отозвать доступ сотрудника? Его сессии будут закрыты.'))return;
    try{await api('/staff/'+encodeURIComponent(remove.dataset.staffRemove),'DELETE');await refresh()}
    catch(error){state.notice=error.message;display()}
    return;
  }
  const revoke=ev.target.closest('[data-invite-revoke]');
  if(revoke){try{await api('/staff/invitations/'+encodeURIComponent(revoke.dataset.inviteRevoke)+'/revoke','POST');state.inviteToken='';await refresh()}
    catch(error){state.notice=error.message;display()}return;
  }
  const retry=ev.target.closest('[data-event-retry]');
  if(retry){try{await api('/integrations/events/'+encodeURIComponent(retry.dataset.eventRetry)+'/retry','POST');await refresh()}
    catch(error){state.notice=error.message;display()}return;
  }
  const action=ev.target.closest('[data-action]');if(!action)return;
  if(action.dataset.action==='retry')return refresh();
  if(action.dataset.action==='toggle-invite'){state.acceptInvite=!state.acceptInvite;state.notice='';login();return;}
  if(action.dataset.action==='refresh-data')return refresh();
  if(action.dataset.action==='load-hours'){
    const v=state.schedule;
    v.resourceId=document.getElementById('hours-resource')?.value||v.resourceId||state.items.resources[0]?.id;
    if(!v.resourceId)return;
    try{const [hours,tz]=await Promise.all([api('/resources/'+encodeURIComponent(v.resourceId)+'/hours'),api('/settings/timezone')]);
      v.hours=hours;v.timezone=tz.timezone;v.slotIntervalMinutes=hours.slotIntervalMinutes;v.bufferMinutes=hours.bufferMinutes;v.closedDates=hours.closedDates||[];v.slots=[];state.notice='';display();
    }catch(error){state.notice=error.message;display()}
    return;
  }
  if(action.dataset.action==='copy-invite'){
    const el=document.getElementById('invitation-token');
    if(!el)return;
    try{await navigator.clipboard.writeText(el.value);state.notice='Токен скопирован. Передайте его адресату безопасно.';}
    catch{el.focus();el.select();state.notice='Выделите и скопируйте токен вручную.';}
    display();return;
  }
  if(action.dataset.action.startsWith('csv-')){csv(action.dataset.action.slice(4));return;}
  if(action.dataset.action==='logout'){
    try{await api('/auth/logout','POST')}catch{}
    state.auth=null;state.stats={};state.items={customers:[],services:[],resources:[],appointments:[],audit:[]};state.staff=null;state.integration=null;state.eventItems=[];state.inviteToken='';state.notice='';state.tab='overview';login();
  }
});
root.addEventListener('submit',async ev=>{
  const form=ev.target;if(!form.id.endsWith('-form'))return;
  ev.preventDefault();
  try{await createFromForm(form)}catch(error){state.loading=false;state.notice=error.message;display();}
});
root.addEventListener('change',async ev=>{
  if(ev.target.id==='hours-resource'){
    state.schedule.resourceId=ev.target.value;state.schedule.hours=null;state.schedule.slots=[];display();return;
  }
  const role=ev.target.closest('[data-staff-role]');
  if(role){try{await api('/staff/'+encodeURIComponent(role.dataset.staffRole),'PATCH',{role:role.value});await refresh()}
    catch(error){state.notice=error.message;display()}return;}
  const select=ev.target.closest('[data-status-id]');if(!select||!select.value)return;
  try{await api('/appointments/'+encodeURIComponent(select.dataset.statusId)+'/status','PATCH',{status:select.value});await refresh()}
  catch(error){state.notice=error.message;display();}
});
refresh();
})();