/* OSMANX Industry OS customer booking portal R1 — same-browser demo only */
(function(){
'use strict';
var CORE='osmanx-industry-demo-r2',OPS='osmanx-industry-ops-r3';
var catalog={
 lab:{name:'Клиники анализов',services:[['Общий анализ крови',15,750],['Биохимический профиль',30,2100],['Витамин D',15,1600],['ТТГ',15,900]]},
 dental:{name:'Стоматологии',services:[['Первичная консультация',30,1200],['Профессиональная гигиена',60,4200],['Лечение кариеса',75,6800],['Профилактический осмотр',30,1500]]},
 auto:{name:'Автосервисы',services:[['Замена масла и фильтра',60,2900],['Диагностика подвески',40,1800],['Компьютерная диагностика',40,2200],['Шиномонтаж',60,3200]]},
 beauty:{name:'Салоны и SPA',services:[['Стрижка',60,2200],['Маникюр',90,2600],['Массаж',60,3700],['Уход за лицом',75,4300]]},
 fitness:{name:'Фитнес-студии',services:[['Пробное занятие',60,600],['Разовая тренировка',60,1100],['Абонемент 8 занятий',60,6400],['Индивидуальная тренировка',60,2700]]},
 cafe:{name:'Кофейни и рестораны',services:[['Капучино',15,290],['Латте',15,330],['Сэндвич',30,440],['Завтрак',45,690]]},
 cleaning:{name:'Клининг',services:[['Поддерживающая уборка',120,3400],['Генеральная уборка',240,8900],['Уборка офиса',180,6200],['Мытьё окон',120,2800]]}
};
var params=new URLSearchParams(location.search),industry=params.get('industry');
if(!catalog[industry])industry='dental';
var selectedService='',selectedTime='',editingId='',dateChoice='',lookupPhone=sessionStorage.getItem('osmanx-booking-phone')||'',notice='',search='';
var app=document.getElementById('booking-app');
function esc(v){return String(v==null?'':v).replace(/[&<>"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]})}
function money(v){return new Intl.NumberFormat('ru-RU').format(Number(v)||0)+' ₽'}
function today(){var d=new Date();return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0')}
function later(days){var d=new Date();d.setDate(d.getDate()+days);return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0')}
function load(){
 var db;try{db=JSON.parse(localStorage.getItem(CORE)||'null')}catch(e){db=null}
 if(!db||db.version!==2||!db.data){
  var data={};Object.keys(catalog).forEach(function(k){data[k]={services:catalog[k].services.map(function(s,i){return{id:k+'-s'+i,name:s[0],duration:s[1],price:s[2]}}),customers:[],appointments:[],audit:{},settings:{brand:'OSMANX '+catalog[k].name}}});
  db={version:2,data:data};localStorage.setItem(CORE,JSON.stringify(db))
 }
 return db
}
function state(){return load().data[industry]}
function normPhone(v){return String(v||'').replace(/\D/g,'')}
function currentService(){return state().services.find(function(s){return s.id===selectedService})}
function getCapacity(){try{var x=JSON.parse(localStorage.getItem(OPS)||'{}');return Math.max(1,Math.min(100,Number(x.capacity&&x.capacity[industry])||14))}catch(e){return 14}}
function getSchedule(){var fallback={open:'09:00',close:'19:00',interval:30,bufferMinutes:0,closedDays:[],closedDates:[]};try{var x=JSON.parse(localStorage.getItem(OPS)||'{}'),s=x.schedule&&x.schedule[industry]||{};return {open:/^\d{2}:\d{2}$/.test(s.open)?s.open:fallback.open,close:/^\d{2}:\d{2}$/.test(s.close)?s.close:fallback.close,interval:[15,30,60].includes(Number(s.interval))?Number(s.interval):30,bufferMinutes:[0,5,10,15,30].includes(Number(s.bufferMinutes))?Number(s.bufferMinutes):0,closedDays:Array.isArray(s.closedDays)?s.closedDays:[],closedDates:Array.isArray(s.closedDates)?s.closedDates:[]}}catch(e){return fallback}}
function minute(v){var p=String(v||'').split(':').map(Number);return p[0]*60+p[1]}
function timeText(v){return String(v).padStart(2,'0')+':00'}
function slots(){
 var s=currentService(),day=(document.getElementById('booking-date')||{}).value||later(1),q=getSchedule();
 if(!s)return [];
 var weekday=new Date(day+'T12:00:00').getDay();if(q.closedDates.includes(day)||q.closedDays.includes(weekday))return [];
 var events=state().appointments.filter(function(a){return a.id!==editingId&&a.date===day&&a.status!=='cancelled'}).map(function(a){var svc=state().services.find(function(x){return x.id===a.serviceId});return{start:minute(a.time)-q.bufferMinutes,end:minute(a.time)+(Number(svc&&svc.duration)||60)+q.bufferMinutes}});
 var count=events.length,cap=getCapacity(),out=[],open=minute(q.open),close=minute(q.close);
 for(var m=open;m<close;m+=q.interval){var end=m+Number(s.duration||60),protectedStart=m-q.bufferMinutes,protectedEnd=end+q.bufferMinutes,conflict=events.some(function(e){return protectedStart<e.end&&protectedEnd>e.start});out.push({time:String(Math.floor(m/60)).padStart(2,'0')+':'+String(m%60).padStart(2,'0'),free:!conflict&&count<cap&&end<=close})}
 return out
}
function portalUrl(){return '?industry='+encodeURIComponent(industry)}
function serviceCards(){
 var list=state().services.filter(function(s){return s.name.toLowerCase().includes(search.toLowerCase())});
 if(!list.length)return '<div class="empty-card">Подходящие услуги не найдены. Измените запрос.</div>';
 return list.map(function(s){return '<button type="button" class="service-card '+(selectedService===s.id?'chosen':'')+'" data-service="'+esc(s.id)+'" aria-pressed="'+(selectedService===s.id)+'"><span class="service-top"><span class="service-icon">✦</span><span class="service-price">'+money(s.price)+'</span></span><strong>'+esc(s.name)+'</strong><small>'+Number(s.duration)+' мин · '+catalog[industry].name+'</small></button>'}).join('')
}
function slotButtons(){
 var items=slots();if(!items.length)return currentService()?'<div class="empty-card">На эту дату нет приёма. Выберите другую дату.</div>':'<p class="hint">Сначала выберите услугу.</p>';
 if(items.every(function(x){return !x.free}))return '<div class="empty-card">На эту дату свободного времени нет. Выберите другой день.</div>';
 return '<div class="slot-grid">'+items.map(function(x){return '<button type="button" class="slot '+(selectedTime===x.time?'chosen':'')+'" data-time="'+x.time+'" '+(!x.free?'disabled':'')+' aria-pressed="'+(selectedTime===x.time)+'">'+x.time+'</button>'}).join('')+'</div>'
}
function bookings(){
 var phone=normPhone(lookupPhone);if(phone.length<7)return '<div class="empty-card">Введите номер, который указали при записи, чтобы увидеть демо-визиты на этом устройстве.</div>';
 var s=state(),customerIds=s.customers.filter(function(c){return normPhone(c.phone)===phone}).map(function(c){return c.id});
 var rows=s.appointments.filter(function(a){return customerIds.includes(a.customerId)}).sort(function(a,b){return(a.date+a.time).localeCompare(b.date+b.time)});
 if(!rows.length)return '<div class="empty-card">Записей с таким номером не найдено в этом браузере.</div>';
 return rows.map(function(a){var svc=s.services.find(function(x){return x.id===a.serviceId});return '<article class="visit-card"><div><span class="status '+esc(a.status)+'">'+(a.status==='cancelled'?'Отменена':a.status==='confirmed'?'Подтверждена':a.status==='done'?'Выполнена':'Ожидает подтверждения')+'</span><h3>'+esc(svc?svc.name:'Услуга')+'</h3><p>'+esc(a.date)+' · '+esc(a.time)+' · '+money(svc&&svc.price)+'</p></div><div class="visit-actions">'+(a.status!=='cancelled'&&a.status!=='done'?'<button type="button" class="small-btn" data-reschedule="'+esc(a.id)+'">Перенести</button><button type="button" class="small-btn danger" data-cancel="'+esc(a.id)+'">Отменить</button>':'')+'<button type="button" class="small-btn" data-ics="'+esc(a.id)+'">В календарь</button></div></article>'}).join('')
}
function render(){
 load();var svc=currentService(),editing=state().appointments.find(function(x){return x.id===editingId}),editingCustomer=editing&&state().customers.find(function(x){return x.id===editing.customerId}),dateValue=dateChoice||(document.getElementById('booking-date')||{}).value||(editing&&editing.date)||later(1);
 app.innerHTML='<header class="top"><a class="brand" href="./index.html">OSMAN<span>X</span><small>INDUSTRY OS</small></a><a class="back-link" href="./index.html">← К демо компании</a></header>'+
 '<main class="layout"><section class="intro"><span class="eyebrow">'+esc(catalog[industry].name)+' · КЛИЕНТСКИЙ ПОРТАЛ</span><h1>Запись без звонка.<br><em>В удобное время.</em></h1><p>Выберите услугу и свободный слот. Это интерактивный пример клиентского пути для сайта и приложения.</p><div class="demo-alert"><b>Демо-режим</b> Данные остаются в localStorage этого браузера. Используйте вымышленные имя и номер: сервер, SMS и реальная запись не подключены.</div><div class="sector-links" aria-label="Выбрать отрасль">'+Object.keys(catalog).map(function(k){return '<a class="'+(k===industry?'active':'')+'" href="?industry='+k+'">'+esc(catalog[k].name)+'</a>'}).join('')+'</div></section>'+
 '<section class="workspace"><div class="flow"><section class="panel"><div class="step"><span>01</span><div><h2>Выберите услугу</h2><p>Стоимость и длительность указаны для демонстрации.</p></div></div><label class="search-label">Поиск услуги<input id="service-search" type="search" placeholder="Например, консультация" value="'+esc(search)+'"></label><div class="service-grid">'+serviceCards()+'</div></section>'+
 '<section class="panel"><div class="step"><span>02</span><div><h2>Свободное время</h2><p>Показываем интервалы без пересечения с записями и дневным лимитом.</p></div></div><div class="date-row"><label>Дата<input id="booking-date" type="date" min="'+today()+'" max="'+later(60)+'" value="'+dateValue+'"></label><div class="capacity-label"><b>'+getCapacity()+'</b><small>демо-записей в день</small></div></div><div id="slots">'+slotButtons()+'</div><p class="hint">Время в локальном демо, календарь работает без сервера.</p></section>'+
 '<section class="panel"><div class="step"><span>03</span><div><h2>'+(editingId?'Перенос записи':'Контакт для записи')+'</h2><p>Для демонстрации вводите только вымышленные данные.</p></div></div><form id="booking-form" class="booking-form"><label>Имя<input name="name" minlength="2" maxlength="54" autocomplete="name" required placeholder="Например, Демо Клиент 03" value="'+esc(editingCustomer&&editingCustomer.name||'')+'"></label><label>Телефон<input name="phone" type="tel" inputmode="tel" autocomplete="tel" required minlength="7" maxlength="24" placeholder="+7 900 000-00-00" value="'+esc(editingCustomer&&editingCustomer.phone||'')+'"></label><label class="consent"><input name="consent" type="checkbox" required><span>Согласен с обработкой данных в локальной демонстрации. Реальная отправка не выполняется.</span></label><button class="primary-btn" type="submit" '+(!selectedService||!selectedTime?'disabled':'')+'>'+(editingId?'Сохранить перенос':'Подтвердить демо-запись')+' →</button><p class="hint">Выбрано: '+(svc?esc(svc.name)+' · '+money(svc.price)+' · '+esc(dateValue)+' '+esc(selectedTime):'выберите услугу и время')+'</p></form></section></div>'+
 '<aside class="side"><section class="panel summary"><span class="eyebrow">ВАШ ВИЗИТ</span><h2>'+(svc?esc(svc.name):'Выберите услугу')+'</h2><div class="summary-line"><span>Длительность</span><b>'+(svc?Number(svc.duration)+' мин':'—')+'</b></div><div class="summary-line"><span>Стоимость</span><b>'+(svc?money(svc.price):'—')+'</b></div><div class="summary-line"><span>Время</span><b>'+esc((document.getElementById('booking-date')||{}).value||later(1))+' '+esc(selectedTime||'—')+'</b></div><div class="summary-note">Итоговая стоимость и подтверждение в реальном бизнесе определяются его системой записи.</div></section>'+
 '<section class="panel my-visits"><div class="step"><span>↻</span><div><h2>Мои демо-записи</h2><p>По номеру из формы, на этом устройстве.</p></div></div><form id="lookup-form" class="lookup-form"><label>Номер телефона<input name="lookup" type="tel" inputmode="tel" value="'+esc(lookupPhone)+'" placeholder="+7 900 000-00-00"></label><button type="submit" class="small-btn">Найти</button></form><div class="visits-list">'+bookings()+'</div></section></aside></div>'+
 '<footer>OSMANX INDUSTRY OS · Клиентский путь · Демо в браузере · <a href="./index.html">Вернуться в отраслевое демо</a></footer></main>'+
 (notice?'<div class="toast" role="status">'+esc(notice)+'</div>':'')
}
function record(kind,detail){try{var o=JSON.parse(localStorage.getItem(OPS)||'{}');o.version=1;o.audit=Array.isArray(o.audit)?o.audit:[];o.audit.unshift({id:(crypto.randomUUID?crypto.randomUUID():String(Date.now())),at:new Date().toISOString(),industry:industry,kind:kind,detail:detail});o.audit=o.audit.slice(0,120);localStorage.setItem(OPS,JSON.stringify(o))}catch(e){}}
function submit(e){
 e.preventDefault();var wasEditing=Boolean(editingId),f=new FormData(e.target),name=String(f.get('name')||'').trim(),phone=String(f.get('phone')||'').trim(),digits=normPhone(phone),s=state(),service=currentService(),date=document.getElementById('booking-date').value,time=selectedTime;
 if(!service||!time)return notify('Выберите услугу и свободное время.');
 if(name.length<2||digits.length<7||digits.length>15)return notify('Проверьте имя и номер телефона.');
 var q=getSchedule(),candidate=minute(time),close=minute(q.close),weekday=new Date(date+'T12:00:00').getDay();if(q.closedDates.includes(date)||q.closedDays.includes(weekday)||candidate<minute(q.open)||candidate+Number(service.duration)>close)return notify('Выбранное время вне графика компании. Обновите дату и слот.');
 var exists=s.appointments.some(function(a){if(a.id===editingId||a.date!==date||a.status==='cancelled')return false;var x=s.services.find(function(y){return y.id===a.serviceId});var begin=minute(a.time)-q.bufferMinutes,end=minute(a.time)+(Number(x&&x.duration)||60)+q.bufferMinutes;return candidate-q.bufferMinutes<end&&candidate+Number(service.duration)+q.bufferMinutes>begin});
 if(exists||s.appointments.filter(function(a){return a.date===date&&a.status!=='cancelled'&&a.id!==editingId}).length>=getCapacity())return notify('Слот уже занят или достигнут дневной лимит. Выберите другое время.');
 var db=load(),data=db.data[industry],customer=data.customers.find(function(c){return normPhone(c.phone)===digits});
 if(!customer){customer={id:'client-'+(crypto.randomUUID?crypto.randomUUID():Date.now()),name:name,phone:phone};data.customers.push(customer)}else customer.name=name;
 var recordId=editingId,appt=recordId&&data.appointments.find(function(a){return a.id===recordId});
 if(appt){appt.date=date;appt.time=time;appt.serviceId=service.id;appt.status='new';record('Запись перенесена',date+' '+time+' · '+service.name);editingId='';}
 else{appt={id:'booking-'+(crypto.randomUUID?crypto.randomUUID():Date.now()),customerId:customer.id,serviceId:service.id,date:date,time:time,status:'new'};data.appointments.unshift(appt);record('Клиентская запись создана',date+' '+time+' · '+service.name)}
 localStorage.setItem(CORE,JSON.stringify(db));dateChoice='';lookupPhone=phone;sessionStorage.setItem('osmanx-booking-phone',phone);selectedTime='';notice=wasEditing?'Запись перенесена в демо.':'Демо-запись создана на этом устройстве.';render();window.scrollTo({top:0,behavior:'smooth'})
}
function notify(text){notice=text;render()}
function downloadCalendar(id){
 var a=state().appointments.find(function(x){return x.id===id}),svc=a&&state().services.find(function(x){return x.id===a.serviceId}),customer=a&&state().customers.find(function(x){return x.id===a.customerId});if(!a)return;
 var dt=a.date.replace(/-/g,'')+'T'+a.time.replace(':','')+'00',endMin=minute(a.time)+(Number(svc&&svc.duration)||60),end=String(Math.floor(endMin/60)).padStart(2,'0')+String(endMin%60).padStart(2,'0');
 var text='BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//OSMANX//Industry Demo//RU\r\nBEGIN:VEVENT\r\nUID:'+esc(a.id)+'@osmanx.world\r\nDTSTAMP:'+new Date().toISOString().replace(/[-:]/g,'').replace(/\.\d{3}/,'')+'\r\nDTSTART:'+dt+'\r\nDTEND:'+a.date.replace(/-/g,'')+'T'+end+'00\r\nSUMMARY:'+String(svc&&svc.name||'Демо-запись').replace(/[\r\n,;]/g,' ')+'\r\nDESCRIPTION:Демо OSMANX. Не является подтверждением реальной записи.\r\nEND:VEVENT\r\nEND:VCALENDAR';
 var blob=new Blob([text],{type:'text/calendar;charset=utf-8'}),url=URL.createObjectURL(blob),link=document.createElement('a');link.href=url;link.download='osmanx-demo-visit.ics';link.click();setTimeout(function(){URL.revokeObjectURL(url)},1000)
}
app.addEventListener('click',function(e){
 var s=e.target.closest('[data-service]');if(s){selectedService=s.dataset.service;selectedTime='';render();return}
 var t=e.target.closest('[data-time]');if(t&&!t.disabled){selectedTime=t.dataset.time;render();return}
 var c=e.target.closest('[data-cancel]');if(c){var db=load(),ap=db.data[industry].appointments.find(function(x){return x.id===c.dataset.cancel});if(ap&&confirm('Отменить эту демо-запись?')){ap.status='cancelled';localStorage.setItem(CORE,JSON.stringify(db));record('Демо-запись отменена',ap.date+' '+ap.time);notice='Демо-запись отменена.';render()}return}
 var r=e.target.closest('[data-reschedule]');if(r){var appt=state().appointments.find(function(x){return x.id===r.dataset.reschedule});if(appt){editingId=appt.id;selectedService=appt.serviceId;selectedTime='';dateChoice=appt.date;notice='Выберите новую дату и свободное время.';render();document.getElementById('booking-date').focus()}return}
 var i=e.target.closest('[data-ics]');if(i){downloadCalendar(i.dataset.ics);return}
});
app.addEventListener('input',function(e){if(e.target.id==='service-search'){search=e.target.value;var pos=e.target.selectionStart;render();var n=document.getElementById('service-search');n.focus();n.setSelectionRange(pos,pos)}});
app.addEventListener('change',function(e){if(e.target.id==='booking-date'){selectedTime='';dateChoice=e.target.value;render()}})
app.addEventListener('submit',function(e){if(e.target.id==='booking-form')submit(e);if(e.target.id==='lookup-form'){e.preventDefault();lookupPhone=String(new FormData(e.target).get('lookup')||'').trim();sessionStorage.setItem('osmanx-booking-phone',lookupPhone);render()}})
render();
})();