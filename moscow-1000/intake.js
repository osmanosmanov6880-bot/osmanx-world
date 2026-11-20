(function () {
  'use strict';
  const api='/moscow-1000/api';
  const lead=document.getElementById('r2-lead-form');
  const subscription=document.getElementById('r2-subscribe-form');
  if(!lead||!subscription)return;
  const state={siteKey:null,loaded:false};
  function show(id,text){const out=document.getElementById(id);if(out){out.textContent=text;out.setAttribute('role','status');}}
  function fillTurnstile(container,action){return new Promise((resolve,reject)=>{
    if(!window.turnstile){reject(Error('Turnstile is not loaded'));return;}
    let current='';const id=window.turnstile.render(container,{sitekey:state.siteKey,action,callback:(v)=>{current=v;},'expired-callback':()=>{current='';},'error-callback':()=>{current='';}});
    resolve({getToken:()=>current,reset:()=>{current='';window.turnstile.reset(id);}});
  });}
  function loadTurnstile(){return new Promise((resolve,reject)=>{
    if(window.turnstile){resolve();return;}
    const script=document.createElement('script');script.src='https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';script.async=true;script.onload=resolve;script.onerror=()=>reject(Error('Не удалось загрузить проверку формы.'));document.head.append(script);
  });}
  async function submitForm(form,kind,widget,msgId){form.addEventListener('submit',async event=>{
    event.preventDefault();const btn=form.querySelector('button[type="submit"]');if(!form.reportValidity())return;
    const tok=widget.getToken();if(!tok){show(msgId,'Подтвердите проверку защиты формы.');return;}
    const fd=new FormData(form);const payload={email:String(fd.get('email')||''),consent:fd.get('consent')==='on',honeypot:String(fd.get('website')||''),turnstileToken:tok};
    if(kind==='lead')Object.assign(payload,{kind:String(fd.get('kind')||''),name:String(fd.get('name')||''),company:String(fd.get('company')||''),message:String(fd.get('message')||'')});
    btn.disabled=true;show(msgId,'Отправка…');
    try{const controller=new AbortController();const timeout=setTimeout(()=>controller.abort(),15000);let response;try{response=await fetch(api+(kind==='lead'?'/leads':'/subscribe'),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload),signal:controller.signal,cache:'no-store',credentials:'same-origin'});}finally{clearTimeout(timeout);}const data=await response.json();if(!response.ok||!data.ok)throw Error(data.error||'Не удалось отправить.');show(msgId,data.message||'Запрос обработан.');form.reset();}
    catch(err){show(msgId,err.message||'Сервис временно недоступен. Запись не подтверждена.');}
    finally{btn.disabled=false;widget.reset();}
  });}
  async function start(){let cfg;try{const controller=new AbortController();const t=setTimeout(()=>controller.abort(),6000);let response;try{response=await fetch(api+'/health',{signal:controller.signal,cache:'no-store'});}finally{clearTimeout(t);}if(!response.ok)throw Error('No Worker route');cfg=await response.json();}catch{show('r2-service-status','Онлайн-формы ещё не подключены. Для делового обращения можно открыть почтовое приложение.');return;}
    if(!cfg?.turnstileSiteKey || !/^[\w-]{3,100}$/.test(cfg.turnstileSiteKey)){show('r2-service-status','Не завершена настройка защищённой отправки.');return;}
    if(!cfg.leadsEnabled&&!cfg.subscriptionEnabled){show('r2-service-status','Сервис пока не настроен.');return;}
    state.siteKey=cfg.turnstileSiteKey;
    try{await loadTurnstile();if(cfg.leadsEnabled){const widget=await fillTurnstile('#r2-lead-challenge','lead');lead.hidden=false;await submitForm(lead,'lead',widget,'r2-lead-response');}
      if(cfg.subscriptionEnabled){const widget=await fillTurnstile('#r2-subscribe-challenge','subscribe');subscription.hidden=false;await submitForm(subscription,'subscribe',widget,'r2-subscribe-response');}
      show('r2-service-status','Защищённые формы подключены. Отправка подтверждается ответом сервера.');}
    catch{lead.hidden=true;subscription.hidden=true;show('r2-service-status','Проверка защиты недоступна. Используйте письмо для деловых запросов.');}
  }
  start();
})();
