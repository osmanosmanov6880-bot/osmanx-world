/* Source-backed R36 OmniChat page: no fabricated provider state. */
(()=>{'use strict';
const btn=document.getElementById('check-connection'),indicator=document.getElementById('connection-status'),label=document.getElementById('connection-text'),live=document.getElementById('open-live');
if(!btn||!indicator||!label||!live)return;
function setStatus(text,ok){label.textContent=text;indicator.classList.toggle('ok',Boolean(ok));live.hidden=!ok;live.setAttribute('aria-disabled',String(!ok));}
btn.addEventListener('click',async()=>{btn.disabled=true;setStatus('Проверяю HTTPS и доступность базы...',false);
const ctl=new AbortController(),timer=setTimeout(()=>ctl.abort(),6500);
try{const res=await fetch('https://chat.osmanx.world/api/health/ready',{method:'GET',cache:'no-store',credentials:'omit',mode:'cors',redirect:'error',signal:ctl.signal});
if(!res.ok||!(res.headers.get('content-type')||'').includes('application/json'))throw Error('unavailable');
const data=await res.json();if(data?.status!=='ready'||data?.database!=='ok')throw Error('not-ready');
setStatus('API и база отвечают; перед работой проверьте права и авторизацию.',true);
}catch(_){setStatus('Публичный сервер не подтверждён. Демо доступно выше.',false)}
finally{clearTimeout(timer);btn.disabled=false}
});
})();