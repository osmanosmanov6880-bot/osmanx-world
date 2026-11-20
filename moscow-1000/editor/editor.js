/* OSMANX R3 admin UI. Private operator data held only in page memory; no tokens stored in JS. */
(()=>{'use strict';
  const base='/moscow-1000/api/admin';
  const $=s=>document.querySelector(s);
  const node=(tag,text,cls)=>{const e=document.createElement(tag);if(text!==undefined)e.textContent=String(text);if(cls)e.className=cls;return e;};
  const empty=()=>({schemaVersion:3,method:'',metrics:null,days:[],markers:[],episodes:[]});
  let actor=null,revision=0,draft=empty(),live=null,leadOffset=0,leadStatus='all';
  const metrics={researched:'Исследовано',visits:'Визитов',dialogues:'Диалогов',decisionMeetings:'Встреч с ЛПР',proposals:'Предложений',pilots:'Пилотов',contracts:'Договоров'};
  const allowed=['day','title','summary','lesson','lat','lng','episode','evidenceRef','permissionChecked','publishedAt','rightsConfirmed','videoUrl','id'];
  function notice(id,msg,error=false){const el=$(id);if(el){el.textContent=msg;el.classList.toggle('error',!!error);}}
  async function api(path,{method='GET',body}={}){
    const response=await fetch(base+path,{method,credentials:'same-origin',headers:{Accept:'application/json',...(body!==undefined?{'Content-Type':'application/json'}:{})},body:body!==undefined?JSON.stringify(body):undefined,cache:'no-store'});
    let data;try{data=await response.json();}catch{throw Error('Сервер не вернул JSON. Проверьте Access и подключение API.');}
    if(!response.ok||data.ok===false)throw Error(data.error||('HTTP '+response.status)+(Array.isArray(data.details)?': '+data.details.join('; '):''));
    return data;
  }
  function input(label,value,change,{type='text',max=500,min,step,rows=0}={}){
    const wrapper=node('label',label),el=node(rows?'textarea':'input');
    if(!rows)el.type=type;else el.rows=rows;
    el.value=value??'';if(max)el.maxLength=max;if(min!==undefined)el.min=min;if(step)el.step=step;
    if(type==='checkbox'){el.checked=!!value;el.removeAttribute('maxlength');}
    el.addEventListener(type==='checkbox'?'change':'input',()=>change(type==='checkbox'?el.checked:type==='number'?(el.value===''?null:Number(el.value)):el.value));
    wrapper.append(el);return wrapper;
  }
  function mountCollection(id,key,fields){const parent=$(id);parent.replaceChildren();for(let i=0;i<draft[key].length;i++){
    const item=draft[key][i],card=node('div',undefined,'item'),head=node('div',undefined,'row');head.append(node('strong',(key==='days'?'День':key==='markers'?'Точка':'Эпизод')+' #'+(i+1)));
    const remove=node('button','Удалить','secondary');remove.type='button';remove.addEventListener('click',()=>{draft[key].splice(i,1);renderEditor();});head.append(remove);card.append(head);
    const grid=node('div',undefined,'fields');for(const f of fields){const val=item[f.key];const change=v=>{item[f.key]=v;};grid.append(input(f.label,val,change,f));}card.append(grid);parent.append(card);
  }}
  function renderEditor(){
    $('#revision').textContent='Ревизия '+revision+(live?.status==='published'?' · Публичная версия '+live.version:' · Публичных данных нет');
    $('#method').value=draft.method||'';
    const have=!!draft.metrics;$('#have-metrics').checked=have;$('#metric-inputs').hidden=!have;
    const list=$('#metric-inputs');list.replaceChildren();if(have)for(const [key,label] of Object.entries(metrics)){
      list.append(input(label,draft.metrics[key],n=>{draft.metrics[key]=n;},{type:'number',min:0}));
    }
    mountCollection('#days-editor','days',[{key:'day',label:'День 1–10',type:'number',min:1},{key:'summary',label:'Проверенный итог',max:500,rows:2},{key:'lesson',label:'Вывод',max:350,rows:2},{key:'evidenceRef',label:'Закрытый ID доказательства (6–80 символов)'},{key:'permissionChecked',label:'Права и конфиденциальность проверены',type:'checkbox'}]);
    mountCollection('#markers-editor','markers',[{key:'id',label:'ID точки (6–80 латинских символов)'},{key:'day',label:'День',type:'number',min:1},{key:'title',label:'Разрешённое название',max:90},{key:'lat',label:'Широта',type:'number',step:'any'},{key:'lng',label:'Долгота',type:'number',step:'any'},{key:'summary',label:'Публичное описание',rows:2,max:350},{key:'episode',label:'Связанный выпуск (день)',type:'number',min:1},{key:'evidenceRef',label:'Закрытый ID доказательства'},{key:'permissionChecked',label:'Разрешение на публикацию проверено',type:'checkbox'}]);
    mountCollection('#episodes-editor','episodes',[{key:'day',label:'День выпуска',type:'number',min:1},{key:'title',label:'Проверенное название',max:120},{key:'videoUrl',label:'Реальный /assets/...mp4 или утверждённый stream:UID',max:200},{key:'publishedAt',label:'Дата ISO UTC',max:32},{key:'evidenceRef',label:'Закрытый ID прав на видео'},{key:'rightsConfirmed',label:'Права, согласия, монтаж проверены',type:'checkbox'}]);
    $('#save-draft').disabled=!actor?.editor;$('#approve').disabled=!actor?.approver;$('#unpublish').disabled=!actor?.approver;
  }
  async function loadEditorial(){if(!actor?.editor&&!actor?.approver)return;try{const data=await api('/editorial');draft=data.draft.document;revision=data.draft.revision;live=data.live;renderEditor();notice('#editorial-result','Состояние с сервера получено. Неподтверждённые изменения на странице не публикуются.');}catch(e){notice('#editorial-result',e.message,true);}}
  async function saveDraft(){draft.method=$('#method').value;try{const r=await api('/editorial',{method:'PUT',body:{expectedRevision:revision,document:draft}});revision=r.revision;notice('#editorial-result','Черновик сохранён. Ревизия '+revision);renderEditor();}catch(e){notice('#editorial-result',e.message,true);}}
  async function approve(){if(!confirm('Опубликовать этот редакционный документ на публичном сайте после проверки доказательств и согласий?'))return;try{const r=await api('/editorial/approve',{method:'POST',body:{expectedRevision:revision}});live=r.published;renderEditor();notice('#editorial-result','Опубликовано: версия '+r.version+'. Перейдите на публичный сайт для отдельной проверки.');}catch(e){notice('#editorial-result',e.message,true);}}
  async function unpublish(){if(!confirm('Снять текущие проверенные данные с публичного API?'))return;try{await api('/editorial/unpublish',{method:'POST',body:{}});live=null;renderEditor();notice('#editorial-result','Публикация снята с API. Кэш сайта может обновиться не мгновенно.');}catch(e){notice('#editorial-result',e.message,true);}}
  function leadCard(l){const card=node('article',undefined,'lead');const h=node('h3',l.company||'Обращение без компании');card.append(h,node('p','Категория: '+l.kind+' · '+l.created_at));
    const privateContact=node('p','От: '+(l.name||'не указано')+' · '+l.email,'private');card.append(privateContact,node('p',l.message));
    const selector=node('select');for(const [v,label] of [['new','Новое'],['triaged','Разобрано'],['replied','Ответ отправлен'],['closed','Закрыто']]){const option=node('option',label);option.value=v;option.selected=l.status===v;selector.append(option);}const note=node('textarea');note.rows=2;note.maxLength=500;note.value=l.internal_note||'';note.placeholder='Внутренняя заметка (не публикуется)';
    const acts=node('div',undefined,'actions');const save=node('button','Сохранить статус');save.type='button';save.onclick=async()=>{try{await api('/leads/'+l.id,{method:'PATCH',body:{status:selector.value,internalNote:note.value}});notice('#leads-result','Статус сохранён.');}catch(e){notice('#leads-result',e.message,true);}};
    const erase=node('button','Удалить персональные данные','danger');erase.type='button';erase.onclick=async()=>{if(!confirm('Удалить это обращение и связанные внутренние заметки? Отменить невозможно.'))return;try{await api('/leads/'+l.id,{method:'DELETE',body:{}});card.remove();notice('#leads-result','Данные обращения удалены.');}catch(e){notice('#leads-result',e.message,true);}};
    acts.append(save,erase);card.append(node('label','Статус'),selector,node('label','Внутренняя заметка'),note,acts);return card;}
  async function loadLeads(append=false){if(!actor?.moderator)return;if(!append){leadOffset=0;$('#leads-list').replaceChildren();}try{const r=await api('/leads?status='+encodeURIComponent(leadStatus)+'&offset='+leadOffset);for(const item of r.leads)$('#leads-list').append(leadCard(item));if(!r.leads.length&&!append)$('#leads-list').append(node('p','В этом фильтре нет обращений.'));leadOffset=r.nextOffset||0;$('#more-leads').hidden=r.nextOffset===null;notice('#leads-result','Записи получены. Никакие контакты не опубликованы.');}catch(e){notice('#leads-result',e.message,true);}}
  function campaignCard(c){const card=node('article',undefined,'campaign');card.append(node('h3',c.subject),node('p','Выпуск '+c.episode_day+' · '+c.status+' · отправлено: '+c.sent_count),node('p',c.intro));const acts=node('div',undefined,'actions');
    const btn=(label,action)=>{const b=node('button',label,'secondary');b.type='button';b.onclick=async()=>{if(!confirm('Подтвердить действие: '+label+'?'))return;try{const r=await api('/campaigns/'+c.id+'/'+action,{method:'POST',body:{}});notice('#digest-result',r.status?('Статус: '+r.status):JSON.stringify(r));await loadCampaigns();}catch(e){notice('#digest-result',e.message,true);}};return b;};
    if(c.status==='draft'&&actor?.approver)acts.append(btn('Утвердить очередь','approve'));if(['queued','sending'].includes(c.status)&&actor?.approver)acts.append(btn('Отправить пакет до 10 писем','send-batch'));if(['draft','queued','sending'].includes(c.status)&&actor?.approver)acts.append(btn('Отменить','cancel'));card.append(acts);return card;}
  async function loadCampaigns(){if(!actor?.editor&&!actor?.approver)return;try{const r=await api('/campaigns');$('#campaigns-list').replaceChildren();$('#digest-info').textContent=r.sendEnabled?'Рассылка разрешена конфигурацией сервера. Утверждение поставит письма в очередь.':'Рассылка выключена серверной конфигурацией; черновики доступны, письма не отправляются.';for(const c of r.campaigns)$('#campaigns-list').append(campaignCard(c));if(!r.campaigns.length)$('#campaigns-list').append(node('p','Рассылок пока нет.'));}catch(e){notice('#digest-result',e.message,true);}}
  function tabs(){document.querySelectorAll('[data-tab]').forEach(b=>b.addEventListener('click',()=>{document.querySelectorAll('[data-tab]').forEach(x=>x.setAttribute('aria-selected',String(x===b)));for(const id of ['editorial','leads','digest','media','calendar','backups','security'])$('#pane-'+id).hidden=id!==b.dataset.tab;if(b.dataset.tab==='leads')loadLeads();if(b.dataset.tab==='digest')loadCampaigns();}));}
  async function bootstrap(){tabs();try{const r=await api('/session');actor=r.actor;$('#session').textContent='Доступ подтверждён: '+actor.email+' · '+[actor.editor?'Редактор':null,actor.approver?'Утверждающий':null,actor.moderator?'Модератор':null].filter(Boolean).join(' · ');$('#console').hidden=false;await loadEditorial();$('#pane-leads').querySelector('#reload-leads').disabled=!actor.moderator;$('#campaign-form').querySelector('button').disabled=!actor.editor;}catch(e){$('#session').textContent='Кабинет недоступен: '+e.message+' Нужен настроенный Cloudflare Access, Worker и D1.';return;}
    $('#method').addEventListener('input',e=>{draft.method=e.target.value;});$('#have-metrics').addEventListener('change',e=>{draft.metrics=e.target.checked?Object.fromEntries(Object.keys(metrics).map(k=>[k,0])):null;renderEditor();});
    $('#add-day').onclick=()=>{draft.days.push({day:1,summary:'',lesson:'',evidenceRef:'',permissionChecked:false});renderEditor();};
    $('#add-marker').onclick=()=>{draft.markers.push({id:'',day:1,title:'',lat:null,lng:null,summary:'',episode:1,evidenceRef:'',permissionChecked:false});renderEditor();};
    $('#add-episode').onclick=()=>{draft.episodes.push({day:1,title:'',videoUrl:'',publishedAt:'',evidenceRef:'',rightsConfirmed:false});renderEditor();};
    $('#save-draft').onclick=saveDraft;$('#approve').onclick=approve;$('#unpublish').onclick=unpublish;$('#reload').onclick=loadEditorial;
    $('#reload-leads').onclick=()=>loadLeads();$('#more-leads').onclick=()=>loadLeads(true);$('#lead-filter').onchange=e=>{leadStatus=e.target.value;loadLeads();};$('#reload-campaigns').onclick=loadCampaigns;
    $('#campaign-form').onsubmit=async e=>{e.preventDefault();const fd=new FormData(e.target);try{await api('/campaigns',{method:'POST',body:{day:Number(fd.get('day')),subject:String(fd.get('subject')),intro:String(fd.get('intro'))}});e.target.reset();await loadCampaigns();notice('#digest-result','Черновик создан. Письма ещё не отправлены.');}catch(err){notice('#digest-result',err.message,true);}};
  }
  bootstrap();
})();
