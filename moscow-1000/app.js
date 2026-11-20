(function () {
  'use strict';
  const data = window.OSMANX_PUBLIC_DATA;
  const $ = selector => document.querySelector(selector);
  const statusLabels = {planned:'В подготовке', editing:'Монтаж', published:'Смотреть выпуск'};
  const projectLabels = {preparation:'ПРОЕКТ ГОТОВИТСЯ', active:'ЭКСПЕДИЦИЯ ИДЁТ', completed:'СЕЗОН ЗАВЕРШЁН'};
  const allowedStatuses = new Set(Object.keys(statusLabels));
  const safeId = id => /^\d{2}$/.test(id) && Number(id)>=1 && Number(id)<=10;
  const safeVideoSrc = src => typeof src === 'string' && (src.startsWith('/assets/') || src.startsWith('/moscow-1000/')) && !src.includes('..') && !src.includes('\\') && !/[\u0000-\u001f]/.test(src);
  const make = (tag, className, text) => {const el=document.createElement(tag);if(className)el.className=className;if(text!==undefined)el.textContent=String(text);return el;};
  function cleanEpisode(item){
    if(!item || !safeId(item.id) || !allowedStatuses.has(item.status)) return null;
    return item;
  }
  function playableEpisode(item){return !!(item && item.status==='published' && item.video && safeVideoSrc(item.video.src) && typeof item.publishedAt==='string');}
  function projectStatus(){
    const target=$('[data-project-status]');
    if(target)target.textContent=projectLabels[data.project.status]||projectLabels.preparation;
  }
  function renderStats(){
    const s=data.project.approvedStatistics;
    const keys=['researched','dialogues','decisionMeetings','pilots'];
    for(const key of keys){
      const el=document.querySelector('[data-stat="'+key+'"]');
      if(!el)continue;
      // The approval flag is mandatory; don't turn missing data into 0.
      const value=s && s.approved===true && Number.isSafeInteger(s[key]) && s[key]>=0 ? s[key] : null;
      el.textContent=value===null?'Данных пока нет':new Intl.NumberFormat('ru-RU').format(value);
    }
  }
  function renderCards(){
    const grid=$('#episode-list');if(!grid)return;
    grid.replaceChildren();
    for(const item of data.episodes){
      const ep=cleanEpisode(item);if(!ep)continue;
      const link=make('a','episode'+(playableEpisode(ep)?' published':''));
      link.href='/moscow-1000/episodes/'+ep.id+'/';link.setAttribute('aria-label','Эпизод '+ep.id+': '+ep.title+', '+statusLabels[ep.status]);
      link.append(make('span','ep-number',ep.id),make('span','ep-status',statusLabels[ep.status]),make('strong','ep-title',ep.title),make('span','ep-description',ep.description),make('span','ep-action',playableEpisode(ep)?'Воспроизвести ↗':'Открыть анонс ↗'));
      grid.append(link);
    }
  }
  function renderEpisode(){
    const main=$('#episode-main');if(!main)return;
    const match=window.location.pathname.match(/\/episodes\/(\d{2})\/?$/);
    const explicit=document.body.getAttribute('data-episode');
    const id=match?.[1]||explicit;
    const ep=data.episodes.find(x=>x.id===id);
    if(!ep){main.replaceChildren(make('p','','Эпизод не найден.'));return;}
    const title=$('#episode-page-title'), desc=$('#episode-page-desc'), status=$('#episode-page-status');
    if(title)title.textContent=ep.title;
    if(desc)desc.textContent=ep.description;
    if(status)status.textContent=statusLabels[ep.status]||'В подготовке';
    const container=$('#episode-content');if(!container)return;
    container.replaceChildren();
    if(playableEpisode(ep)){
      const section=make('section','episode-video');
      const vid=make('video');vid.controls=true;vid.playsInline=true;vid.preload='metadata';vid.src=ep.video.src;
      if(ep.video.poster && safeVideoSrc(ep.video.poster))vid.poster=ep.video.poster;
      vid.setAttribute('aria-label','Эпизод '+ep.id+' '+ep.title);
      section.append(vid);
      const subtitleList=Array.isArray(ep.video.subtitles)?ep.video.subtitles:[];
      for(const t of subtitleList){if(t && safeVideoSrc(t.src) && /^[a-z]{2}(-[A-Z]{2})?$/.test(t.srclang||'')){
        const track=make('track');track.kind='subtitles';track.src=t.src;track.srclang=t.srclang;track.label=String(t.label||t.srclang);vid.append(track);
      }}
      const speed=make('label','speed-label','Скорость просмотра '),select=make('select');
      select.setAttribute('aria-label','Скорость воспроизведения');
      for(const val of [0.75,1,1.25,1.5,2]){const o=make('option','',val+'×');o.value=String(val);if(val===1)o.selected=true;select.append(o);}
      select.addEventListener('change',()=>vid.playbackRate=Number(select.value));speed.append(select);section.append(speed);
      if(Array.isArray(ep.video.chapters)&&ep.video.chapters.length){const ul=make('ul','episode-chapters');for(const ch of ep.video.chapters){if(!Number.isFinite(ch.time)||ch.time<0)continue;const li=make('li'),b=make('button','',ch.title||'Глава');b.type='button';b.addEventListener('click',()=>{vid.currentTime=ch.time;vid.play().catch(()=>{});});li.append(b);ul.append(li);}section.append(ul);}
      const err=make('p','player-error','Видео временно недоступно. Попробуйте позже.');err.hidden=true;
      vid.addEventListener('error',()=>err.hidden=false);section.append(err);container.append(section);
    } else {
      const panel=make('div','episode-empty');
      panel.append(make('h2','','Этот выпуск пока готовится.'),make('p','','Это редакционная тема будущего документального эпизода. Материал станет доступен только после съёмок, разрешений и проверки фактов. Здесь нет постановочного репортажа и выдуманных результатов.'));
      const p=make('p','', 'Пока можно посмотреть существующую постановочную видеоисторию OSMANX STORIES или вернуться к списку эпизодов.');panel.append(p);
      const actions=make('div','episode-bottom');const back=make('a','btn btn-secondary','К списку эпизодов');back.href='/moscow-1000/#episodes';
      const film=make('a','btn btn-main','Доступный фильм ↗');film.href='/moscow-1000/#film';actions.append(back,film);panel.append(actions);container.append(panel);
    }
    if(Array.isArray(ep.approvedFacts) && ep.approvedFacts.length){const facts=make('aside','episode-verified');facts.append(make('h2','','Проверенные публичные факты'));const ul=make('ul');for(const fact of ep.approvedFacts){if(typeof fact==='string'&&fact.length<500)ul.append(make('li','',fact));}facts.append(ul);container.append(facts);}
    const next=data.episodes.find(x=>Number(x.id)>Number(ep.id)&&playableEpisode(x));
    const nextLink=$('#next-episode-link');if(nextLink){nextLink.hidden=!next;if(next){nextLink.href='/moscow-1000/episodes/'+next.id+'/';nextLink.textContent='Следующий опубликованный выпуск: '+next.title+' ↗';}}
  }
  function initArchive(){
    const video=$('#archive-video');if(!video)return;
    const speed=$('#playback-speed'), opt=$('#resume-opt-in'), error=$('#video-error');
    if(speed)speed.addEventListener('change',()=>{const n=Number(speed.value);if([0.75,1,1.25,1.5,2].includes(n))video.playbackRate=n;});
    const key='osmanx-moscow-1000-r1-archive-position';
    const consentKey='osmanx-moscow-1000-r1-consent';
    try{opt.checked=localStorage.getItem(consentKey)==='yes';}catch{}
    function restore(){if(!opt.checked)return;try{const saved=Number(localStorage.getItem(key));if(Number.isFinite(saved)&&saved>=0&&saved<(video.duration||Infinity))video.currentTime=saved;}catch{}}
    video.addEventListener('loadedmetadata',restore);
    opt.addEventListener('change',()=>{try{if(opt.checked){localStorage.setItem(consentKey,'yes');restore();}else{localStorage.removeItem(consentKey);localStorage.removeItem(key);}}catch{opt.checked=false;}});
    let last=0;video.addEventListener('timeupdate',()=>{if(!opt.checked||Math.abs(video.currentTime-last)<5)return;last=video.currentTime;try{localStorage.setItem(key,String(Math.round(video.currentTime)));}catch{}});
    video.addEventListener('ended',()=>{try{localStorage.removeItem(key);}catch{}});
    video.addEventListener('error',()=>{if(error)error.hidden=false;});
  }
  if(!data || !Array.isArray(data.episodes)){document.body.setAttribute('data-loading-error','yes');return;}
  projectStatus();renderStats();renderCards();renderEpisode();initArchive();
  window.OSMANX_R1_TEST_HOOKS=Object.freeze({safeId,playableEpisode,safeVideoSrc});
})();
