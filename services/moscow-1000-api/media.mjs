/** R4 private video ingestion: creator-upload URL -> encoding -> independent rights review -> explicit editorial approval. */
const prefix='/media', now=()=>new Date().toISOString();
const head={'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'};
const reply=(o,status=200)=>new Response(JSON.stringify(o),{status,headers:head});
const goodText=(v,n)=>typeof v==='string'&&v.trim().length>0&&v.length<=n&&!/[<>\u0000-\u001f\u007f]/.test(v);
const uid=x=>typeof x==='string'&&/^[a-f0-9]{32}$/i.test(x);
const id=x=>typeof x==='string'&&/^[a-f0-9-]{36}$/i.test(x);
const ref=x=>typeof x==='string'&&/^[A-Za-z0-9_-]{6,80}$/.test(x);
export const streamConfigured=env=>!!(env.STREAM_ACCOUNT_ID&&/^[a-f0-9]{32}$/i.test(env.STREAM_ACCOUNT_ID)&&env.STREAM_API_TOKEN&&env.STREAM_CUSTOMER_CODE&&/^[a-z0-9]{6,40}$/i.test(env.STREAM_CUSTOMER_CODE));
const streamApi=(env,path)=>`https://api.cloudflare.com/client/v4/accounts/${env.STREAM_ACCOUNT_ID}/stream${path}`;
async function cf(env,fetcher,path,opt={}){const r=await fetcher(streamApi(env,path),{...opt,headers:{Authorization:'Bearer '+env.STREAM_API_TOKEN,...opt.headers}});if(!r.ok)throw Error('Stream HTTP '+r.status);const data=await r.json();if(!data?.success)throw Error('Stream rejected request');return data.result;}
async function body(req,max=70000){if(!req.headers.get('content-type')?.startsWith('application/json')||Number(req.headers.get('content-length')||0)>max)return null;const raw=await req.text();if(raw.length>max)return null;try{const json=JSON.parse(raw);return json&&typeof json==='object'&&!Array.isArray(json)?json:null;}catch{return null;}}
const expect=(actor,key)=>actor?.[key]===true;
const failure=()=>reply({ok:false,error:'Недостаточно полномочий.'},403);
const unavailable=()=>reply({ok:false,error:'Cloudflare Stream не подключён в окружении.'},503);
const origins=env=>[new URL(env.SITE_ORIGIN||'https://osmanx.world').hostname];
export async function checkStreamReady(env,fetcher,streamUid){if(!streamConfigured(env)||!uid(streamUid))return false;try{const v=await cf(env,fetcher,'/'+streamUid);return v.uid===streamUid&&v.readyToStream===true&&v.status?.state==='ready';}catch{return false;}}
export async function exposeStream(env,fetcher,streamUid,publicFlag){if(!streamConfigured(env)||!uid(streamUid))return false;try{const result=await cf(env,fetcher,'/'+streamUid,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({requireSignedURLs:!publicFlag,allowedOrigins:origins(env)})});return result?.requireSignedURLs===!publicFlag;}catch{return false;}}
export async function mediaRoute(req,env,actor,rest,fetcher=fetch){
 if(!rest.startsWith(prefix))return null;
 if(!env.DB)return reply({ok:false,error:'D1 не подключена.'},503);
 if(rest===prefix&&req.method==='GET'){
  if(!expect(actor,'editor')&&!expect(actor,'approver'))return failure();
  const rows=(await env.DB.prepare('SELECT id,day,title,file_name,stream_uid,state,review_status,rights_ref,created_at,checked_at,approved_at,caption_lang,chapters_json FROM media_assets ORDER BY created_at DESC LIMIT 50').all()).results||[];
  return reply({ok:true,configured:streamConfigured(env),uploadEnabled:env.STREAM_UPLOAD_ENABLED==='true',media:rows.map(x=>({...x,chapters:JSON.parse(x.chapters_json||'[]')}))});
 }
 if(rest===prefix+'/upload'&&req.method==='POST'){
  if(!expect(actor,'editor'))return failure();
  if(!streamConfigured(env)||env.STREAM_UPLOAD_ENABLED!=='true')return unavailable();
  const x=await body(req);
  if(!x||!Number.isInteger(x.day)||x.day<1||x.day>10||!goodText(x.title,120)||!goodText(x.fileName,120)||!/^[-\w .()]+\.(mp4|webm)$/i.test(x.fileName)||!Number.isSafeInteger(x.sizeBytes)||x.sizeBytes<=0||x.sizeBytes>200000000||!Number.isInteger(x.maxDurationSeconds)||x.maxDurationSeconds<1||x.maxDurationSeconds>3600)return reply({ok:false,error:'Только MP4/WebM до 200 MB, длительность до 60 минут и корректные поля.'},400);
  let result;try{result=await cf(env,fetcher,'/direct_upload',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({maxDurationSeconds:x.maxDurationSeconds,allowedOrigins:origins(env),requireSignedURLs:true,expiry:new Date(Date.now()+30*60_000).toISOString(),meta:{name:x.fileName}})});}catch{return reply({ok:false,error:'Не удалось получить адрес загрузки Stream.'},502);}
  if(!uid(result?.uid)||typeof result.uploadURL!=='string'||!/^https:\/\/upload\.videodelivery\.net\//.test(result.uploadURL))return reply({ok:false,error:'Stream вернул некорректный адрес.'},502);
  const id=crypto.randomUUID(),date=now();await env.DB.prepare('INSERT INTO media_assets(id,day,title,file_name,stream_uid,state,review_status,created_by,created_at,chapters_json) VALUES (?,?,?,?,?,?,?,?,?,?)').bind(id,x.day,x.title.trim(),x.fileName,result.uid,'pendingupload','pending',actor.email,date,'[]').run();
  return reply({ok:true,id,uploadURL:result.uploadURL,streamUid:result.uid,state:'pendingupload',expiresInSeconds:1800},201);
 }
 const match=/^\/media\/([a-f0-9-]{36})\/(sync|approve|captions|chapters)$/.exec(rest);if(!match)return null;
 const [,mediaId,op]=match;if(!id(mediaId))return reply({ok:false,error:'Некорректный ID.'},400);
 const m=await env.DB.prepare('SELECT * FROM media_assets WHERE id=?').bind(mediaId).first();if(!m)return reply({ok:false,error:'Медиа не найдено.'},404);
 if(op==='sync'&&req.method==='POST'){
  if(!expect(actor,'editor')&&!expect(actor,'approver'))return failure();if(!streamConfigured(env))return unavailable();
  let v;try{v=await cf(env,fetcher,'/'+m.stream_uid);}catch{return reply({ok:false,error:'Stream недоступен для проверки.'},502);}
  const state=v?.readyToStream===true&&v.status?.state==='ready'?'ready':v.status?.state==='error'?'error':'processing';
  await env.DB.prepare('UPDATE media_assets SET state=?,checked_at=? WHERE id=?').bind(state,now(),mediaId).run();return reply({ok:true,state,ready:state==='ready'});
 }
 if(op==='approve'&&req.method==='POST'){
  if(!expect(actor,'approver'))return failure();const x=await body(req);
  if(!x||!ref(x.rightsRef)||x.peopleCleared!==true||x.musicCleared!==true||x.editorialContextConfirmed!==true||m.state!=='ready')return reply({ok:false,error:'Требуются готовое видео, доказательство прав и проверка согласий/музыки.'},422);
  if(env.REQUIRE_TWO_PERSON_REVIEW==='true'&&m.created_by===actor.email)return failure();
  if(!await checkStreamReady(env,fetcher,m.stream_uid))return reply({ok:false,error:'Cloudflare Stream ещё не подтвердил готовность.'},422);
  await env.DB.prepare("UPDATE media_assets SET review_status='approved',rights_ref=?,approved_by=?,approved_at=? WHERE id=? AND state='ready'").bind(x.rightsRef,actor.email,now(),mediaId).run();
  return reply({ok:true,review:'approved',streamReference:'stream:'+m.stream_uid});
 }
 if(op==='captions'&&req.method==='POST'){
  if(!expect(actor,'editor'))return failure();if(!streamConfigured(env))return unavailable();const x=await body(req,68000);
  if(!x||!['ru','en'].includes(x.language)||typeof x.vtt!=='string'||x.vtt.length>60000||!/^WEBVTT(?:\s|\r?\n)/.test(x.vtt)||!/\d\d:\d\d:\d\d\.\d{3}\s+-->\s+\d\d:\d\d:\d\d\.\d{3}/.test(x.vtt)||x.vtt.includes('<'))return reply({ok:false,error:'Ожидается корректный безопасный WebVTT до 60KB.'},422);
  const form=new FormData();form.append('file',new Blob([x.vtt],{type:'text/vtt'}),'subtitles.vtt');
  try{await cf(env,fetcher,`/${m.stream_uid}/captions/${x.language}`,{method:'PUT',body:form});}catch{return reply({ok:false,error:'Не удалось загрузить субтитры в Stream.'},502);}
  await env.DB.prepare('UPDATE media_assets SET caption_lang=? WHERE id=?').bind(x.language,mediaId).run();return reply({ok:true,caption:x.language});
 }
 if(op==='chapters'&&req.method==='POST'){
  if(!expect(actor,'editor'))return failure();const x=await body(req);
  if(!x||!Array.isArray(x.chapters)||x.chapters.length>25||x.chapters.some(c=>!Number.isFinite(c.second)||c.second<0||c.second>36000||!goodText(c.title,90))||x.chapters.some((c,i)=>i&&c.second<=x.chapters[i-1].second))return reply({ok:false,error:'Главы должны иметь уникальные возрастающие таймкоды и названия.'},422);
  await env.DB.prepare('UPDATE media_assets SET chapters_json=? WHERE id=?').bind(JSON.stringify(x.chapters),mediaId).run();return reply({ok:true,chapters:x.chapters});
 }
 return reply({ok:false,error:'Недопустимый метод.'},405);
}
export function streamFrame(env,streamUid){if(!streamConfigured(env)||!uid(streamUid))return null;return `https://customer-${env.STREAM_CUSTOMER_CODE}.cloudflarestream.com/${streamUid}/iframe`;}
