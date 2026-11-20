/* OSMANX public command centre. Only reviewed snapshots cross this boundary. */
(function () {
  'use strict';
  const $ = id => document.getElementById(id);
  const data = window.OSMANXCommandData;
  const geo = window.OSMANX_GEO;
  const publicData = window.OSMANX_PUBLIC_DATA;
  const icons = {
    home:'<path d="m3 10 9-7 9 7v10H15v-7H9v7H4V10"/>',
    map:'<path d="m3 5 6-2 6 2 6-2v16l-6 2-6-2-6 2V5Z"/><path d="M9 3v16M15 5v16"/><path d="m10 10 3-3 2 2-3 5-2-4Z"/>',
    people:'<circle cx="9" cy="7" r="3"/><path d="M3 21v-3a6 6 0 0 1 12 0v3M16 4a3 3 0 0 1 0 6M18 13a5 5 0 0 1 3 5v3"/>',
    contact:'<circle cx="8" cy="7" r="3"/><path d="M2 21v-3a6 6 0 0 1 12 0v3M17 4a3 3 0 0 1 0 6M17 13a5 5 0 0 1 5 5v3"/>',
    journal:'<rect x="4" y="3" width="16" height="18" rx="3"/><path d="m8 11 3 3 5-6"/>',
    flag:'<path d="M5 21V4M5 4c4-4 9 4 14 0v9c-5 4-10-4-14 0M2 21h6"/>',
    building:'<path d="M3 21h18M5 21V6l7-3 7 3v15M10 21v-5h4v5M8 8h1m6 0h1M8 11h1m6 0h1"/><path d="M2 21V10h3m14 0h3v11"/>',
    handshake:'<path d="m2 8 4-4 5 1 3-1 5 3 3 5-4 7-4 2-8-6-4-7Z"/><path d="m7 6 5 2 3-1 5 5M12 8l-4 4c1 2 3 1 4 0l6 5M7 15l2 3m1-5 4 5m0-3 3 3"/>',
    layers:'<path d="m2 7 10-5 10 5-10 5-10-5ZM2 12l10 5 10-5M2 17l10 5 10-5"/>',
    wallet:'<path d="M20 7H5a2 2 0 0 1 0-4h12v4M4 5v14a2 2 0 0 0 2 2h14V7"/><path d="M21 11h-7v6h7v-6Z"/><circle cx="16.5" cy="14" r=".5"/>',
    bell:'<path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4M12 2V1"/>',
    chevron:'<path d="m9 5 7 7-7 7"/>',plus:'<path d="M12 3v18M3 12h18"/>',back:'<path d="m14 5-7 7 7 7M7 12h14"/>',
    export:'<path d="M5 12v8h14v-8M12 16V2m-5 5 5-5 5 5"/>',
    book:'<path d="M12 5v16M3 3l9 2 9-2v16l-9 2-9-2V3Z"/>',
    info:'<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7v.2"/>',close:'<path d="m5 5 14 14M19 5 5 19"/>',
    lock:'<rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V6a4 4 0 0 1 8 0v4M12 14v3"/>',
    shield:'<path d="m12 2 9 4v6c0 5-5 8-9 10-4-2-9-5-9-10V6l9-4Z"/><path d="m7 12 3 3 7-7"/>',
    chart:'<path d="M3 21h19M5 17V9h3v8H5ZM11 17V4h3v13h-3ZM17 17V1h3v16h-3Z"/>',
    pin:'<path d="M19 9c0 5-7 13-7 13S5 14 5 9a7 7 0 1 1 14 0Z"/><circle cx="12" cy="9" r="2.5"/>',
    external:'<path d="M14 3h7v7M21 3 11 13M10 3H3v18h18v-7"/>',
    target:'<path d="M20 11a8 8 0 1 1-7-7M15 2v7h7M15 9l-4 4"/><path d="M15 13a4 4 0 1 1-4-4"/>',
    idea:'<path d="M9 18c0-4-4-4-4-9a7 7 0 0 1 14 0c0 5-4 5-4 9H9ZM9 21h6M12 13v5"/>',
    link:'<path d="m10 14 4-4M8 13l-3 3a3 3 0 0 0 4 4l4-4M11 8l4-4a3 3 0 0 1 5 4l-4 4"/>',
    partner:'<rect x="4" y="3" width="12" height="18" rx="2"/><path d="m12 8 8-6m-5 0h5v5M8 12h4M8 16h3"/>',
    trophy:'<path d="M7 3h10v5c0 5-10 5-10 0V3ZM12 12v7M8 21h8M7 5H3v3a4 4 0 0 0 4 4M17 5h4v3a4 4 0 0 1-4 4"/>',
    check:'<path d="m4 12 5 5L20 6"/>', play:'<path d="m8 4 12 8-12 8V4Z"/>'
  };
  const icon = name => `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true">${icons[name] || icons.info}</svg>`;
  function paintIcons(root=document) { root.querySelectorAll('[data-icon]').forEach(e => {e.innerHTML=icon(e.dataset.icon);}); }
  const el = (tag, cls, text) => {const e=document.createElement(tag);if(cls)e.className=cls;if(text!==undefined)e.textContent=String(text);return e;};
  const esc = value => String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const format = n => typeof n === 'number' && Number.isFinite(n) ? new Intl.NumberFormat('ru-RU',{maximumFractionDigits:0}).format(n) : '—';
  const views=['hq','map','analytics','journal','quests'];
  const initialDay=Number(new URLSearchParams(location.search).get('day'));
  const state={view:'hq',day:Number.isInteger(initialDay)&&initialDay>=1&&initialDay<=10?initialDay:1,analysis:'summary',journal:'all',snapshot:data.readSnapshot(window.OSMANX_APPROVED_PUBLICATION),editorial:null,map:null,loading:true};
  function currentRoute(){return geo.days.find(d=>d.number===state.day) || geo.days[0];}
  function totals(){return state.snapshot?.metrics || state.editorial?.metrics || null;}
  function dayMetrics(){return state.snapshot?.days.find(d=>d.day===state.day)?.metrics || null;}
  function completed(id){return !!state.snapshot?.quests.some(q=>q.questId===id&&q.completed);}
  function date(value){try{return new Intl.DateTimeFormat('ru-RU',{day:'numeric',month:'long',timeZone:'Europe/Moscow'}).format(new Date(value));}catch{return '';}}
  let toastTimer;
  function toast(message){$('toast').textContent=message;$('toast').classList.add('shown');clearTimeout(toastTimer);toastTimer=setTimeout(()=>$('toast').classList.remove('shown'),3500);}
  function dialog(title,paragraphs,extra){const box=$('dialog-content');box.replaceChildren(el('h2','',title));for(const p of paragraphs)box.append(el('p','',p));if(extra)box.append(extra);paintIcons(box);$('detail-dialog').showModal();}
  $('close-dialog').addEventListener('click',()=>$('detail-dialog').close());
  $('detail-dialog').addEventListener('click',e=>{if(e.target===$('detail-dialog')){const r=e.target.getBoundingClientRect();if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)e.target.close();}});
  function setDay(n){if(!Number.isInteger(n)||n<1||n>10)return;state.day=n;const u=new URL(location.href);u.searchParams.set('day',n);history.replaceState(null,'',u);renderAll();state.map?.setDay(n);}
  function dayButtons(container){container.replaceChildren();for(const d of geo.days){const b=el('button','',`День ${d.number}`);b.type='button';b.dataset.day=String(d.number);b.setAttribute('aria-pressed',String(d.number===state.day));b.addEventListener('click',()=>setDay(d.number));container.append(b);}}
  function showView(name,{focus=false}={}){
    if(!views.includes(name))name='hq';state.view=name;
    document.querySelectorAll('.screen').forEach(s=>{s.hidden=s.id!==`view-${name}`;});
    document.querySelectorAll('.bottom-nav a').forEach(a=>{if(a.dataset.view===name)a.setAttribute('aria-current','page');else a.removeAttribute('aria-current');});
    if(location.hash!==`#${name}`)history.replaceState(null,'',`${location.pathname}${location.search}#${name}`);
    const titles={hq:'Штаб экспедиции',map:'Карта маршрута',analytics:'Аналитика дня',journal:'Журнал экспедиции',quests:'Квесты и стратегия'};
    document.title=`${titles[name]} — OSMANX MOSCOW 1000`;
    if(name==='map'){
      if(!state.map&&window.OSMANXCommandMap){state.map=window.OSMANXCommandMap.mount($('command-map-root'),{day:state.day});if(state.editorial?.markers)state.map.setMarkers(state.editorial.markers);}
      requestAnimationFrame(()=>state.map?.refresh());
    }
    if(focus){$('main').focus({preventScroll:true});window.scrollTo({top:0,behavior:'instant'});}
  }
  function go(name){if(location.hash===`#${name}`)showView(name,{focus:true});else location.hash=name;}
  window.addEventListener('hashchange',()=>showView(location.hash.slice(1),{focus:true}));
  document.querySelectorAll('[data-go]').forEach(b=>b.addEventListener('click',()=>go(b.dataset.go)));
  function renderHome(){
    const route=currentRoute(),m=totals();
    $('hero-day').textContent=`ДЕНЬ ${state.day}`;$('mission-day').textContent=`День ${state.day}`;$('mission-route-title').textContent=route.title;
    const pct=typeof m?.researched==='number'?Math.min(100,Math.floor(m.researched/1000*100)):null;
    $('mission-value').replaceChildren(document.createTextNode(format(pct)),el('small','','%'));$('mission-bar').style.width=(pct||0)+'%';
    document.querySelectorAll('.metric-card').forEach(card=>{
      let v=m?.[card.dataset.metric];
      if(v===undefined&&card.dataset.metric==='meetings')v=m?.decisionMeetings;
      const strong=card.querySelector('strong');strong.textContent=format(v);if(card.dataset.metric==='expensesRub')strong.append(document.createTextNode(' '),el('small','','₽'));
    });
    $('goal-text').textContent=data.quests(state.day)[0].title+'. Проверь гипотезы дня.';
    const published=state.snapshot?.reviewedAt||state.editorial?.reviewedAt;
    $('publication-status').lastElementChild.textContent=published?`Подтверждено редакцией · ${date(published)}`:'Подготовка экспедиции · итоги ещё не опубликованы';
    $('publication-status').classList.toggle('is-published',!!published);
  }
  function buildQuestRow(q){const b=el('button','quest-row');b.type='button';const done=completed(q.id);b.innerHTML=`<span class="quest-icon">${icon(q.icon)}</span><span class="quest-copy">${esc(q.title)}</span><span class="quest-reward">+${q.xp} XP</span><span class="quest-check${done?' done':''}">${done?icon('check'):''}</span>`;b.setAttribute('aria-label',`${q.title}. ${done?'Выполнено и опубликовано':'В плане'}. ${q.xp} XP`);b.addEventListener('click',()=>dialog(q.title,[done?'Выполнение подтверждено автором и опубликовано.':'Задание в плане экспедиции. Подтверждённого выполнения пока нет.',`Награда за выполнение: ${q.xp} XP. Прогресс отмечается в закрытой админке.`]));return b;}
  function renderQuests(){const m=state.snapshot?.metrics,count=m?.questsCompleted,xp=m?.xp;$('quest-count').textContent=`${format(count)} / 50`;$('quest-ring').style.setProperty('--progress',`${Math.min(50,count||0)/50*360}deg`);$('quest-level').textContent=`Уровень ${typeof xp==='number'?Math.floor(xp/500)+1:'—'}`;$('quest-xp').textContent=`${format(xp)} XP`;$('xp-progress').style.width=(typeof xp==='number'?xp%500/500*100:0)+'%';$('quest-list').replaceChildren(...data.quests(state.day).map(buildQuestRow));const earned=achievementData().filter(a=>a.earned).length;$('achievements-count').textContent=typeof count==='number'?`${earned} получено`:'Ожидают старта экспедиции';}
  function achievementData(){const m=totals();return [
    {title:'Первый разговор',text:'Провести первый содержательный диалог',earned:(m?.dialogues||0)>=1,icon:'people'},
    {title:'Первые 100 дверей',text:'Изучить 100 точек',earned:(m?.researched||0)>=100,icon:'building'},
    {title:'Личная встреча',text:'Провести первую встречу',earned:(m?.meetings||m?.decisionMeetings||0)>=1,icon:'handshake'},
    {title:'Первый пилот',text:'Запустить один подтверждённый пилот',earned:(m?.pilots||0)>=1,icon:'layers'},
    {title:'Стратег',text:'Выполнить 10 квестов',earned:(m?.questsCompleted||0)>=10,icon:'target'},
    {title:'Экспедиция пройдена',text:'Выполнить все 50 квестов',earned:(m?.questsCompleted||0)>=50,icon:'trophy'}];}
  function resultPanel(m){return `<section class="panel"><h2 class="section-label">Результаты (День ${state.day})<span>${icon('chevron')}</span></h2><div class="result-grid">${[['researched','точек'],['dialogues','диалогов'],['contacts','контактов'],['meetings','встреч']].map(([k,t])=>`<div><strong>${format(m?.[k])}</strong><small>${t}</small></div>`).join('')}</div></section>`;}
  function funnelPanel(m){const vals=[['Контакт',m?.contacts],['Диалог',m?.dialogues],['Встреча',m?.meetings],['Пилот',m?.pilots]];return `<section class="panel"><h2 class="section-label">Воронка переговоров</h2><div class="funnel-layout"><div class="funnel-graphic" aria-hidden="true"><i></i><i></i><i></i><i></i></div><div class="funnel-labels">${vals.map(([label,v])=>`<div><span>${label}</span><i></i><b>${format(v)}${typeof v==='number'&&m?.contacts>0?` (${Math.round(v/m.contacts*100)}%)`:''}</b></div>`).join('')}</div></div>${!m?'<p class="empty-note">Данные появятся после публикации итогов дня.</p>':''}</section>`;}
  function renderAnalytics(){
    const box=$('analytics-content'),m=dayMetrics(),notes=state.editorial?.days.find(d=>d.day===state.day),mode=state.analysis;
    box.replaceChildren();
    if(mode==='summary'||mode==='funnel'){
      box.innerHTML=resultPanel(m)+funnelPanel(m);
      if(mode==='summary'){
        const insights=el('section','panel');insights.innerHTML=`<h2 class="insights-title">${icon('idea')}Ключевые инсайты</h2>`;
        if(notes?.summary){const list=el('ul','insight-list');list.append(el('li','',notes.summary));insights.append(list);}else insights.append(el('p','empty-note','Наблюдения ещё не опубликованы. После проверки здесь появятся выводы автора.'));
        box.append(insights);
        const hypothesis=el('section','panel next-hypothesis');hypothesis.innerHTML=`<span class="red-icon">${icon('target')}</span><div><b>Гипотеза на завтра</b><p>${esc(notes?.lesson||'Сформулируем по итогам встреч и проверим в следующем дне экспедиции.')}</p></div>`;box.append(hypothesis);
      }else{const t=el('p','analytics-note','Воронка показывает опубликованные итоги выбранного дня. Этапы не означают гарантированную конверсию или доход.');box.append(t);}
    }else if(mode==='segments'){
      const panel=el('section','panel');panel.innerHTML='<h2 class="section-label">Сегмент дня</h2>';panel.append(el('strong','stat-large',currentRoute().focus),el('p','empty-note','Исследовательский фокус маршрута. Количество и состав компаний появятся после согласования результатов.'));
      box.append(panel);
      const routes=el('section','panel');routes.innerHTML='<h2 class="section-label">Фокус экспедиции</h2>';geo.days.forEach(d=>{const row=el('div','data-row');row.append(el('span','',`День ${d.number}`),el('b','',d.focus));routes.append(row);});box.append(routes);
    }else{
      const sum=totals()?.expensesRub;const panel=el('section','panel');panel.innerHTML=`<h2 class="section-label">Бюджет экспедиции<span>10 дней</span></h2><strong class="stat-large">${format(sum)} ₽</strong><p class="empty-note">Подтверждённые расходы</p><div class="budget-track"><i style="width:${Math.min(100,(sum||0)/1000)}%"></i></div><div class="data-row"><span>Плановый лимит</span><b>100 000 ₽</b></div><div class="data-row"><span>Расходы дня ${state.day}</span><b>${format(m?.expensesRub)} ₽</b></div><div class="data-row"><span>Остаток по плану</span><b>${format(typeof sum==='number'?100000-sum:null)} ₽</b></div>`;box.append(panel,el('p','analytics-note','Лимит — план экспедиции. Фактические расходы публикует автор. Неопубликованные значения обозначены прочерком.'));
    }
    const choose=el('button','secondary-button',`День ${state.day} · сменить день`);choose.type='button';choose.style.width='100%';choose.addEventListener('click',chooseDay);box.append(choose);paintIcons(box);
  }
  function renderJournal(){
    const box=$('journal-content');box.replaceChildren();let count=0;
    for(const ep of publicData.episodes){const approved=state.editorial?.episodes.find(e=>e.day===ep.day),published=!!approved;
      if(state.journal==='published'&&!published||state.journal==='planned'&&published)continue;
      count++;const card=el('article','journal-card panel');
      card.innerHTML=`<div class="journal-day"><span>ДЕНЬ ${String(ep.day).padStart(2,'0')}</span><span class="episode-status${published?' published':''}">${published?'Опубликован':'Запланирован'}</span></div>`;
      card.append(el('h2','',approved?.title||ep.title),el('p','',ep.description));
      const actions=el('div','journal-actions');const open=el('a','',published?'Смотреть выпуск':'О выпуске');open.href=`/moscow-1000/episodes/${ep.id}/`;open.insertAdjacentHTML('beforeend',icon(published?'play':'chevron'));
      const route=el('button','text-button','Маршрут');route.type='button';route.insertAdjacentHTML('beforeend',icon('pin'));route.addEventListener('click',()=>{setDay(ep.day);go('map');});actions.append(open,route);card.append(actions);box.append(card);
    }
    if(!count){const empty=el('div','empty-state');empty.innerHTML=`<span>${icon('book')}</span><h2>История только начинается</h2><p>Документальные выпуски ещё не опубликованы. Все десять глав уже есть в плане.</p>`;const b=el('button','secondary-button','Посмотреть план');b.type='button';b.addEventListener('click',()=>{state.journal='all';syncTabs();renderJournal();});empty.append(b);box.append(empty);}
    const archive=el('a','quiet-link','О проекте и архив OSMANX');archive.href='/moscow-1000/serial/';box.append(archive);
  }
  function renderDesktop(){const list=$('desktop-days');list.replaceChildren();for(const d of geo.days){const b=el('button');b.type='button';b.innerHTML=`<b>${String(d.number).padStart(2,'0')}</b><span>${esc(d.title)}</span>`;b.setAttribute('aria-pressed',String(d.number===state.day));b.addEventListener('click',()=>{setDay(d.number);if(state.view==='hq')go('map');});list.append(b);}$('side-day-title').textContent=`День ${state.day} · ${currentRoute().title}`;$('side-day-focus').textContent=currentRoute().focus;$('side-quests').replaceChildren(...data.quests(state.day).slice(0,3).map(buildQuestRow));}
  function syncTabs(){document.querySelectorAll('[data-analysis]').forEach(b=>b.setAttribute('aria-selected',String(b.dataset.analysis===state.analysis)));document.querySelectorAll('[data-journal]').forEach(b=>b.setAttribute('aria-selected',String(b.dataset.journal===state.journal)));}
  function renderAll(){document.querySelectorAll('[data-days]').forEach(dayButtons);renderHome();renderQuests();renderAnalytics();renderJournal();renderDesktop();syncTabs();paintIcons();}
  function chooseDay(){const list=el('div','day-tabs');for(const route of geo.days){const b=el('button','',`День ${route.number}`);b.type='button';b.setAttribute('aria-pressed',String(route.number===state.day));b.addEventListener('click',()=>{setDay(route.number);$('detail-dialog').close();});list.append(b);}dialog('Десять дней Москвы',['Выбери день: штаб, карта, аналитика и квесты переключатся вместе.'],list);}
  $('choose-day').addEventListener('click',chooseDay);$('mission-route').addEventListener('click',()=>go('map'));$('open-route').addEventListener('click',()=>go('map'));$('daily-goal').addEventListener('click',()=>go('quests'));
  document.querySelectorAll('.metric-card').forEach(b=>b.addEventListener('click',()=>{state.analysis=b.dataset.metric==='expensesRub'?'budget':'summary';syncTabs();renderAnalytics();go('analytics');}));
  document.querySelectorAll('[data-analysis]').forEach(b=>b.addEventListener('click',()=>{state.analysis=b.dataset.analysis;syncTabs();renderAnalytics();}));
  document.querySelectorAll('[data-journal]').forEach(b=>b.addEventListener('click',()=>{state.journal=b.dataset.journal;syncTabs();renderJournal();}));
  document.querySelectorAll('[role=tablist]').forEach(list=>list.addEventListener('keydown',e=>{if(!['ArrowLeft','ArrowRight','Home','End'].includes(e.key))return;const tabs=Array.from(list.querySelectorAll('[role=tab]'));let i=tabs.indexOf(document.activeElement);if(i<0)return;e.preventDefault();i=e.key==='Home'?0:e.key==='End'?tabs.length-1:(i+(e.key==='ArrowRight'?1:-1)+tabs.length)%tabs.length;tabs[i].focus();tabs[i].click();}));
  $('notifications').addEventListener('click',()=>{const released=state.editorial?.episodes.length||0;const link=el('a','secondary-button','Открыть журнал');link.href='#journal';link.addEventListener('click',()=>$('detail-dialog').close());dialog('Новости экспедиции',[released?`Опубликовано выпусков: ${released}. Последние истории доступны в журнале.`:'Экспедиция готовится к старту. Здесь появятся новые выпуски и подтверждённые итоги.'],link);});
  $('map-info').addEventListener('click',()=>dialog('Карта Москвы',['Реальная карта OpenStreetMap и публичные ориентиры маршрутов. Координаты помогают изучить район.','Линия соединяет ориентиры условно: карта не содержит проверенных пешеходных маршрутов. Местоположение автора и закрытые контакты не отображаются.']));
  $('journal-info').addEventListener('click',()=>dialog('Десять дней. Десять глав.',['В журнале — план документальных выпусков и опубликованные истории экспедиции. Публикация появляется после проверки материалов автором.']));
  $('quests-info').addEventListener('click',()=>dialog('50 квестов экспедиции',['На каждый день запланировано пять задач: диалоги, партнёры, проверка гипотез, наблюдения и следующий шаг.','Опубликованное выполнение приносит XP и открывает достижения. Зрители следят за результатом; задания отмечает автор.']));
  $('achievements').addEventListener('click',()=>{const list=el('div');achievementData().forEach(a=>{const item=el('div','achievement-item');item.innerHTML=`<span>${icon(a.icon)}</span><div><b>${esc(a.title)}</b><small>${esc(a.text)} · ${a.earned?'получено':'впереди'}</small></div>`;list.append(item);});dialog('Достижения',[],list);});
  $('export-public').addEventListener('click',()=>{if(!state.snapshot&&!state.editorial)return toast('Опубликованных результатов для экспорта пока нет.');const safe=state.snapshot||state.editorial;const payload={project:'OSMANX MOSCOW 1000',exportedAt:new Date().toISOString(),day:state.day,reviewedAt:safe.reviewedAt,metrics:safe.metrics,days:safe.days};const blob=new Blob([JSON.stringify(payload,null,2)],{type:'application/json;charset=utf-8'});const url=URL.createObjectURL(blob);const a=el('a');a.href=url;a.download='OSMANX_PUBLIC_RESULTS.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);toast('Опубликованная сводка сохранена.');});
  async function loadPublic(path){const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),8000);try{const r=await fetch(path,{headers:{Accept:'application/json'},credentials:'omit',signal:controller.signal,cache:'no-store'});if(!r.ok||!r.headers.get('content-type')?.includes('application/json'))return null;const text=await r.text();if(text.length>150000)return null;return JSON.parse(text);}catch{return null;}finally{clearTimeout(timer);}}
  function readEditorial(raw){const normalized=data.readSnapshot(raw);if(!normalized)return null;return {...normalized,
    markers:Array.isArray(raw.markers)?raw.markers.filter(m=>m&&Number.isInteger(m.day)&&m.day>=1&&m.day<=10&&Number.isFinite(m.lat)&&Number.isFinite(m.lng)&&typeof m.title==='string'&&typeof m.id==='string').map(m=>({id:m.id.slice(0,80),day:m.day,lat:m.lat,lng:m.lng,title:m.title.slice(0,90),summary:typeof m.summary==='string'?m.summary.slice(0,350):''})):[],
    episodes:Array.isArray(raw.episodes)?raw.episodes.filter(e=>e&&Number.isInteger(e.day)&&e.day>=1&&e.day<=10&&typeof e.title==='string'&&typeof e.publishedAt==='string').map(e=>({day:e.day,title:e.title.slice(0,120),publishedAt:e.publishedAt})):[]};}
  renderAll();showView(location.hash.slice(1));
  Promise.allSettled([loadPublic('/moscow-1000/api/command/public'),loadPublic('/moscow-1000/api/public-release')]).then(results=>{const command=results[0].status==='fulfilled'?data.readSnapshot(results[0].value):null;const editorial=results[1].status==='fulfilled'?readEditorial(results[1].value):null;if(command)state.snapshot=command;if(editorial)state.editorial=editorial;state.loading=false;renderAll();if(editorial&&state.map)state.map.setMarkers(editorial.markers);});
  window.addEventListener('offline',()=>toast('Нет сети. Открытые экраны остаются доступны.'));
})();
