import {verifiedActor} from './access.mjs';
import {adminRoute} from './admin.mjs';
import {unpublished} from './editorial.mjs';
import {verifiedOptOut,sendDigestBatch} from './digest.mjs';
/** OSMANX 1000 DOORS R2 intake API. Deploy as a dedicated Cloudflare Worker route only after configuring D1, Turnstile and verified email. */
const ROOT='/moscow-1000/api';
const siteOrigin=env=>{const value=String(env.SITE_ORIGIN||'https://osmanx.world').replace(/\/$/,'');try{const url=new URL(value);return url.protocol==='https:'&&(/^osmanx\.world$/.test(url.hostname)||/^[a-z0-9-]+\.osmanx\.world$/.test(url.hostname))&&url.origin===value?url.origin:null;}catch{return null;}};
const types=new Set(['business','partner','research']);
const headers={'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer'};
const reply=(obj,status=200)=>new Response(JSON.stringify(obj),{status,headers});
const scrub=x=>typeof x==='string'?x.trim():'';
const validEmail=x=>typeof x==='string'&&x.length<=254&&/^[^\s@<>]{1,64}@[^\s@<>]+\.[^\s@<>]{2,}$/.test(x);
const safe=x=>typeof x==='string'&&!/[\u0000-\u001f\u007f]/.test(x);
const esc=x=>String(x).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const b64=bytes=>Array.from(bytes).map(b=>b.toString(16).padStart(2,'0')).join('');
const token=()=>b64(crypto.getRandomValues(new Uint8Array(32)));
async function hash(value){const buf=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value));return b64(new Uint8Array(buf));}
function config(env){const base=!!(env.DB&&env.TURNSTILE_SECRET&&env.TURNSTILE_SITE_KEY&&env.RESEND_API_KEY&&env.EMAIL_FROM);return {leads:base&&!!env.NOTIFY_EMAIL,subscription:base,turnstileSiteKey:base?env.TURNSTILE_SITE_KEY:null};}
async function readiness(env){
  const c=config(env);
  if(c.leads){try{await env.DB.prepare('SELECT 1 FROM leads LIMIT 1').bind().first();}catch{c.leads=false;}}
  if(c.subscription){try{await env.DB.prepare('SELECT 1 FROM subscriptions LIMIT 1').bind().first();}catch{c.subscription=false;}}
  if(!c.leads&&!c.subscription)c.turnstileSiteKey=null;
  return c;
}
function methodAllowed(req, origin){const supplied=req.headers.get('Origin');return supplied===origin;}
async function parse(req){if(!req.headers.get('content-type')?.startsWith('application/json'))return null;const len=Number(req.headers.get('content-length')||0);if(len>8192)return null;try{const text=await req.text();if(text.length>8192)return null;const parsed=JSON.parse(text);return parsed&&typeof parsed==='object'&&!Array.isArray(parsed)?parsed:null;}catch{return null;}}
async function verifyChallenge(fetcher,env,value,action){if(typeof value!=='string'||value.length<4||value.length>2048)return false;try{const body=new FormData();body.append('secret',env.TURNSTILE_SECRET);body.append('response',value);const response=await fetcher('https://challenges.cloudflare.com/turnstile/v0/siteverify',{method:'POST',body});if(!response.ok)return false;const data=await response.json();return data.success===true&&data.action===action&&(!data.hostname||data.hostname===new URL(siteOrigin(env)).hostname);}catch{return false;}}
async function sendMail(fetcher,env,to,subject,html){const r=await fetcher('https://api.resend.com/emails',{method:'POST',headers:{Authorization:'Bearer '+env.RESEND_API_KEY,'Content-Type':'application/json'},body:JSON.stringify({from:env.EMAIL_FROM,to:[to],subject,html})});return r.ok;}
const frame=body=>`<!doctype html><html lang="ru"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>OSMANX — подтверждение</title><style>body{background:#070d19;color:#f6f8fe;font:16px/1.6 system-ui;max-width:600px;margin:8vh auto;padding:25px}h1{font-size:32px}button{padding:13px 20px;background:#db3156;border:0;color:white;cursor:pointer}a{color:#f8a2b7}p{color:#b0c1d5}</style><main>${body}</main></html>`;
const html=(body,status=200)=>new Response(frame(body),{status,headers:{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer','Content-Security-Policy':"default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'"}});
function tokenPage(operation,req){const url=new URL(req.url);const raw=url.searchParams.get('token')||'';if(!(/^[0-9a-f]{64}$/.test(raw)||(operation==='unsubscribe'&&/^v2_[0-9a-f]{64}_[0-9a-f]{64}$/.test(raw))))return html('<h1>Ссылка недействительна</h1><p>Проверьте письмо.</p>',400);const title=operation==='confirm'?'Подтвердить подписку':'Отписаться от уведомлений';return html(`<h1>${title}</h1><p>Вы управляете получением писем OSMANX. Изменение произойдёт только после нажатия кнопки.</p><form method="post" action="${ROOT}/${operation}"><input type="hidden" name="token" value="${raw}"><button type="submit">${title}</button></form><p><a href="/moscow-1000/">Вернуться к сериалу</a></p>`);}
async function writeLead(req,env,fetcher,conf){if(!conf.leads)return reply({ok:false,error:'Форма ещё не подключена.'},503);const body=await parse(req);if(!body)return reply({ok:false,error:'Некорректный формат сообщения.'},400);if(body.honeypot)return reply({ok:false,error:'Не удалось отправить обращение.'},400);
  const email=scrub(body.email).toLowerCase(),name=scrub(body.name),company=scrub(body.company),message=scrub(body.message);
  if(!types.has(body.kind)||!validEmail(email)||name.length>80||company.length>120||message.length<20||message.length>1500||!safe(name)||!safe(company)||!safe(message)||body.consent!==true)return reply({ok:false,error:'Проверьте поля и согласие на обработку данных.'},400);
  if(!await verifyChallenge(fetcher,env,body.turnstileToken,'lead'))return reply({ok:false,error:'Не пройдена проверка защиты формы. Повторите попытку.'},403);
  const id=crypto.randomUUID();await env.DB.prepare('INSERT INTO leads (id,kind,email,name,company,message,consent_at,created_at) VALUES (?,?,?,?,?,?,?,?)').bind(id,body.kind,email,name,company,message,new Date().toISOString(),new Date().toISOString()).run();
  let notification=false;try{notification=await sendMail(fetcher,env,env.NOTIFY_EMAIL,'OSMANX MOSCOW 1000 — новое обращение',`<h1>Новое обращение OSMANX</h1><p>ID: ${esc(id)}</p><p>Тип: ${esc(body.kind)}</p><p>Имя: ${esc(name)}</p><p>Компания: ${esc(company)}</p><p>Email: ${esc(email)}</p><p>Сообщение:</p><pre style="white-space:pre-wrap">${esc(message)}</pre>`);}catch{};
  return reply({ok:true,id,delivery:notification?'stored_and_notified':'stored_notification_pending',message:notification?'Обращение получено.':'Обращение сохранено, уведомление оператору задерживается.'},202);
}
async function writeSubscriber(req,env,fetcher,conf){if(!conf.subscription)return reply({ok:false,error:'Подписка ещё не подключена.'},503);const body=await parse(req);if(!body)return reply({ok:false,error:'Некорректный формат.'},400);const email=scrub(body.email).toLowerCase();if(!validEmail(email)||body.consent!==true||body.honeypot)return reply({ok:false,error:'Проверьте email и согласие.'},400);if(!await verifyChallenge(fetcher,env,body.turnstileToken,'subscribe'))return reply({ok:false,error:'Проверка защиты не пройдена.'},403);
  const emailHash=await hash(email);const existing=await env.DB.prepare('SELECT status FROM subscriptions WHERE email_hash = ?').bind(emailHash).first();if(existing?.status==='subscribed')return reply({ok:true,message:'Если этот адрес существует, подписка уже активна.'},202);
  const confirmation=token(),unsub=token(),confirmHash=await hash(confirmation),unsubHash=await hash(unsub);const stamp=new Date().toISOString();
  await env.DB.prepare("INSERT INTO subscriptions (email_hash,email,confirm_hash,unsub_hash,status,consent_at,created_at) VALUES (?,?,?,?,?,?,?) ON CONFLICT(email_hash) DO UPDATE SET confirm_hash=excluded.confirm_hash,unsub_hash=excluded.unsub_hash,status='pending',consent_at=excluded.consent_at").bind(emailHash,email,confirmHash,unsubHash,'pending',stamp,stamp).run();
  const link=siteOrigin(env)+ROOT+'/confirm?token='+confirmation;let sent=false;
  try{sent=await sendMail(fetcher,env,email,'Подтверждение подписки OSMANX',`<p>Чтобы получать уведомления о новых эпизодах, подтвердите адрес:</p><p><a href="${link}">Подтвердить подписку</a></p><p>Если не запрашивали подписку, проигнорируйте письмо.</p>`);}catch{}
  if(!sent)return reply({ok:false,error:'Не удалось отправить подтверждающее письмо. Подписка не активирована.'},503);
  return reply({ok:true,message:'Письмо для подтверждения отправлено. Подписка пока не активна.'},202);
}
async function confirmAction(req,env,operation){if(!env.DB)return html('<h1>Сервис недоступен</h1>',503);const contentType=req.headers.get('content-type')||'';if(!contentType.includes('application/x-www-form-urlencoded'))return html('<h1>Неверный запрос</h1>',400);const text=await req.text();if(text.length>256)return html('<h1>Неверный запрос</h1>',400);const raw=new URLSearchParams(text).get('token')||'';if(!(/^[0-9a-f]{64}$/.test(raw)||(operation==='unsubscribe'&&/^v2_[0-9a-f]{64}_[0-9a-f]{64}$/.test(raw))))return html('<h1>Неверная ссылка</h1>',400);const digest=/^[0-9a-f]{64}$/.test(raw)?await hash(raw):null;if(operation==='confirm'){
  const result=await env.DB.prepare("UPDATE subscriptions SET status='subscribed',confirmed_at=? WHERE confirm_hash=? AND status='pending'").bind(new Date().toISOString(),digest).run();return html(result?.meta?.changes?'<h1>Подписка подтверждена</h1><p>Вы сможете отказаться от писем по ссылке в каждом выпуске.</p>':'<h1>Ссылка недействительна или уже использована</h1>',result?.meta?.changes?200:404);
}const emailHash=raw.startsWith('v2_')?await verifiedOptOut(env,raw):null;if(raw.startsWith('v2_')&&!emailHash)return html('<h1>Ссылка недействительна</h1>',400);const res=raw.startsWith('v2_')?await env.DB.prepare("UPDATE subscriptions SET status='unsubscribed' WHERE email_hash=? AND status='subscribed'").bind(emailHash).run():await env.DB.prepare("UPDATE subscriptions SET status='unsubscribed' WHERE unsub_hash=? AND status='subscribed'").bind(digest).run();return html(res?.meta?.changes?'<h1>Вы отписаны</h1><p>Новых уведомлений не будет.</p>':'<h1>Подписка не найдена</h1>',res?.meta?.changes?200:404);}
export default {
  async fetch(req,env){try{const url=new URL(req.url);if(!siteOrigin(env)||url.origin!==siteOrigin(env))return reply({ok:false,error:'Unknown host'},404);const path=url.pathname;const conf=await readiness(env);if(req.method==='GET'&&path===ROOT+'/health')return reply({ok:true,leadsEnabled:conf.leads,subscriptionEnabled:conf.subscription,turnstileSiteKey:conf.turnstileSiteKey});
    if(req.method==='GET'&&path===ROOT+'/public-release'){let published=unpublished();try{if(env.DB){const row=await env.DB.prepare('SELECT public_json FROM editorial_live WHERE slot=1').first();if(row?.public_json)published=JSON.parse(row.public_json);}}catch{}return new Response(JSON.stringify(published),{status:200,headers:{'Content-Type':'application/json; charset=utf-8','Cache-Control':'public, max-age=45, stale-while-revalidate=90','X-Content-Type-Options':'nosniff'}});}
    if(path.startsWith(ROOT+'/admin/')){const actor=await verifiedActor(req,env,fetch);if(!actor)return reply({ok:false,error:'Доступ разрешён только проверенным сотрудникам.'},403);return adminRoute(req,env,actor,fetch);}
    if(req.method==='GET'&&(path===ROOT+'/confirm'||path===ROOT+'/unsubscribe'))return tokenPage(path.endsWith('/confirm')?'confirm':'unsubscribe',req);
    if(req.method==='POST'&&(path===ROOT+'/confirm'||path===ROOT+'/unsubscribe'))return confirmAction(req,env,path.endsWith('/confirm')?'confirm':'unsubscribe');
    if(req.method!=='POST'||!['/leads','/subscribe'].some(p=>path===ROOT+p))return reply({ok:false,error:'Not found'},404);
    if(!methodAllowed(req,url.origin))return reply({ok:false,error:'Origin not allowed'},403);
    if(path===ROOT+'/leads')return await writeLead(req,env,fetch,conf);
    return await writeSubscriber(req,env,fetch,conf);
  }catch{return reply({ok:false,error:'Временная ошибка сервера. Попробуйте позже.'},500);}},
  async scheduled(event,env){if(!env.DB)return;
    if(event?.cron==='0 3 * * *'){try{await env.DB.prepare("DELETE FROM lead_reviews WHERE lead_id IN (SELECT id FROM leads WHERE created_at < datetime('now','-180 days'))").run();}catch{}await env.DB.prepare("DELETE FROM leads WHERE created_at < datetime('now','-180 days')").run();await env.DB.prepare("DELETE FROM subscriptions WHERE status <> 'subscribed' AND created_at < datetime('now','-30 days')").run();}
    if(event?.cron==='*/5 * * * *'&&env.DIGEST_DELIVERY_ENABLED==='true'){try{await sendDigestBatch(env,fetch,{batchSize:10});}catch{}}
  }
};
export const helpers={config,validEmail,verifyChallenge,hash,token,parse};
