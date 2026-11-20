/* OSMANX public command centre. Only reviewed snapshots cross this boundary. */
(function () {
  'use strict';
  const $ = id => document.getElementById(id);
  const data = window.OSMANXCommandData;
  const offline = window.OSMANXPublicOffline;
  const navigation = window.OSMANXNavigation;
  let storage;
  try { storage = window.localStorage; } catch { storage = null; }
  const approvedStore = offline.createStore(storage);
  const bookmarkStore = navigation.createStore(storage);
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
    check:'<path d="m4 12 5 5L20 6"/>', play:'<path d="m8 4 12 8-12 8V4Z"/>',
    bookmark:'<path d="M6 3h12v19l-6-4-6 4V3Z"/>', share:'<circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><path d="m9 10 6-4M9 14l6 4"/>'
  };
  const icon = name => `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true">${icons[name] || icons.info}</svg>`;
  function paintIcons(root=document) { root.querySelectorAll('[data-icon]').forEach(e => {e.innerHTML=icon(e.dataset.icon);}); }
  const el = (tag, cls, text) => {const e=document.createElement(tag);if(cls)e.className=cls;if(text!==undefined)e.textContent=String(text);return e;};
  const esc = value => String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const format = n => typeof n === 'number' && Number.isFinite(n) ? new Intl.NumberFormat('ru-RU',{maximumFractionDigits:0}).format(n) : '—';
  const views=['hq','map','analytics','journal','quests'];
  const initialRoute=navigation.parse(location.href);
  const cachedCommand = approvedStore.read('command'), cachedEditorial = approvedStore.read('editorial');
  const state={...initialRoute,snapshot:cachedCommand?.snapshot||data.readSnapshot(window.OSMANX_APPROVED_PUBLICATION),editorial:cachedEditorial?.snapshot||null,map:null,loading:true,connection:{command:cachedCommand?'cached':'pending',editorial:cachedEditorial?'cached':'pending'},lastCheck:0};
  function currentRoute(){return geo.days.find(d=>d.number===state.day) || geo.days[0];}
  function totals(){return state.snapshot?.metrics || state.editorial?.metrics || null;}
  function dayMetrics(){return state.snapshot?.days.find(d=>d.day===state.day)?.metrics || null;}
  function completed(id){return !!state.snapshot?.quests.some(q=>q.questId===id&&q.completed);}
  function date(value){try{return new Intl.DateTimeFormat('ru-RU',{day:'numeric',month:'long',timeZone:'Europe/Moscow'}).format(new Date(value));}catch{return '';}}
  let toastTimer;
  function toast(message){$('toast').textContent=message;$('toast').classList.add('shown');clearTimeout(toastTimer);toastTimer=setTimeout(()=>$('toast').classList.remove('shown'),3500);}
  let dialogOpener,renderOpenBookmarks=null,dialogPublication=null;
  function publicationKey(){return [state.snapshot?.version,state.snapshot?.reviewedAt,state.editorial?.version,state.editorial?.reviewedAt].join('|');}
  function dialog(title,paragraphs,extra,dependsOnPublication=false){
    renderOpenBookmarks=null;dialogPublication=dependsOnPublication?publicationKey():null;
    dialogOpener=document.activeElement;
    const box=$('dialog-content'),heading=el('h2','',title);heading.id='dialog-title';
    box.replaceChildren(heading);for(const p of paragraphs)box.append(el('p','',p));if(extra)box.append(extra);
    paintIcons(box);document.documentElement.classList.add('dialog-open');$('detail-dialog').showModal();
  }
  $('close-dialog').addEventListener('click',()=>$('detail-dialog').close());
  $('detail-dialog').addEventListener('close',()=>{renderOpenBookmarks=null;dialogPublication=null;document.documentElement.classList.remove('dialog-open');(dialogOpener?.isConnected?dialogOpener:$('main')).focus({preventScroll:true});});
  $('detail-dialog').addEventListener('click',e=>{if(e.target===$('detail-dialog')){const r=e.target.getBoundingClientRect();if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)e.target.close();}});
  let appliedRouteURL='';
  function syncMapSelection(){
    if(!state.map)return;
    if(state.point){
      const selected=state.map.getSelectedPoint?.();
      if(selected?.id===state.point)return;
      if(!state.map.selectPoint(state.point,{notify:false,focus:false})){
        state.map.clearSelection({notify:false,focus:false});
        if(/^area-\d+-\d+$/.test(state.point)||state.connection.editorial==='current'){state.point=null;history.replaceState(null,'',navigation.path(state));appliedRouteURL=location.href;renderNavigationTools();}
      }
    }else state.map.clearSelection({notify:false,focus:false});
  }
  function applyRoute(route,{focus=false}={}){
    const oldDay=state.day;Object.assign(state,navigation.normalize(route));
    if(state.map&&oldDay!==state.day)state.map.setDay(state.day);
    renderAll();showView(state.view,{focus});syncMapSelection();renderNavigationTools();appliedRouteURL=location.href;
  }
  function navigate(patch,{replace=false,focus=true}={}){
    const next=navigation.normalize({...state,...patch}),url=navigation.path(next);
    if(location.pathname+location.search+location.hash!==url)history[replace?'replaceState':'pushState'](null,'',url);
    applyRoute(next,{focus});
  }
  function setDay(n){if(!Number.isInteger(n)||n<1||n>10)return;navigate({day:n,point:n===state.day?state.point:null},{focus:false});}
  function dayButtons(container){
    if(!container.children.length){
      container.setAttribute('role','group');
      for(const d of geo.days){const b=el('button','',`День ${d.number}`);b.type='button';b.dataset.day=String(d.number);b.addEventListener('click',()=>setDay(d.number));container.append(b);}
      container.addEventListener('keydown',e=>{
        if(!['ArrowLeft','ArrowRight','Home','End'].includes(e.key))return;
        const buttons=[...container.querySelectorAll('button')],index=buttons.indexOf(document.activeElement);if(index<0)return;
        e.preventDefault();const next=e.key==='Home'?0:e.key==='End'?buttons.length-1:(index+(e.key==='ArrowRight'?1:-1)+buttons.length)%buttons.length;
        setDay(Number(buttons[next].dataset.day));buttons[next].focus({preventScroll:true});
      });
    }
    for(const b of container.children){const active=Number(b.dataset.day)===state.day;b.setAttribute('aria-pressed',String(active));b.tabIndex=active?0:-1;}
    requestAnimationFrame(()=>{const active=container.querySelector('[aria-pressed=true]');if(!active||!container.clientWidth)return;const a=active.getBoundingClientRect(),c=container.getBoundingClientRect();if(a.right>c.right)container.scrollLeft+=a.right-c.right+16;else if(a.left<c.left)container.scrollLeft-=c.left-a.left+16;});
  }
  function showView(name,{focus=false}={}){
    if(!views.includes(name))name='hq';state.view=name;
    document.querySelectorAll('.screen').forEach(s=>{s.hidden=s.id!==`view-${name}`;});
    $(`view-${name}`).querySelectorAll('[data-days]').forEach(dayButtons);
    document.querySelectorAll('.bottom-nav a').forEach(a=>{if(a.dataset.view===name)a.setAttribute('aria-current','page');else a.removeAttribute('aria-current');});
    const titles={hq:'Штаб экспедиции',map:'Карта маршрута',analytics:'Аналитика дня',journal:'Журнал экспедиции',quests:'Квесты и стратегия'};
    document.title=`${titles[name]} — OSMANX MOSCOW 1000`;
    if(name==='map'){
      if(!state.map&&window.OSMANXCommandMap){state.map=window.OSMANXCommandMap.mount($('command-map-root'),{day:state.day,markers:state.editorial?.markers||[],onSelect:(point,day,meta)=>{if(meta?.reason==='withdrawn'&&state.connection.editorial!=='current')return;navigate({view:'map',day,point:point?.id||null},{focus:false,replace:meta?.reason==='withdrawn'});}});}
      requestAnimationFrame(()=>state.map?.refresh());
    }
    if(focus){$('main').focus({preventScroll:true});window.scrollTo({top:0,behavior:'instant'});}
  }
  function go(name){navigate({view:name,point:name==='map'?state.point:null});}
  function restoreRoute(){if(location.href===appliedRouteURL)return;applyRoute(navigation.parse(location.href),{focus:true});}
  window.addEventListener('hashchange',restoreRoute);
  window.addEventListener('popstate',restoreRoute);
  document.querySelectorAll('.bottom-nav a,.brand,.desktop-wordmark').forEach(a=>a.addEventListener('click',e=>{if(e.button!==0||e.metaKey||e.ctrlKey||e.shiftKey||e.altKey)return;e.preventDefault();go(a.dataset.view||'hq');}));
  document.querySelector('.skip-link').addEventListener('click',e=>{e.preventDefault();$('main').focus();});
  document.querySelectorAll('[data-go]').forEach(b=>b.addEventListener('click',()=>go(b.dataset.go)));
  function renderHome(){
    const route=currentRoute(),m=totals();
    $('hero-day').textContent=`ДЕНЬ ${state.day}`;$('mission-day').textContent=`День ${state.day}`;$('mission-route-title').textContent=route.title;
    const pct=typeof m?.researched==='number'?Math.min(100,Math.floor(m.researched/1000*100)):null;
    $('mission-value').replaceChildren(document.createTextNode(format(pct)),el('small','','%'));$('mission-bar').style.width=(pct||0)+'%';
    document.querySelectorAll('.metric-card').forEach(card=>{
      let v=m?.[card.dataset.metric];
      if(v===undefined&&card.dataset.metric==='meetings')v=m?.decisionMeetings;
      const strong=card.querySelector('strong');strong.textContent=format(v);strong.classList.toggle('compact',format(v).length>6);if(card.dataset.metric==='expensesRub')strong.append(document.createTextNode(' '),el('small','','₽'));
    });
    $('goal-text').textContent=data.quests(state.day)[0].title+'. Проверь гипотезы дня.';
    const published=state.snapshot?.reviewedAt||state.editorial?.reviewedAt;
    $('publication-status').lastElementChild.textContent=published?`Подтверждено редакцией · ${date(published)}`:'Подготовка экспедиции · итоги ещё не опубликованы';
    $('publication-status').classList.toggle('is-published',!!published);
  }
  function buildQuestRow(q){const b=el('button','quest-row');b.type='button';const done=completed(q.id);b.innerHTML=`<span class="quest-icon">${icon(q.icon)}</span><span class="quest-copy">${esc(q.title)}</span><span class="quest-reward">+${q.xp} XP</span><span class="quest-check${done?' done':''}">${done?icon('check'):''}</span>`;b.setAttribute('aria-label',`${q.title}. ${done?'Выполнено и опубликовано':'В плане'}. ${q.xp} XP`);b.addEventListener('click',()=>dialog(q.title,[done?'Выполнение подтверждено автором и опубликовано.':'Задание в плане экспедиции. Подтверждённого выполнения пока нет.',`Награда за выполнение: ${q.xp} XP. Прогресс отмечается в закрытой админке.`],null,true));return b;}
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
      const route=el('button','text-button','Маршрут');route.type='button';route.insertAdjacentHTML('beforeend',icon('pin'));route.addEventListener('click',()=>navigate({day:ep.day,view:'map',point:null}));actions.append(open,route);card.append(actions);box.append(card);
    }
    if(!count){const empty=el('div','empty-state');empty.innerHTML=`<span>${icon('book')}</span><h2>История только начинается</h2><p>Документальные выпуски ещё не опубликованы. Все десять глав уже есть в плане.</p>`;const b=el('button','secondary-button','Посмотреть план');b.type='button';b.addEventListener('click',()=>navigate({view:'journal',journal:'all'},{focus:false}));empty.append(b);box.append(empty);}
    const archive=el('a','quiet-link','О проекте и архив OSMANX');archive.href='/moscow-1000/serial/';box.append(archive);
  }
  function renderDesktop(){const list=$('desktop-days'),focusedDay=list.contains(document.activeElement)?document.activeElement.dataset.day:null;list.replaceChildren();for(const d of geo.days){const b=el('button');b.type='button';b.dataset.day=String(d.number);b.innerHTML=`<b>${String(d.number).padStart(2,'0')}</b><span>${esc(d.title)}</span>`;b.setAttribute('aria-pressed',String(d.number===state.day));b.addEventListener('click',()=>navigate({day:d.number,view:state.view==='hq'?'map':state.view,point:null},{focus:false}));list.append(b);}if(focusedDay)list.querySelector(`[data-day="${focusedDay}"]`)?.focus({preventScroll:true});$('side-day-title').textContent=`День ${state.day} · ${currentRoute().title}`;$('side-day-focus').textContent=currentRoute().focus;$('side-quests').replaceChildren(...data.quests(state.day).slice(0,3).map(buildQuestRow));}
  function syncTabs(){
    for(const [kind,key,panel] of [['analysis','analysis','analytics-content'],['journal','journal','journal-content']]){
      document.querySelectorAll(`[data-${kind}]`).forEach(b=>{const active=b.dataset[kind]===state[key];b.setAttribute('aria-selected',String(active));b.tabIndex=active?0:-1;b.id=`${kind}-tab-${b.dataset[kind]}`;b.setAttribute('aria-controls',panel);if(active)$(panel).setAttribute('aria-labelledby',b.id);});
    }
  }
  function renderAll(){if($('detail-dialog').open){if(renderOpenBookmarks){if(dialogPublication!==publicationKey()){renderOpenBookmarks();dialogPublication=publicationKey();}}else if(dialogPublication!==null&&dialogPublication!==publicationKey())$('detail-dialog').close();}document.querySelectorAll('[data-days]').forEach(dayButtons);renderHome();renderQuests();renderAnalytics();renderJournal();renderDesktop();syncTabs();renderNavigationTools();paintIcons();}
  function routeLabel(route){
    const day=geo.days.find(item=>item.number===route.day),names={hq:'Штаб',map:'Карта',analytics:'Аналитика',journal:'Журнал',quests:'Квесты'};
    let detail=names[route.view];
    if(route.view==='analytics')detail+=' · '+({summary:'сводка',funnel:'воронка',segments:'сегменты',budget:'бюджет'}[route.analysis]);
    if(route.view==='journal'&&route.journal!=='all')detail+=' · '+(route.journal==='planned'?'план':'выпуски');
    if(route.point){const anchor=day?.anchors.find((_,index)=>route.point===`area-${route.day}-${index}`),marker=state.editorial?.markers.find(item=>item.day===route.day&&item.id===route.point);detail=anchor?.label||marker?.title||'Сохранённая точка';}
    return {title:detail,subtitle:`День ${route.day} · ${day?.title||'Москва'}`};
  }
  function renderNavigationTools(){
    const current=navigation.path(state),items=bookmarkStore.read(),saved=items.some(item=>item.id===current);
    $('save-place').setAttribute('aria-pressed',String(saved));$('save-place-label').textContent=saved?'Сохранено':'Сохранить';
    $('saved-places-count').textContent=items.length?String(items.length):'';
    document.querySelectorAll('.bottom-nav a,.brand,.desktop-wordmark').forEach(a=>{a.href=navigation.path({...state,view:a.dataset.view||'hq'});});
  }
  function openSavedPlaces(){
    const list=el('div','saved-place-list');
    function render(){
      const items=bookmarkStore.read();list.replaceChildren();
      if(!items.length){list.append(el('p','empty-note','Открой нужный день, экран или точку на карте и нажми «Сохранить». Закладки останутся в этом браузере.'));return;}
      for(const item of items){
        const row=el('div','saved-place'),label=routeLabel(item.route),open=el('a','saved-place-open');
        open.href=navigation.path(item.route);open.append(el('b','',label.title),el('small','',label.subtitle));
        open.addEventListener('click',event=>{if(event.button!==0||event.metaKey||event.ctrlKey||event.shiftKey||event.altKey)return;event.preventDefault();dialogOpener=$('main');$('detail-dialog').close();navigate(item.route);});
        const remove=el('button','icon-button');remove.type='button';remove.innerHTML=icon('close');remove.setAttribute('aria-label',`Удалить закладку: ${label.title}, день ${item.route.day}`);
        remove.addEventListener('click',()=>{if(!bookmarkStore.remove(item.id)){toast('Браузер не разрешил изменить закладки.');return;}render();renderNavigationTools();(list.querySelector('a')||$('close-dialog')).focus({preventScroll:true});});
        row.append(open,remove);list.append(row);
      }
    }
    render();dialog('Сохранённые места',['До 20 закладок на этом устройстве. Они не меняют результаты экспедиции.'],list);renderOpenBookmarks=render;dialogPublication=publicationKey();
  }
  async function shareCurrent(){
    const url=navigation.shareURL(state,location.href),label=routeLabel(state);
    if(!url)return toast('Ссылку можно получить при открытии сайта по HTTP или HTTPS.');
    if(typeof navigator.share==='function'){
      try{await navigator.share({title:`OSMANX · ${label.title}`,text:label.subtitle,url});return;}catch(error){if(error?.name==='AbortError')return;}
    }
    if(navigator.clipboard?.writeText){try{await navigator.clipboard.writeText(url);toast('Ссылка на текущий экран скопирована.');return;}catch{}}
    const box=el('div','share-fallback'),labelNode=el('label','','Ссылка на текущий экран'),input=el('input');input.id='share-url';input.type='url';input.readOnly=true;input.value=url;labelNode.htmlFor=input.id;box.append(labelNode,input);
    dialog('Поделиться экраном',['Скопируй ссылку. В ней сохранены день, раздел и выбранная точка. Доступ к сайту определяется его настройками.'],box);input.focus();input.select();
  }
  $('save-place').addEventListener('click',()=>{const result=bookmarkStore.add(state);renderNavigationTools();toast(({saved:'Место сохранено в этом браузере.',exists:'Это место уже есть в закладках.',full:'Сохранено 20 мест. Удали ненужную закладку, чтобы добавить новую.',unavailable:'Браузер не разрешил сохранить закладку. Можно скопировать ссылку.'})[result.status]);});
  $('saved-places').addEventListener('click',openSavedPlaces);
  $('share-place').addEventListener('click',shareCurrent);
  window.addEventListener('storage',event=>{if(event.key===navigation.key||event.key===null)renderNavigationTools();});
  function chooseDay(){const list=el('div','day-picker');for(const route of geo.days){const b=el('button','day-choice');b.type='button';b.append(el('b','',`День ${route.number}`),el('span','',route.title));b.setAttribute('aria-pressed',String(route.number===state.day));b.addEventListener('click',()=>{setDay(route.number);$('detail-dialog').close();toast(`День ${route.number} · ${route.title}`);});list.append(b);}dialog('Десять дней Москвы',['Выбери район: карта, сводка и квесты переключатся вместе.'],list);list.querySelector('[aria-pressed=true]')?.focus({preventScroll:true});}
  $('choose-day').addEventListener('click',chooseDay);$('mission-route').addEventListener('click',()=>go('map'));$('open-route').addEventListener('click',()=>go('map'));$('daily-goal').addEventListener('click',()=>go('quests'));
  document.querySelectorAll('.metric-card').forEach(b=>b.addEventListener('click',()=>navigate({view:'analytics',analysis:b.dataset.metric==='expensesRub'?'budget':'summary'})));
  document.querySelectorAll('[data-analysis]').forEach(b=>b.addEventListener('click',()=>navigate({view:'analytics',analysis:b.dataset.analysis},{focus:false})));
  document.querySelectorAll('[data-journal]').forEach(b=>b.addEventListener('click',()=>navigate({view:'journal',journal:b.dataset.journal},{focus:false})));
  document.querySelectorAll('[role=tablist]').forEach(list=>list.addEventListener('keydown',e=>{if(!['ArrowLeft','ArrowRight','Home','End'].includes(e.key))return;const tabs=Array.from(list.querySelectorAll('[role=tab]'));let i=tabs.indexOf(document.activeElement);if(i<0)return;e.preventDefault();i=e.key==='Home'?0:e.key==='End'?tabs.length-1:(i+(e.key==='ArrowRight'?1:-1)+tabs.length)%tabs.length;tabs[i].focus();tabs[i].click();}));
  $('notifications').addEventListener('click',()=>{const released=state.editorial?.episodes.length||0;const link=el('a','secondary-button','Открыть журнал');link.href=navigation.path({...state,view:'journal'});link.addEventListener('click',event=>{if(event.button!==0||event.metaKey||event.ctrlKey||event.shiftKey||event.altKey)return;event.preventDefault();$('detail-dialog').close();go('journal');});dialog('Новости экспедиции',[released?`Опубликовано выпусков: ${released}. Последние истории доступны в журнале.`:'Экспедиция готовится к старту. Здесь появятся новые выпуски и подтверждённые итоги.'],link,true);});
  $('map-info').addEventListener('click',()=>dialog('Карта Москвы',['Реальная карта OpenStreetMap и публичные ориентиры маршрутов. Координаты помогают изучить район.','Линия соединяет ориентиры условно: карта не содержит проверенных пешеходных маршрутов. Местоположение автора и закрытые контакты не отображаются.']));
  $('journal-info').addEventListener('click',()=>dialog('Десять дней. Десять глав.',['В журнале — план документальных выпусков и опубликованные истории экспедиции. Публикация появляется после проверки материалов автором.']));
  $('quests-info').addEventListener('click',()=>dialog('50 квестов экспедиции',['На каждый день запланировано пять задач: диалоги, партнёры, проверка гипотез, наблюдения и следующий шаг.','Опубликованное выполнение приносит XP и открывает достижения. Зрители следят за результатом; задания отмечает автор.']));
  $('achievements').addEventListener('click',()=>{const list=el('div');achievementData().forEach(a=>{const item=el('div','achievement-item');item.innerHTML=`<span>${icon(a.icon)}</span><div><b>${esc(a.title)}</b><small>${esc(a.text)} · ${a.earned?'получено':'впереди'}</small></div>`;list.append(item);});dialog('Достижения',[],list,true);});
  $('export-public').addEventListener('click',()=>{
    if(!state.snapshot&&!state.editorial)return toast('Опубликованных результатов для экспорта пока нет.');
    const kind=state.snapshot?'command':'editorial',safe=state.snapshot||state.editorial;
    const payload={project:'OSMANX MOSCOW 1000',exportedAt:new Date().toISOString(),day:state.day,reviewedAt:safe.reviewedAt,
      source:state.connection[kind]==='current'?'published-online':'last-published-copy',
      checkedAt:state.connection[kind]==='current'&&state.lastCheck?new Date(state.lastCheck).toISOString():null,metrics:safe.metrics,days:safe.days};
    const blob=new Blob([JSON.stringify(payload,null,2)],{type:'application/json;charset=utf-8'});const url=URL.createObjectURL(blob);const a=el('a');a.href=url;a.download='OSMANX_PUBLIC_RESULTS.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);toast('Опубликованная сводка сохранена.');
  });
  async function loadPublic(path){const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),8000);try{const r=await fetch(path,{headers:{Accept:'application/json'},credentials:'omit',signal:controller.signal,cache:'no-store'});if(!r.ok||!r.headers.get('content-type')?.includes('application/json'))return null;const text=await r.text();if(text.length>150000)return null;return JSON.parse(text);}catch{return null;}finally{clearTimeout(timer);}}
  function fullDate(value){try{return new Intl.DateTimeFormat('ru-RU',{day:'numeric',month:'short',hour:'2-digit',minute:'2-digit',timeZone:'Europe/Moscow'}).format(new Date(value))+' МСК';}catch{return '';}}
  function connectionBanner(){
    const statuses=Object.values(state.connection),stale=statuses.includes('cached'),unavailable=statuses.includes('unavailable');
    const disconnected=navigator.onLine===false;
    const banner=$('connection-banner');banner.hidden=!stale&&!unavailable&&!disconnected;
    $('retry-public').disabled=state.loading;
    $('retry-public').textContent=state.loading?'Проверяем…':'Обновить';
    if(banner.hidden)return;
    const stamp=[['command','snapshot'],['editorial','editorial']].filter(([kind])=>state.connection[kind]==='cached').map(([,field])=>state[field]?.reviewedAt).filter(Boolean).sort()[0];
    let copy=disconnected?'Нет сети. ':state.loading?'Проверяем обновления. ':'Не удалось обновить все данные. ';
    copy+=stale&&stamp?`Сохранённая публикация от ${fullDate(stamp)}. Она может быть устаревшей.`:'План и квесты доступны; свежие итоги появятся после подключения.';
    $('connection-copy').textContent=copy;
  }
  let refreshing;
  async function refreshPublic(){
    if(refreshing)return refreshing;
    state.loading=true;connectionBanner();
    refreshing=(async()=>{
      const tickets={command:approvedStore.begin('command'),editorial:approvedStore.begin('editorial')};
      const values=await Promise.all([loadPublic('/moscow-1000/api/command/public'),loadPublic('/moscow-1000/api/public-release')]);
      for(const [index,kind,field] of [[0,'command','snapshot'],[1,'editorial','editorial']]){
        const result=approvedStore.accept(kind,values[index],tickets[kind]);
        if(result.status==='superseded')continue;
        if(result.status==='published'){state[field]=result.snapshot;state.connection[kind]='current';}
        else if(result.status==='unpublished'){state[field]=null;state.connection[kind]='current';}
        else {const retained=approvedStore.read(kind);state[field]=retained?.snapshot||null;state.connection[kind]=retained?'cached':'unavailable';}
      }
      state.lastCheck=Date.now();state.loading=false;renderAll();connectionBanner();
      if(state.map){state.map.setMarkers(state.editorial?.markers||[]);syncMapSelection();}
    })().finally(()=>{refreshing=null;state.loading=false;connectionBanner();});
    return refreshing;
  }
  $('retry-public').addEventListener('click',()=>refreshPublic());
  navigate(initialRoute,{replace:true,focus:false});connectionBanner();refreshPublic();
  window.addEventListener('online',()=>refreshPublic());
  function expireRetained(){
    let changed=false;
    for(const [kind,field] of [['command','snapshot'],['editorial','editorial']]){
      if(state.connection[kind]!=='cached')continue;
      if(!approvedStore.read(kind)){state[field]=null;state.connection[kind]='unavailable';changed=true;}
    }
    if(changed){renderAll();state.map?.setMarkers(state.editorial?.markers||[]);}
    connectionBanner();
  }
  window.addEventListener('offline',()=>{
    for(const kind of ['command','editorial'])state.connection[kind]=approvedStore.read(kind)?'cached':'unavailable';
    for(const [kind,field] of [['command','snapshot'],['editorial','editorial']])if(state.connection[kind]==='unavailable')state[field]=null;
    renderAll();state.map?.setMarkers(state.editorial?.markers||[]);connectionBanner();
  });
  document.addEventListener('visibilitychange',()=>{if(!document.hidden){expireRetained();if(Date.now()-state.lastCheck>60000)refreshPublic();}});
  setInterval(()=>{if(!document.hidden){expireRetained();if(navigator.onLine!==false&&Date.now()-state.lastCheck>60000)refreshPublic();}},60000);
  if('serviceWorker' in navigator&&(location.protocol==='https:'||['localhost','127.0.0.1'].includes(location.hostname))){
    navigator.serviceWorker.register('/moscow-1000/command-sw.js',{scope:'/moscow-1000/',updateViaCache:'none'}).catch(()=>{/* Online interface stays usable when shell caching is unavailable. */});
  }
})();
