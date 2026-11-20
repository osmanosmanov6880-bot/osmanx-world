/** R4 encrypted, private R2 editorial backups and controlled rollback of previously published public snapshots.
 * Leads, subscriptions, tokens and API secrets NEVER enter this backup. */
import {validateDraft} from './editorial.mjs';
import {checkStreamReady,exposeStream} from './media.mjs';
const reply=(x,status=200)=>new Response(JSON.stringify(x),{status,headers:{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});
const uuid=/^[0-9a-f-]{36}$/;
const now=()=>new Date().toISOString();
async function body(req){if(!req.headers.get('content-type')?.startsWith('application/json'))return null;const raw=await req.text();if(raw.length>4000)return null;try{const x=JSON.parse(raw);return x&&typeof x==='object'&&!Array.isArray(x)?x:null;}catch{return null;}}
const text=s=>typeof s==='string'&&s.length>=12&&s.length<=240&&!/[<>\u0000-\u001f]/.test(s);
async function key(env){if(!env.EDITORIAL_BACKUP_KEY||!env.BACKUP_BUCKET)return null;try{const bytes=Uint8Array.from(atob(env.EDITORIAL_BACKUP_KEY),c=>c.charCodeAt(0));if(bytes.length!==32)return null;return crypto.subtle.importKey('raw',bytes,{name:'AES-GCM'},false,['encrypt','decrypt']);}catch{return null;}}
const aad=new TextEncoder().encode('OSMANX-EDITORIAL-BACKUP-V1');
async function encrypt(payload,cryptoKey){const nonce=crypto.getRandomValues(new Uint8Array(12));const data=new TextEncoder().encode(JSON.stringify(payload));const result=await crypto.subtle.encrypt({name:'AES-GCM',iv:nonce,additionalData:aad},cryptoKey,data);return new Uint8Array([...nonce,...new Uint8Array(result)]);}
async function decrypt(bytes,cryptoKey){if(bytes.length<30||bytes.length>150000)throw Error('Invalid snapshot size');const payload=await crypto.subtle.decrypt({name:'AES-GCM',iv:bytes.subarray(0,12),additionalData:aad},cryptoKey,bytes.subarray(12));const object=JSON.parse(new TextDecoder().decode(payload));if(object?.schemaVersion!==1||validateDraft(object.draft).length||!Number.isSafeInteger(object.draftRevision))throw Error('Invalid backup schema');return object;}
async function audit(db,event,actor){await db.prepare('INSERT INTO operator_audit(id,event,actor,subject_id,at) VALUES (?,?,?,?,?)').bind(crypto.randomUUID(),event,actor,null,now()).run();}
async function latest(db){const row=await db.prepare('SELECT revision,document_json,updated_by FROM editorial_draft WHERE slot=1').first();const live=await db.prepare('SELECT version FROM editorial_live WHERE slot=1').first();return {draftRevision:row?.revision||0,document:row?.document_json?JSON.parse(row.document_json):null,liveVersion:live?.version||0};}
export async function recoveryRoute(req,env,actor,rest,fetcher=fetch){
 if(!rest.startsWith('/backups')&&!rest.startsWith('/versions'))return null;
 if(!actor?.approver)return reply({ok:false,error:'Требуется роль утверждающего.'},403);
 const db=env.DB;
 if(rest==='/versions'&&req.method==='GET'){
  const rows=(await db.prepare('SELECT version,reviewed_by,reviewed_at FROM editorial_versions ORDER BY version DESC LIMIT 40').all()).results||[];
  return reply({ok:true,versions:rows});
 }
 const rollback=/^\/versions\/(\d+)\/rollback$/.exec(rest);
 if(rollback&&req.method==='POST'){
  const version=Number(rollback[1]),b=await body(req),cur=await db.prepare('SELECT version FROM editorial_live WHERE slot=1').first(),target=await db.prepare('SELECT public_json,reviewed_by FROM editorial_versions WHERE version=?').bind(version).first();
  if(!b||b.confirm!=='ROLLBACK_PUBLIC_RELEASE'||!text(b.reason)||!Number.isSafeInteger(b.expectedLiveVersion)||b.expectedLiveVersion!==(cur?.version||0)||!target||!cur||version===cur.version)return reply({ok:false,error:'Неверная версия или требуемое подтверждение.'},409);
  if(env.REQUIRE_TWO_PERSON_REVIEW==='true'&&target.reviewed_by===actor.email)return reply({ok:false,error:'Необходим другой утверждающий.'},403);
  let publicDoc;try{publicDoc=JSON.parse(target.public_json);}catch{return reply({ok:false,error:'Повреждённая история версии.'},422);}
  if(publicDoc.status!=='published'||!Array.isArray(publicDoc.episodes))return reply({ok:false,error:'Недопустимая архивная версия.'},422);
  for(const ep of publicDoc.episodes){
   if(ep.videoUrl?.startsWith('stream:')){
    const uid=ep.videoUrl.slice(7);const row=await db.prepare("SELECT review_status FROM media_assets WHERE stream_uid=?").bind(uid).first();if(row?.review_status!=='approved'||!await checkStreamReady(env,fetcher,uid))return reply({ok:false,error:'Права или готовность архивного видео не подтверждены.'},422);
   }else if(ep.videoUrl?.startsWith('/assets/')){
    let r;try{r=await fetcher(new URL(req.url).origin+ep.videoUrl,{method:'HEAD',redirect:'manual'});}catch{}if(!r?.ok||!/^video\/(mp4|webm)/.test(r.headers.get('content-type')||''))return reply({ok:false,error:'Видео архивной версии недоступно.'},422);
   }else return reply({ok:false,error:'Некорректный источник старого выпуска.'},422);
  }
  const previousSchedule=(await db.prepare('SELECT day,status FROM episode_calendar').all()).results||[];const calendar=new Map(previousSchedule.map(x=>[x.day,x.status]));
  for(const ep of publicDoc.episodes.filter(e=>e.videoUrl?.startsWith('stream:'))){if(calendar.has(ep.day)&&calendar.get(ep.day)!=='released')continue;if(!await exposeStream(env,fetcher,ep.videoUrl.slice(7),true))return reply({ok:false,error:'Не удалось открыть видео архивного выпуска.'},502);}
  const newVersion=cur.version+1,stamp=now();const pub={...publicDoc,version:newVersion,reviewedAt:stamp};
  const previous=await db.prepare('SELECT public_json FROM editorial_live WHERE slot=1').first();
  await db.batch([
   db.prepare('UPDATE editorial_live SET version=?,public_json=?,reviewed_by=?,reviewed_at=? WHERE slot=1 AND version=?').bind(newVersion,JSON.stringify(pub),actor.email,stamp,cur.version),
   db.prepare('INSERT INTO editorial_versions(version,public_json,reviewed_by,reviewed_at) VALUES (?,?,?,?)').bind(newVersion,JSON.stringify(pub),actor.email,stamp),
   db.prepare('INSERT INTO editorial_audit(id,action,actor,revision,at) VALUES (?,?,?,?,?)').bind(crypto.randomUUID(),'rollback_from_'+version,actor.email,null,stamp),
   db.prepare('INSERT INTO editorial_restore_notes(id,source_version,restored_version,actor,reason,at) VALUES (?,?,?,?,?,?)').bind(crypto.randomUUID(),version,newVersion,actor.email,b.reason,stamp)
  ]);
  let oldReleased=[];try{oldReleased=JSON.parse(previous.public_json).episodes||[];}catch{}
  const keep=new Set(publicDoc.episodes.filter(e=>e.videoUrl?.startsWith('stream:')).map(e=>e.videoUrl.slice(7)));
  let oldStreamRevoked=true;for(const ep of oldReleased){if(ep.videoUrl?.startsWith('stream:')&&!keep.has(ep.videoUrl.slice(7)))if(!await exposeStream(env,fetcher,ep.videoUrl.slice(7),false))oldStreamRevoked=false;}
  return reply({ok:true,newVersion,restoredFrom:version,oldStreamRevoked},oldStreamRevoked?200:207);
 }
 const cryptoKey=await key(env);if(!cryptoKey)return reply({ok:false,error:'Приватные шифрованные копии не настроены.'},503);
 if(rest==='/backups'&&req.method==='GET'){
  const list=await env.BACKUP_BUCKET.list({prefix:'moscow1000/editorial/',limit:50});return reply({ok:true,backups:(list.objects||[]).map(o=>({id:o.key.split('/').at(-1).replace(/\.bin$/,''),createdAt:o.uploaded?.toISOString?.()||null,size:o.size}))});
 }
 if(rest==='/backups'&&req.method==='POST'){
  const s=await latest(db);if(!s.document)return reply({ok:false,error:'Редакторский черновик ещё не существует.'},409);
  if(validateDraft(s.document).length)return reply({ok:false,error:'Черновик невалиден.'},422);
  const id=crypto.randomUUID(),payload={schemaVersion:1,createdAt:now(),draftRevision:s.draftRevision,liveVersion:s.liveVersion,draft:s.document};
  const encrypted=await encrypt(payload,cryptoKey);await env.BACKUP_BUCKET.put('moscow1000/editorial/'+id+'.bin',encrypted,{httpMetadata:{contentType:'application/octet-stream'}});
  await audit(db,'encrypted_editorial_backup',actor.email);return reply({ok:true,id,size:encrypted.length,includesPersonalContacts:false},201);
 }
 const m=/^\/backups\/([a-f0-9-]{36})\/(preview|restore)$/.exec(rest);if(!m||!uuid.test(m[1]))return reply({ok:false,error:'Маршрут не найден.'},404);
 const item=await env.BACKUP_BUCKET.get('moscow1000/editorial/'+m[1]+'.bin');if(!item)return reply({ok:false,error:'Архив не найден.'},404);
 let snapshot;try{snapshot=await decrypt(new Uint8Array(await item.arrayBuffer()),cryptoKey);}catch{return reply({ok:false,error:'Архив повреждён либо ключ не совпадает.'},422);}
 if(m[2]==='preview'&&req.method==='GET')return reply({ok:true,id:m[1],createdAt:snapshot.createdAt,draftRevision:snapshot.draftRevision,liveVersionAtBackup:snapshot.liveVersion,days:snapshot.draft.days.length,markers:snapshot.draft.markers.length,episodes:snapshot.draft.episodes.length,includesPersonalContacts:false});
 if(m[2]==='restore'&&req.method==='POST'){
  const b=await body(req);const current=await latest(db);
  if(!b||b.confirm!=='RESTORE_EDITORIAL_DRAFT'||!Number.isSafeInteger(b.expectedRevision)||b.expectedRevision!==current.draftRevision||!Number.isSafeInteger(b.expectedLiveVersion)||b.expectedLiveVersion!==current.liveVersion)return reply({ok:false,error:'Конфликт текущего состояния или не подтверждено восстановление.'},409);
  const revision=current.draftRevision+1,stamp=now();await db.batch([
   db.prepare('INSERT INTO editorial_draft(slot,revision,document_json,updated_by,updated_at) VALUES(1,?,?,?,?) ON CONFLICT(slot) DO UPDATE SET revision=excluded.revision,document_json=excluded.document_json,updated_by=excluded.updated_by,updated_at=excluded.updated_at').bind(revision,JSON.stringify(snapshot.draft),actor.email,stamp),
   db.prepare('INSERT INTO editorial_audit(id,action,actor,revision,at) VALUES(?,?,?,?,?)').bind(crypto.randomUUID(),'restored_encrypted_draft',actor.email,revision,stamp)
  ]);return reply({ok:true,revision,publishedUnchanged:true});
 }
 return reply({ok:false,error:'Недопустимый метод.'},405);
}
