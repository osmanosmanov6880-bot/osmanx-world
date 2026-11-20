import {CASES, CHAPTERS, GROUPS, caseById, casesByGroup, currentChapter, storyURL, buildBrief, mailtoBrief, tidy} from './story-engine.js';

const make=(tag,cls='',value='')=>{
  const node=document.createElement(tag);if(cls)node.className=cls;if(value)node.textContent=value;return node;
};
function init(){
  const byId=id=>document.getElementById(id);
  const film=byId('hero-film');
  if(!film || !byId('episode-grid'))return;
  const dialog=byId('episode-dialog'), dialogVideo=byId('dialog-video');
  let tourTimer=null;
  const live=make('p','r2-visually-hidden');
  live.id='r2-live';live.setAttribute('role','status');live.setAttribute('aria-live','polite');document.body.append(live);
  const say=text=>{live.textContent=text;};
  // BLOCK 1: Chapters and a conversion-oriented end card, with user-initiated playback only.
  const nav=make('nav','r2-chapters');nav.id='r2-chapters';nav.setAttribute('aria-label','Главы фильма');
  nav.append(make('p','r2-overline','ЧЕТЫРЕ ГЛАВЫ · ВЫБЕРИТЕ СЦЕНУ'));
  const track=make('div','r2-chapter-track');nav.append(track);
  const buttons=[];
  function seekChapter(time){
    const seek=()=>{
      film.currentTime=Math.min(time,Math.max(0,film.duration-.2));
      film.play().catch(()=>say('Включите воспроизведение в самом плеере.'));
    };
    if(film.readyState>=1 && Number.isFinite(film.duration))seek();
    else {film.addEventListener('loadedmetadata',seek,{once:true});film.load();}
    const end=byId('r2-ending');if(end)end.hidden=true;
  }
  for(const chapter of CHAPTERS){
    const btn=make('button','r2-chapter',chapter.label);
    btn.type='button';btn.dataset.at=String(chapter.at);
    btn.title=chapter.description;btn.setAttribute('aria-label',chapter.label+': '+chapter.description);
    btn.addEventListener('click',()=>seekChapter(chapter.at));buttons.push(btn);track.append(btn);
  }
  const rail=make('div','r2-progress');const railFill=make('span');railFill.id='r2-progress-fill';rail.append(railFill);rail.setAttribute('aria-hidden','true');nav.append(rail);
  document.querySelector('.theater-grid').insertAdjacentElement('afterend',nav);
  function refresh(){
    const d=film.duration;
    if(!Number.isFinite(d)||d<=0)return;
    railFill.style.width=Math.min(100,Math.max(0,film.currentTime/d*100))+'%';
    const active=currentChapter(film.currentTime).at;
    for(const btn of buttons){
      const isActive=Number(btn.dataset.at)===active;btn.classList.toggle('r2-current',isActive);
      if(isActive)btn.setAttribute('aria-current','true');else btn.removeAttribute('aria-current');
    }
  }
  film.addEventListener('loadedmetadata',refresh);film.addEventListener('timeupdate',refresh);
  const end=make('div','r2-film-end');end.id='r2-ending';end.hidden=true;
  end.append(make('strong','','История завершилась. Проверка начинается.'),
    make('p','','Выберите похожую ситуацию и получите проверяемую гипотезу без выдуманных цифр.'));
  const toDiagnostic=make('a','r2-end-link','Разобрать свою ситуацию ↗');toDiagnostic.href='#r2-diagnostic';end.append(toDiagnostic);
  document.querySelector('.film-shell').append(end);
  film.addEventListener('ended',()=>{end.hidden=false;railFill.style.width='100%';say('Фильм окончен, доступен разбор ситуации.');});
  film.addEventListener('play',()=>end.hidden=true);
  film.addEventListener('error',()=>say('Не удалось загрузить фильм. Скачайте MP4 по ссылке под экраном.'));

  // BLOCK 1: Opt-in guided slideshow, manual controls retained and reduced-motion respected.
  const guide=make('button','r2-guide','▶ Автопоказ пролога');guide.type='button';guide.setAttribute('aria-pressed','false');
  document.querySelector('.presentation-tools').append(guide);
  const next=byId('next-slide'),prev=byId('prev-slide'),slideNumber=byId('slide-number');
  const reduced=()=>matchMedia('(prefers-reduced-motion: reduce)').matches;
  const stop=()=>{if(tourTimer!==null)clearTimeout(tourTimer);tourTimer=null;guide.textContent='▶ Автопоказ пролога';guide.setAttribute('aria-pressed','false');};
  function step(){
    if(tourTimer===null)return;
    if(slideNumber.textContent.trim()==='06'){
      stop();byId('theater').scrollIntoView({behavior:reduced()?'auto':'smooth'});
      say('Пролог окончен. Чтобы смотреть фильм, нажмите воспроизведение.');return;
    }
    if(!next.disabled)next.click();
    tourTimer=setTimeout(step,6200);
  }
  guide.addEventListener('click',()=>{
    if(tourTimer!==null){stop();return;}
    guide.textContent='Ⅱ Остановить автопоказ';guide.setAttribute('aria-pressed','true');
    tourTimer=setTimeout(step,5400);say('Автопоказ начался. Можно остановить в любой момент.');
  });
  prev.addEventListener('click',()=>{if(tourTimer!==null)stop();});
  next.addEventListener('click',event=>{if(event.isTrusted && tourTimer!==null)stop();});

  // BLOCK 2 & 3: Privacy-first diagnostic briefing and explicit mailto/copy actions.
  const panel=make('section','r2-diagnostic');panel.id='r2-diagnostic';panel.setAttribute('aria-labelledby','r2-title');
  panel.innerHTML=[
    '<div class="r2-work-intro"><span class="eyebrow">05 — ПЕРЕЙТИ ОТ КИНО К РЕШЕНИЯМ</span>',
    '<h3 id="r2-title">Что именно теряет <em>ваш бизнес?</em></h3>',
    '<p>Выберите сюжет и получите гипотезу, необходимые данные и способ проверки. Никаких обещаний доходности без фактов.</p></div>',
    '<form id="r2-form"><div class="r2-fields">',
    '<label for="r2-story">Выберите ситуацию<select id="r2-story" required><option value="">— Выберите сюжет —</option></select></label>',
    '<label for="r2-company">Организация (по желанию)<input id="r2-company" maxlength="90" autocomplete="organization" placeholder="Название бизнеса"></label>',
    '<label for="r2-volume">Обращений / визитов в месяц, если известно<input id="r2-volume" type="number" min="0" max="999999999" step="1" inputmode="numeric" placeholder="200"></label>',
    '<label for="r2-observation">Что вы наблюдаете?<textarea id="r2-observation" maxlength="340" rows="3" placeholder="Часть обращений не доходит до заказа"></textarea></label>',
    '<label for="r2-goal">Что хотите проверить?<textarea id="r2-goal" maxlength="240" rows="3" placeholder="В какой момент теряется клиент?"></textarea></label>',
    '</div><div class="r2-actions"><button type="submit" class="btn btn-gold">Сформировать план проверки ↗</button>',
    '<button type="reset" class="r2-secondary">Очистить поля</button></div>',
    '<p class="r2-privacy">Не вносите персональные данные клиентов, медицинские сведения или коммерческие секреты. Эта форма работает только в вашем браузере; отправка возможна лишь по вашему действию.</p></form>',
    '<div id="r2-result" class="r2-result" hidden><p class="eyebrow">ГОТОВЫЙ БРИФ</p><pre id="r2-brief" tabindex="0"></pre>',
    '<div class="r2-actions"><button id="r2-copy" class="r2-secondary" type="button">Скопировать бриф</button>',
    '<a id="r2-email" class="btn btn-gold" href="mailto:hello@osmanx.world">Отправить запрос ↗</a>',
    '<a id="r2-offer" class="r2-link" href="/assets/catalog/index.html">Открыть продукт ↗</a></div>',
    '<p id="r2-feedback" role="status" aria-live="polite"></p></div>'
  ].join('');
  document.querySelector('.after-inner').append(panel);
  const storyField=byId('r2-story'),result=byId('r2-result'),resultText=byId('r2-brief');
  for(const group of GROUPS){
    const g=document.createElement('optgroup');g.label=group.label;
    for(const entry of casesByGroup(group.id)){
      const option=make('option','',entry.sector+' — '+entry.problem);option.value=entry.id;g.append(option);
    }
    storyField.append(g);
  }
  function selectStory(id,scroll=true){
    const item=caseById(id);if(!item)return;
    storyField.value=id;result.hidden=true;
    if(scroll)panel.scrollIntoView({behavior:reduced()?'auto':'smooth',block:'start'});
    say('Выбрана ситуация: '+item.problem+'. Добавьте наблюдения и создайте бриф.');
  }
  byId('r2-form').addEventListener('submit',event=>{
    event.preventDefault();
    const item=caseById(storyField.value);if(!item){storyField.focus();say('Выберите ситуацию.');return;}
    const vol=byId('r2-volume');
    if(vol.value && !vol.checkValidity()){vol.focus();say('Проверьте указанное количество визитов.');return;}
    try{
      const brief=buildBrief({id:item.id,company:byId('r2-company').value,monthlyVolume:vol.value,concern:byId('r2-observation').value,goal:byId('r2-goal').value});
      resultText.textContent=brief;
      byId('r2-email').href=mailtoBrief(brief,item.id);
      byId('r2-offer').href=item.offer;
      byId('r2-feedback').textContent='Бриф создан локально. Ничего не отправлено.';
      result.hidden=false;result.scrollIntoView({behavior:'auto',block:'nearest'});say('План проверки готов.');
    }catch(error){say(tidy(error.message));}
  });
  byId('r2-form').addEventListener('reset',()=>{result.hidden=true;});
  byId('r2-copy').addEventListener('click',async()=>{
    try{
      if(!navigator.clipboard?.writeText)throw Error('Clipboard unavailable');
      await navigator.clipboard.writeText(resultText.textContent);
      byId('r2-feedback').textContent='Бриф скопирован.';
    }catch(error){
      resultText.focus();const selection=getSelection(),range=document.createRange();
      range.selectNodeContents(resultText);selection.removeAllRanges();selection.addRange(range);
      byId('r2-feedback').textContent='Текст выделен для ручного копирования.';
    }
  });

  // BLOCK 3: Direct case-to-offer and shareable deep-links without tracking cookies.
  const order=['01-restaurant','07-coffee','08-return','02-fashion','12-shoes','03-dentistry','09-appointment','04-auto','05-fitness','10-construction','11-logistics','06-education'];
  const cards=[...document.querySelectorAll('#episode-grid .episode')];
  cards.forEach((card,index)=>{
    const item=caseById(order[index]);if(!item)return;
    card.id='story-'+item.id;
    const actions=make('div','r2-story-actions');
    const diagnose=make('button','r2-text-button','Проверить гипотезу ↗');
    diagnose.type='button';diagnose.setAttribute('aria-label','План проверки для '+item.sector);diagnose.addEventListener('click',()=>selectStory(item.id));
    const share=make('button','r2-text-button','Поделиться');
    share.type='button';share.setAttribute('aria-label','Поделиться историей: '+item.sector);
    share.addEventListener('click',async()=>{
      const url=storyURL(item.id);
      try{
        if(navigator.share){await navigator.share({title:'OSMANX — '+item.problem,url});say('Открыто меню отправки.');}
        else if(navigator.clipboard?.writeText){await navigator.clipboard.writeText(url);say('Ссылка на историю скопирована.');}
        else {
          const input=byId('r2-share-link');input.value=url;input.hidden=false;input.focus();input.select();
          say('Ссылка выделена, скопируйте её вручную.');
        }
      }catch(error){if(error.name!=='AbortError')say('Не удалось поделиться. Ссылка доступна в адресной строке.');}
    });
    actions.append(diagnose,share);card.querySelector('.episode-text').append(actions);
  });
  const fallback=make('input','r2-share-fallback');fallback.id='r2-share-link';fallback.type='text';fallback.readOnly=true;fallback.hidden=true;fallback.setAttribute('aria-label','Ссылка на видео');panel.append(fallback);
  const params=new URLSearchParams(location.search);
  const deep=caseById(params.get('story'));
  if(deep){
    const filter=[...document.querySelectorAll('[data-filter]')].find(b=>b.dataset.filter===deep.group);
    filter?.click();selectStory(deep.id,false);
    requestAnimationFrame(()=>byId('story-'+deep.id)?.scrollIntoView({behavior:'auto',block:'center'}));
  }else{
    const group=params.get('group');
    if(GROUPS.some(x=>x.id===group)){
      [...document.querySelectorAll('[data-filter]')].find(b=>b.dataset.filter===group)?.click();
      byId('episodes').scrollIntoView({behavior:'auto'});
    }
  }

  // BLOCK 4: Only load on interaction, pause media in background, honor Save-Data.
  film.preload='none';
  document.addEventListener('visibilitychange',()=>{if(document.hidden){film.pause();dialogVideo?.pause();stop();}});
  if('IntersectionObserver' in window){
    const observer=new IntersectionObserver(entries=>{
      for(const entry of entries)if(!entry.isIntersecting && !film.paused)film.pause();
    },{threshold:.05});observer.observe(document.querySelector('.film-shell'));
  }
  if(navigator.connection?.saveData)film.preload='none';
}
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',init,{once:true});
else init();
