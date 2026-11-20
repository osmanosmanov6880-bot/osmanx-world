// OSMANX CINEMA R3: explicit, consent-based lead handoff with fail-safe email fallback.
import {caseById} from './story-engine.js';
const API='/api/industry/v1/cinema';
const rawCampaign=new URLSearchParams(location.search).get('utm_campaign');
const campaignCode=rawCampaign&&/^[a-z0-9][a-z0-9_-]{0,39}$/.test(rawCampaign)?rawCampaign:'direct';
function el(tag,cls,text=''){const n=document.createElement(tag);if(cls)n.className=cls;if(text)n.textContent=text;return n;}
function boot(){
  const existing=document.querySelector('#r3-intake');
  if(existing)return;
  const r2=document.querySelector('#r2-result'), form=document.querySelector('#r2-form');
  if(!r2||!form)return;
  const section=el('section','r3-lead');
  section.id='r3-intake';
  section.setAttribute('aria-labelledby','r3-heading');
  section.innerHTML=[
    '<div class="r3-lead-head"><span class="eyebrow">06 — ПЕРЕЙТИ К ДИАЛОГУ</span>',
    '<h3 id="r3-heading">Обсудим вашу <em>диагностику.</em></h3>',
    '<p>Отправьте короткий запрос без оплаты и обязательств. Сначала проверим задачу, данные и условия работы.</p></div>',
    '<p id="r3-availability" class="r3-status" role="status">Проверяем возможность безопасной отправки…</p>',
    '<form id="r3-lead-form" hidden>',
    '<div class="r3-input-grid">',
    '<label for="r3-name">Как к вам обращаться?<input id="r3-name" autocomplete="name" required minlength="2" maxlength="120"></label>',
    '<label for="r3-email">Рабочий email<input id="r3-email" type="email" autocomplete="email" required maxlength="254"></label>',
    '</div>',
    '<label class="r3-honey" for="r3-website" aria-hidden="true">Ваш сайт<input tabindex="-1" autocomplete="off" id="r3-website" name="website"></label>',
    '<label class="r3-consent"><input id="r3-consent" type="checkbox" required><span>Согласен на обработку указанных контактных данных для ответа на запрос. <a href="/assets/stories/privacy.html" target="_blank" rel="noopener">Как используются и удаляются данные</a>. Рекламные рассылки этим согласием не разрешаются.</span></label>',
    '<div class="r3-buttons"><button type="submit" class="btn btn-gold" id="r3-submit">Отправить запрос ↗</button>',
    '<a id="r3-email-fallback" class="r3-alt" href="mailto:hello@osmanx.world">Или открыть письмо →</a></div>',
    '<p id="r3-result" class="r3-result" role="status" aria-live="polite"></p>',
    '</form>',
    '<p id="r3-offline" hidden>Прямой приём заявок ещё не подключён. Сформированный бриф можно отправить через кнопку «Отправить запрос» выше — она открывает письмо.</p>'
  ].join('');
  r2.append(section);
  const status=document.getElementById('r3-availability');
  const leadForm=document.getElementById('r3-lead-form');
  const offline=document.getElementById('r3-offline');
  const feedback=document.getElementById('r3-result');
  const send=document.getElementById('r3-submit');
  let enabled=false, metrics=false, requestKey=null, sent=false;
  const get=id=>document.getElementById(id);
  async function configure(){
    try{
      const response=await fetch(API+'/public/config',{credentials:'same-origin',cache:'no-store',signal:AbortSignal.timeout(6500)});
      if(!response.ok)throw new Error('unavailable');
      const body=await response.json();
      enabled=body.intakeEnabled===true;
      metrics=body.aggregateEventsEnabled===true;
    }catch(err){enabled=false;metrics=false;}
    status.textContent=enabled?'Доступна защищённая отправка запроса.': 'Онлайн-приём временно недоступен. Отправьте сформированный бриф по email.';
    leadForm.hidden=!enabled;
    offline.hidden=enabled;
  }
  void configure();
  function record(eventType,storyId='all'){
    if(!metrics)return;
    // Anonymous aggregate click counter: no cookies, IP, contact details, device IDs or user IDs sent.
    void fetch(API+'/public/events',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({eventType,storyId,campaignCode}),keepalive:true}).catch(()=>{});
  }
  const film=get('hero-film');
  let filmStart=false,filmEnd=false,briefCreated=false;
  film?.addEventListener('play',()=>{if(!filmStart){filmStart=true;record('film_started');}});
  film?.addEventListener('ended',()=>{if(!filmEnd){filmEnd=true;record('film_finished');}});
  const resultObserver=new MutationObserver(()=>{
    if(!r2.hidden && !briefCreated){briefCreated=true;record('brief_created',get('r2-story').value||'all');}
    if(r2.hidden){sent=false;requestKey=null;send.disabled=false;feedback.textContent='';}
    const fallback=get('r2-email')?.href;
    if(fallback)get('r3-email-fallback').href=fallback;
  });
  resultObserver.observe(r2,{attributes:true,attributeFilter:['hidden']});
  for(const id of ['r2-offer','r2-email','r3-email-fallback']){
    get(id)?.addEventListener('click',()=>record('offer_opened',get('r2-story').value||'all'));
  }
  leadForm.addEventListener('submit',async event=>{
    event.preventDefault();
    if(!enabled){feedback.textContent='Прямой приём отключён. Используйте email.';return;}
    if(sent)return;
    if(!leadForm.reportValidity())return;
    const item=caseById(get('r2-story').value);
    const observation=get('r2-observation').value.trim();
    if(!item||observation.length<8){
      feedback.textContent='Укажите ситуацию и наблюдение (не меньше 8 символов) в диагностическом брифе.';
      get('r2-observation').focus();return;
    }
    if(!get('r3-consent').checked){get('r3-consent').focus();return;}
    if(!requestKey) requestKey=crypto.randomUUID();
    const payload={
      storyId:item.id,contactName:get('r3-name').value,contactEmail:get('r3-email').value,
      organization:get('r2-company').value,observation:observation,
      goal:get('r2-goal').value,source:'cinema',campaignCode,consent:true,website:get('r3-website').value
    };
    send.disabled=true;feedback.textContent='Отправляем запрос…';
    try{
      const response=await fetch(API+'/public/leads',{method:'POST',credentials:'same-origin',
        headers:{'Content-Type':'application/json','Idempotency-Key':requestKey},body:JSON.stringify(payload),
        signal:AbortSignal.timeout(12000),cache:'no-store'});
      const answer=await response.json().catch(()=>({}));
      if(!response.ok||answer.accepted!==true){
        if(response.status===503){enabled=false;leadForm.hidden=true;offline.hidden=false;}
        throw new Error(answer.error||'Заявка не подтверждена сервером.');
      }
      sent=true;
      feedback.textContent='Заявка принята сервером. Номер: '+String(answer.reference||'не указан')+'. Сохраните его для переписки.';
      feedback.dataset.state='success';
      send.textContent='Заявка отправлена';
    }catch(err){
      feedback.textContent='Не удалось подтвердить отправку. Данные можно отправить по email. '+(err.message||'');
      feedback.dataset.state='error';
      send.disabled=false;
    }
  });
  form.addEventListener('reset',()=>{
    requestKey=null;sent=false;feedback.textContent='';send.disabled=false;
    send.textContent='Отправить запрос ↗';
  });
}
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',boot,{once:true});else boot();
window.addEventListener('osmanx:cinema-r2-ready',boot);
