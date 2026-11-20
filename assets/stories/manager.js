// OSMANX CINEMA R3 — protected operator console. No third-party code or client-side storage.
(() => {
'use strict';
const API='/api/industry/v1';
const STATES={new:'Новая',contacted:'Связались',qualified:'Квалифицирована',
 proposal:'Предложение',won:'Согласована',lost:'Не состоялась'};
const NEXT={new:['contacted','lost'],contacted:['qualified','lost'],
 qualified:['proposal','lost'],proposal:['won','lost','qualified'],won:[],lost:['contacted']};
const byId=id=>document.getElementById(id);
const element=(tag,cls='',text='')=>{const n=document.createElement(tag);if(cls)n.className=cls;if(text)n.textContent=text;return n;};
const value=(v)=>v===undefined||v===null?'':String(v);
const showAmount=v=>{
  if(v===null||v===undefined)return '—';
  return (Number(v)/100).toLocaleString('ru-RU',{maximumFractionDigits:2})+' ₽';
};
let rows=[],currentRole=null,staff=[],r5Online=false;
const csrf=()=>{
  for(const name of ['__Host-osmanx_industry_csrf','osmanx_industry_csrf']){
    const cookie=document.cookie.split('; ').find(row=>row.startsWith(name+'='));
    if(cookie)return decodeURIComponent(cookie.slice(name.length+1));
  }
  return '';
};
async function request(path,{method='GET',payload}={}){
  const options={method,credentials:'same-origin',cache:'no-store',headers:{'Accept':'application/json'}};
  if(payload!==undefined){options.body=JSON.stringify(payload);options.headers['Content-Type']='application/json';}
  if(!['GET','HEAD'].includes(method)){
    const token=csrf();if(token)options.headers['x-csrf-token']=token;
  }
  const response=await fetch(API+path,options);
  const body=await response.json().catch(()=>({}));
  if(!response.ok)throw new Error(body.error||('HTTP '+response.status));
  return body;
}
function line(container,label,number){
  const row=element('div','line');
  row.append(element('span','',label),element('b','',String(number)));
  container.append(row);
}
function metric(label,number){
  const box=element('article','metric');
  box.append(element('span','',label),element('strong','',String(number)));
  return box;
}
function present(bool){
  byId('login').hidden=bool;
  byId('workspace').hidden=!bool;
  byId('signout').hidden=!bool;
  byId('r5-subject').hidden=!(bool&&currentRole==='owner'&&r5Online);
}
function fail(message){
  present(false);
  byId('login-status').textContent=message;
}
async function reload(){
  const [data,metricData,followups]=await Promise.all([
    request('/cinema/leads?limit=100'),
    request('/cinema/metrics'),
    request('/cinema/followups?window='+encodeURIComponent(byId('r4-followup-window').value))
  ]);
  // Static R5 may precede server activation: optional calls never break the R4 operator desk.
  const optional=await Promise.allSettled([
    request('/cinema/assignees'),
    request('/cinema/performance?days='+byId('r5-report-days').value)
  ]);
  r5Online=optional.every(x=>x.status==='fulfilled');
  staff=r5Online?(optional[0].value.items||[]):[];
  if(r5Online)renderPerformance(optional[1].value);
  else byId('r5-report').textContent='Серверный модуль R5 ещё не подключён. Возможности R4 остаются доступными.';
  rows=data.items||[];
  currentRole=currentRole||'manager';
  byId('r5-subject').hidden=!(currentRole==='owner'&&r5Online);
  const stage=byId('state').value;
  renderLeads(stage);
  renderMetrics(metricData);
  renderFollowups(followups);
  byId('leads-status').textContent='Показаны первые '+rows.length+' записей, сортировка по дате. Операции защищены сессией и CSRF.';
}
function renderMetrics(data){
  const box=byId('metrics');box.replaceChildren();
  const stages=Object.fromEntries((data.stages||[]).map(x=>[x.state,x]));
  const total=Object.values(stages).reduce((sum,row)=>sum+Number(row.leads||0),0);
  const won=Number(stages.won?.leads||0);
  const agreement=(data.stages||[]).reduce((sum,x)=>sum+Number(x.won_value_minor||0),0);
  box.append(metric('Все обращения',total),metric('Новые',Number(stages.new?.leads||0)),
    metric('Согласованные сделки',won),metric('Оценка согласованных сделок',showAmount(agreement)));
  const src=byId('sources');src.replaceChildren();
  for(const x of data.sources||[])line(src,x.source,x.leads);
  if(!(data.sources||[]).length)src.textContent='Обращений пока нет.';
  const stories=byId('stories');stories.replaceChildren();
  for(const x of data.stories||[])line(stories,x.story_id,x.leads);
  if(!(data.stories||[]).length)stories.textContent='Сюжеты ещё не привели обращений.';
  const events=byId('events');events.replaceChildren();
  for(const x of (data.events||[]).slice(0,30)){
    line(events,x.date_utc+' · '+x.event_type+(x.story_id==='all'?'':' · '+x.story_id),x.total);
  }
  if(!(data.events||[]).length)events.textContent='Анонимных счётчиков пока нет.';
  const campaigns=byId('r4-campaign-metrics');campaigns.replaceChildren();
  for(const row of data.campaigns||[]){
    const card=element('div','r4-campaign-card');
    card.append(element('strong','',row.campaign_code),
      element('small','',row.leads+' запросов · '+row.won+' согласовано · оценка '+showAmount(row.won_estimate_minor)));
    campaigns.append(card);
  }
  if(!(data.campaigns||[]).length)campaigns.textContent='Кампаний с заявками пока нет.';
  const follow=data.followups||{};
  box.append(metric('Просроченные действия',Number(follow.overdue||0)));
  box.append(metric('Следующие сегодня (UTC)',Number(follow.due_today||0)));
}
function renderPerformance(report){
  const box=byId('r5-report');box.replaceChildren();
  const list=element('div','r5-report-list');
  const totals=Object.fromEntries((report.actions||[]).map(row=>[row.campaign_code+':'+row.event_type,Number(row.actions||0)]));
  for(const row of report.campaigns||[]){
    const card=element('article','r5-performance-card');
    card.append(element('strong','',row.campaign_code));
    card.append(element('div','r5-numbers',row.leads+' обращений'));
    const agreed=Number(row.agreed||0),leads=Number(row.leads||0);
    card.append(element('small','',agreed+' согласованных вручную · '+(leads?Math.round(100*agreed/leads):0)+'% от заявок в этой кампании'));
    card.append(element('small','',row.with_attempt+' с попыткой контакта · '+row.connected+' отмечены как состоявшийся контакт'));
    card.append(element('small','',String(row.attempts||0)+' попыток · среднее до первого отмеченного контакта '+(row.avg_hours_to_connection===null?'не определено':row.avg_hours_to_connection+' ч')));
    card.append(element('small','',String(totals[row.campaign_code+':film_started']||0)+' запусков фильма · '+String(totals[row.campaign_code+':brief_created']||0)+' действий с брифом (не уникальные люди)'));
    list.append(card);
  }
  box.append(list);
  if(!(report.campaigns||[]).length)box.append(element('p','hint','За выбранный период обращений ещё нет.'));
  box.append(element('p','hint','Данные считаются раздельно: событие просмотра нельзя интерпретировать как уникального посетителя, а статус сделки — как платёж.'));
}
function renderFollowups(data){
  const box=byId('r4-followup-items');box.replaceChildren();
  for(const item of data.items||[]){
    const card=element('article','r4-followup');
    card.append(element('strong','',item.contact_name+(item.organization?' · '+item.organization:'')));
    card.append(element('span','',item.story_id+' · '+item.campaign_code+' · '+(item.next_action_kind||'')));
    card.append(element('time','',new Date(item.next_action_at).toLocaleString('ru-RU')));
    box.append(card);
  }
  if(!(data.items||[]).length)box.append(element('p','hint','Нет задач на выбранный период.'));
}
function asLocalInput(value){
  if(!value)return '';
  const date=new Date(value);if(!Number.isFinite(date.getTime()))return '';
  const pad=x=>String(x).padStart(2,'0');
  return date.getFullYear()+'-'+pad(date.getMonth()+1)+'-'+pad(date.getDate())+'T'+pad(date.getHours())+':'+pad(date.getMinutes());
}
const FOLLOWUP_NAMES={call:'Позвонить',email:'Написать',proposal:'Подготовить предложение',review:'Проверить данные'};
const LOSS_NAMES={price:'Цена',timing:'Не вовремя',competitor:'Конкурент',no_response:'Нет ответа',out_of_scope:'Не наш профиль',other:'Другая'};
function csvCell(v){
  let s=value(v);
  // Prevent CSV injection in spreadsheet software, including whitespace-prefixed formulas.
  if(/^\s*[=+\-@\t\r]/.test(s))s="'"+s;
  return '"'+s.replace(/"/g,'""')+'"';
}
function exportCsv(){
  const headers=['ID','Имя','Email','Компания','Сюжет','Наблюдение','Цель','Источник','Кампания','Стадия','Оценка, коп.','Следующее действие','Срок','Причина отказа','Дата'];
  const lines=rows.map(x=>[x.id,x.contact_name,x.contact_email,x.organization,x.story_id,x.observation,x.goal,
    x.source,x.campaign_code,x.state,x.deal_value_minor,x.next_action_kind,x.next_action_at,x.loss_reason_code,x.created_at].map(csvCell).join(';'));
  const body='\ufeff'+headers.map(csvCell).join(';')+'\r\n'+lines.join('\r\n')+'\r\n';
  const href=URL.createObjectURL(new Blob([body],{type:'text/csv;charset=utf-8'}));
  const link=document.createElement('a');link.href=href;link.download='osmanx-cinema-leads.csv';
  document.body.append(link);link.click();link.remove();URL.revokeObjectURL(href);
}
function renderLeads(filter=''){
  const container=byId('leads');container.replaceChildren();
  const leads=rows.filter(row=>!filter||row.state===filter);
  for(const item of leads){
    const card=element('article','lead'),head=element('div','lead-head');
    const who=element('div');
    who.append(element('small','',item.story_id+' · '+(STATES[item.state]||item.state)),
      element('h3','',item.contact_name+(item.organization?' · '+item.organization:'')));
    const date=element('time','',new Date(item.created_at).toLocaleString('ru-RU'));
    head.append(who,date);card.append(head);
    const contact=element('p','contact');const link=element('a','',item.contact_email);link.href='mailto:'+encodeURIComponent(item.contact_email);contact.append('Email: ',link);card.append(contact);
    card.append(element('p','',item.observation),element('p','',item.goal||'Цель не указана'),element('p','hint','Кампания: '+(item.campaign_code||'direct')));
    const tools=element('div','lead-tools');
    const selector=element('select');
    selector.setAttribute('aria-label','Следующий статус заявки '+item.contact_name);
    const targets=[item.state,...(NEXT[item.state]||[])];
    for(const state of targets){
      const opt=element('option','',STATES[state]);opt.value=state;selector.append(opt);
    }
    selector.value=item.state;
    const label=element('label','', 'Оценка сделки в рублях');
    const price=element('input');price.type='number';price.min='0';price.max='1000000000';price.step='1';price.inputMode='numeric';
    price.placeholder='Не указана';price.value=item.deal_value_minor===null?'':String(Number(item.deal_value_minor)/100);
    label.append(price);
    const actionFields=element('div','r4-fields');
    const actionKindLabel=element('label','','Следующее действие');
    const actionKind=element('select');actionKind.setAttribute('aria-label','Следующее действие по заявке');
    for(const [kind,title] of Object.entries({none:'Не назначено',...FOLLOWUP_NAMES})){
      const option=element('option','',title);option.value=kind==='none'?'':kind;actionKind.append(option);
    }
    actionKind.value=item.next_action_kind||'';
    actionKindLabel.append(actionKind);
    const dueLabel=element('label','','Дата и время следующего действия');
    const due=element('input');due.type='datetime-local';due.value=asLocalInput(item.next_action_at);
    dueLabel.append(due);
    const lossLabel=element('label','','Причина отказа (для статуса «Не состоялась»)');
    const loss=element('select');loss.setAttribute('aria-label','Причина несостоявшейся сделки');
    for(const [code,title] of Object.entries({none:'Не выбрана',...LOSS_NAMES})){
      const option=element('option','',title);option.value=code==='none'?'':code;loss.append(option);
    }
    loss.value=item.loss_reason_code||'';
    lossLabel.append(loss);
    actionFields.append(actionKindLabel,dueLabel,lossLabel);card.append(actionFields);
    const staffRow=element('div','r5-staff');
    const assignedLabel=element('label','','Ответственный менеджер');
    const assignedSelect=element('select');assignedSelect.setAttribute('aria-label','Ответственный менеджер');
    const nobody=element('option','','Не назначен');nobody.value='';assignedSelect.append(nobody);
    for(const person of staff){
      const option=element('option','',person.email+' ('+person.role+')');
      option.value=person.id;assignedSelect.append(option);
    }
    assignedSelect.value=item.assigned_to||'';
    assignedLabel.append(assignedSelect);staffRow.append(assignedLabel);
    if(r5Online)card.append(staffRow);
    function refreshActionState(){
      const closed=['won','lost'].includes(selector.value);
      due.disabled=closed;actionKind.disabled=closed;loss.disabled=selector.value!=='lost';
    }
    selector.addEventListener('change',refreshActionState);refreshActionState();
    const save=element('button','','Сохранить');save.type='button';
    const status=element('p','actions-status');status.setAttribute('aria-live','polite');
    const canDelete=currentRole==='owner';
    const erase=element('button','danger','Удалить данные');erase.type='button';erase.hidden=!canDelete;
    const history=element('button','','История');history.type='button';
    tools.append(selector,label,save,history,erase);card.append(tools,status);
    if(r5Online&&!['won','lost'].includes(item.state)){
      const contactForm=element('form','r5-contact');
      contactForm.append(element('p','r5-contact-head','Зафиксировать реальную попытку связи'));
      const fields=element('div','r5-contact-fields');
      const channelLabel=element('label','','Канал связи');
      const channel=element('select');channel.setAttribute('aria-label','Канал попытки контакта');
      for(const [v,title] of Object.entries({email:'Email',phone:'Телефон',whatsapp:'WhatsApp',in_person:'Личная встреча'})){
        const option=element('option','',title);option.value=v;channel.append(option);
      }
      channelLabel.append(channel);
      const outcomeLabel=element('label','','Результат — отмечает менеджер');
      const outcome=element('select');outcome.setAttribute('aria-label','Результат контакта');
      for(const [v,title] of Object.entries({attempted:'Попытались связаться',connected:'Контакт состоялся',no_reply:'Не ответили',invalid_contact:'Неверный контакт'})){
        const option=element('option','',title);option.value=v;outcome.append(option);
      }
      outcomeLabel.append(outcome);fields.append(channelLabel,outcomeLabel);contactForm.append(fields);
      const checkboxLabel=element('label','r5-check');
      const completed=element('input');completed.type='checkbox';completed.checked=Boolean(item.next_action_at);
      checkboxLabel.append(completed,element('span','','Отметить запланированное действие выполненным и убрать срок'));contactForm.append(checkboxLabel);
      const saveContact=element('button','','Записать действие');saveContact.type='submit';
      contactForm.append(saveContact,element('p','hint','Факт контакта записывается вручную; звонки и сообщения автоматически не отправляются.'));
      contactForm.addEventListener('submit',async event=>{
        event.preventDefault();saveContact.disabled=true;
        try{
          await request('/cinema/leads/'+item.id+'/contacts',{method:'POST',payload:{
            expectedVersion:item.version,channel:channel.value,outcome:outcome.value,completeFollowup:completed.checked
          }});
          await reload();
        }catch(err){status.textContent=err.message;saveContact.disabled=false;}
      });
      card.append(contactForm);
    }
    save.addEventListener('click',async()=>{
      const state=selector.value,raw=price.value.trim();
      const kind=['won','lost'].includes(state)?null:(actionKind.value||null);
      const newDue=['won','lost'].includes(state)?null:(due.value?new Date(due.value).toISOString():null);
      const lossReason=state==='lost'?loss.value||null:null;
      const oldDue=item.next_action_at?new Date(item.next_action_at).toISOString():null;
      if(state===item.state && raw===(item.deal_value_minor===null?'':String(Number(item.deal_value_minor)/100)) &&
         kind===(item.next_action_kind||null) && newDue===oldDue && lossReason===(item.loss_reason_code||null) &&
         (!r5Online||(assignedSelect.value||null)===(item.assigned_to||null))){
        status.textContent='Нет изменений.';return;
      }
      if(state==='lost'&&!lossReason){status.textContent='Выберите причину отказа.';loss.focus();return;}
      if((kind===null)!==(newDue===null)){status.textContent='Укажите одновременно действие и дату либо очистите оба поля.';return;}
      const amount=raw===''?null:Number(raw)*100;
      if(raw && (!/^\d{1,10}$/.test(raw)||!Number.isSafeInteger(amount)||amount>100000000000)){
        status.textContent='Введите целое число рублей или оставьте поле пустым.';return;
      }
      const payload={state,dealValueMinor:amount,expectedVersion:item.version,nextActionAt:newDue,nextActionKind:kind,lossReasonCode:lossReason};
      if(r5Online)payload.assignedTo=assignedSelect.value||null;
      save.disabled=true;
      try{
        await request('/cinema/leads/'+item.id,{method:'PATCH',payload});
        status.textContent='Изменения сохранены.';
        await reload();
      }catch(err){status.textContent=err.message;save.disabled=false;}
    });
    history.addEventListener('click',async()=>{
      history.disabled=true;
      try{
        const response=await request('/cinema/leads/'+item.id+'/history');
        const detail=card.querySelector('details')||document.createElement('details');
        const summary=document.createElement('summary');summary.textContent='История изменений';
        const content=element('div','');
        for(const x of response.items||[]){
          content.append(element('p','',(new Date(x.occurred_at).toLocaleString('ru-RU'))+' · '+x.event_type+' · '+(x.new_state||'')+(x.next_action_kind?' · '+x.next_action_kind:'')+(x.loss_reason_code?' · '+x.loss_reason_code:'')+(x.contact_channel?' · '+x.contact_channel+'/'+x.contact_outcome:'')+(x.assigned_to?' · ответственный '+x.assigned_to:'')));
        }
        detail.replaceChildren(summary,content);detail.open=true;if(!detail.parentNode)card.append(detail);
      }catch(err){status.textContent=err.message;}
      finally{history.disabled=false;}
    });
    erase.addEventListener('click',async()=>{
      if(currentRole!=='owner')return;
      if(!window.confirm('Безвозвратно удалить эту заявку и историю изменений?'))return;
      erase.disabled=true;
      try{await request('/cinema/leads/'+item.id,{method:'DELETE'});await reload();}
      catch(err){status.textContent=err.message;erase.disabled=false;}
    });
    container.append(card);
  }
  if(!leads.length)container.append(element('p','hint','Заявок с выбранным статусом нет.'));
}
byId('state').addEventListener('change',e=>renderLeads(e.target.value));
byId('r4-followup-window').addEventListener('change',()=>reload().catch(e=>byId('leads-status').textContent=e.message));
byId('r5-report-days').addEventListener('change',()=>reload().catch(e=>byId('r5-report').textContent=e.message));
byId('r4-link-form').addEventListener('submit',async event=>{
  event.preventDefault();
  const name=byId('r4-campaign-name').value,story=byId('r4-campaign-story').value;
  if(!/^[a-z0-9][a-z0-9_-]{0,39}$/.test(name)){byId('r4-link-status').textContent='Введите безопасный код кампании.';return;}
  const url=new URL('https://osmanx.world/assets/stories/cinema.html');
  url.searchParams.set('story',story);url.searchParams.set('utm_campaign',name);url.hash='episodes';
  const input=byId('r4-created-link');input.value=url.href;input.hidden=false;input.focus();input.select();
  try{await navigator.clipboard.writeText(url.href);byId('r4-link-status').textContent='Ссылка скопирована.';}
  catch{byId('r4-link-status').textContent='Ссылка выделена — скопируйте её вручную.';}
});
byId('csv').addEventListener('click',exportCsv);
byId('reload').addEventListener('click',()=>reload().catch(err=>byId('leads-status').textContent=err.message));
byId('login-form').addEventListener('submit',async e=>{
  e.preventDefault();const state=byId('login-status');state.textContent='Проверяем доступ…';
  try{
    await request('/auth/login',{method:'POST',payload:{
      tenantSlug:byId('tenant').value,email:byId('email').value,password:byId('password').value
    }});
    byId('password').value='';
    const user=await request('/auth/me');
    currentRole=user.role;
    if(!['owner','manager'].includes(currentRole))throw new Error('Требуется роль владельца или менеджера');
    await reload();present(true);state.textContent='';
  }catch(err){byId('password').value='';fail(err.message);}
});
byId('signout').addEventListener('click',async()=>{
  try{await request('/auth/logout',{method:'POST',payload:{}});}catch(err){}
  currentRole=null;rows=[];staff=[];r5Online=false;byId('metrics').replaceChildren();byId('leads').replaceChildren();byId('r5-report').replaceChildren();byId('r5-subject-results').replaceChildren();
  present(false);byId('login-status').textContent='Вы вышли.';
});
async function restore(){
  try{
    const user=await request('/auth/me');
    currentRole=user.role;
    if(!['owner','manager'].includes(currentRole))return;
    await reload();present(true);
  }catch(err){present(false);}
}
restore();
})();