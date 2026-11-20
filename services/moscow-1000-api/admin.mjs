/** Protected operator routes. Caller MUST cryptographically verify Cloudflare Access JWT. */
import {emptyDraft,validateDraft,buildPublicRelease,unpublished} from './editorial.mjs';
import {sendDigestBatch} from './digest.mjs';
import {mediaRoute,checkStreamReady,exposeStream,streamFrame} from './media.mjs';
import {recoveryRoute} from './recovery.mjs';
import {calendarRoute,visibleRelease} from './calendar.mjs';
const base='/moscow-1000/api/admin';
const headers={'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer'};
const reply=(data,status=200)=>new Response(JSON.stringify(data),{status,headers});
const now=()=>new Date().toISOString();
const eventId=()=>crypto.randomUUID();
const isObject=o=>o&&typeof o==='object'&&!Array.isArray(o);
async function jsonBody(req){
  if(!req.headers.get('content-type')?.startsWith('application/json')||Number(req.headers.get('content-length')||0)>35000)return null;
  const text=await req.text();if(text.length>35000)return null;
  try{const obj=JSON.parse(text);return isObject(obj)?obj:null;}catch{return null;}
}
const permission=(actor,role)=>role==='editor'?actor.editor:role==='approver'?actor.approver:actor.moderator;
const unauthorized=()=>reply({ok:false,error:'Недостаточно полномочий.'},403);
async function latestDraft(db){const row=await db.prepare('SELECT revision,document_json,updated_by,updated_at FROM editorial_draft WHERE slot=1').first();return row?{revision:row.revision,document:JSON.parse(row.document_json),updatedBy:row.updated_by,updatedAt:row.updated_at}:{revision:0,document:emptyDraft(),updatedBy:null,updatedAt:null};}
async function live(db){const r=await db.prepare('SELECT version,public_json,reviewed_at FROM editorial_live WHERE slot=1').first();return r?JSON.parse(r.public_json):unpublished();}
async function audit(db,action,actor,revision){await db.prepare('INSERT INTO editorial_audit(id,action,actor,revision,at) VALUES (?,?,?,?,?)').bind(eventId(),action,actor,revision,now()).run();}
function hasOnly(obj,keys){return Object.keys(obj).every(k=>keys.includes(k));}
async function editorial(req,env,actor,rest,fetcher){
  const db=env.DB;
  if(req.method==='GET'&&rest==='/editorial'){if(!permission(actor,'editor')&&!permission(actor,'approver'))return unauthorized();return reply({ok:true,draft:await latestDraft(db),live:await live(db)});}
  if(req.method==='PUT'&&rest==='/editorial'){
    if(!permission(actor,'editor'))return unauthorized();const body=await jsonBody(req);
    if(!body||!hasOnly(body,['expectedRevision','document'])||!Number.isSafeInteger(body.expectedRevision))return reply({ok:false,error:'Неверная ревизия.'},400);
    const errors=validateDraft(body.document);if(errors.length)return reply({ok:false,error:'Документ не прошёл проверку.',details:errors},422);
    const old=await latestDraft(db);if(old.revision!==body.expectedRevision)return reply({ok:false,error:'Документ изменён другим редактором. Обновите страницу.'},409);
    const doc=JSON.stringify(body.document),stamp=now();let result;
    if(!old.revision){result=await db.prepare('INSERT OR IGNORE INTO editorial_draft(slot,revision,document_json,updated_by,updated_at) VALUES (1,1,?,?,?)').bind(doc,actor.email,stamp).run();}
    else result=await db.prepare('UPDATE editorial_draft SET revision=revision+1,document_json=?,updated_by=?,updated_at=? WHERE slot=1 AND revision=?').bind(doc,actor.email,stamp,old.revision).run();
    if(!result.meta?.changes)return reply({ok:false,error:'Конфликт параллельного изменения.'},409);
    await audit(db,'draft_saved',actor.email,old.revision+1);return reply({ok:true,revision:old.revision+1});
  }
  if(req.method==='POST'&&rest==='/editorial/approve'){
    if(!permission(actor,'approver'))return unauthorized();const body=await jsonBody(req);
    if(!body||!Number.isSafeInteger(body.expectedRevision))return reply({ok:false,error:'Укажите ожидаемую ревизию.'},400);
    const d=await latestDraft(db);if(d.revision!==body.expectedRevision||!d.revision)return reply({ok:false,error:'Черновик изменился. Проверьте снова.'},409);
    if(env.REQUIRE_TWO_PERSON_REVIEW==='true'&&d.updatedBy===actor.email)return reply({ok:false,error:'Требуется другой утверждающий.'},403);
    const errors=validateDraft(d.document,{strict:true});if(errors.length)return reply({ok:false,error:'Публикация остановлена.',details:errors},422);
    // Existing local MP4 is verified with HEAD; Stream requires two-person media approval AND encoding status.
    const mediaMetadata={};const streamUids=[];
    for(const ep of d.document.episodes){
      if(ep.videoUrl.startsWith('stream:')){
        const uid=ep.videoUrl.slice(7);const m=await db.prepare('SELECT day,state,review_status,chapters_json FROM media_assets WHERE stream_uid=?').bind(uid).first();
        if(m?.day!==ep.day||m.state!=='ready'||m.review_status!=='approved'||!streamFrame(env,uid)||!await checkStreamReady(env,fetcher,uid))return reply({ok:false,error:'Stream-эпизод не прошёл независимую проверку: день '+ep.day},422);
        streamUids.push(uid);mediaMetadata[uid]={chapters:JSON.parse(m.chapters_json||'[]')};
      }else{
        let check;try{check=await fetcher(new URL(req.url).origin+ep.videoUrl,{method:'HEAD',redirect:'manual'});}catch{return reply({ok:false,error:'Видео недоступно для проверки. Публикация остановлена.'},422);}
        if(!check.ok||!/^video\/(mp4|webm)/.test(check.headers.get('content-type')||''))return reply({ok:false,error:'Видео не найдено или MIME не соответствует видео: день '+ep.day},422);
      }
    }
    // Do not expose Stream before its scheduled time if a calendar approval exists.
    let calendarRows=[];try{calendarRows=(await db.prepare('SELECT day,status,publish_at FROM episode_calendar').all()).results||[];}catch{} // Legacy R3 D1 remains readable before migration 0003.
    const schedule=new Map(calendarRows.map(x=>[x.day,x]));const exposed=[];
    for(const ep of d.document.episodes.filter(e=>e.videoUrl.startsWith('stream:'))){
      const c=schedule.get(ep.day),uid=ep.videoUrl.slice(7);
      // An embargo explicitly locks access even when the media UID was previously public.
      if(c&&c.status!=='released'){
        if(!await exposeStream(env,fetcher,uid,false))return reply({ok:false,error:'Невозможно защитить отложенный выпуск.'},502);
        continue;
      }
      if(!await exposeStream(env,fetcher,uid,true)){
        for(const prior of exposed)await exposeStream(env,fetcher,prior,false);
        return reply({ok:false,error:'Невозможно разрешить публичное воспроизведение Stream.'},502);
      }exposed.push(uid);
    }
    const previousRelease=await live(db);
    const prev=await db.prepare('SELECT version FROM editorial_live WHERE slot=1').first();const version=Number(prev?.version||0)+1;
    const release=buildPublicRelease(d.document,version,now(),{streamHost:env.STREAM_CUSTOMER_CODE?'customer-'+env.STREAM_CUSTOMER_CODE+'.cloudflarestream.com':null,streamMetadata:mediaMetadata});
    let hasHistory=true;try{await db.prepare('SELECT version FROM editorial_versions LIMIT 1').all();}catch{hasHistory=false;}
    const operations=[
      db.prepare('INSERT INTO editorial_live(slot,version,public_json,reviewed_by,reviewed_at) VALUES (1,?,?,?,?) ON CONFLICT(slot) DO UPDATE SET version=excluded.version,public_json=excluded.public_json,reviewed_by=excluded.reviewed_by,reviewed_at=excluded.reviewed_at').bind(version,JSON.stringify(release),actor.email,release.reviewedAt),
      db.prepare('INSERT INTO editorial_audit(id,action,actor,revision,at) VALUES (?,?,?,?,?)').bind(eventId(),'approved',actor.email,d.revision,release.reviewedAt),
      ...(hasHistory?[db.prepare('INSERT INTO editorial_versions(version,public_json,reviewed_by,reviewed_at) VALUES (?,?,?,?)').bind(version,JSON.stringify(release),actor.email,release.reviewedAt)]:[])
    ];
    await db.batch(operations);
    // Revocation after commit: old removed Stream UIDs must not remain playable by their direct URLs.
    const currentUids=new Set(release.episodes.filter(e=>e.videoUrl?.startsWith('stream:')).map(e=>e.videoUrl.slice(7)));
    let retiredStreamRevoked=true;
    for(const old of previousRelease.episodes||[]){if(old.videoUrl?.startsWith('stream:')&&!currentUids.has(old.videoUrl.slice(7)))
      if(!await exposeStream(env,fetcher,old.videoUrl.slice(7),false))retiredStreamRevoked=false;
    }
    return reply({ok:true,version,published:release,retiredStreamRevoked},retiredStreamRevoked?200:207);
  }
  if(req.method==='POST'&&rest==='/editorial/unpublish'){
    if(!permission(actor,'approver'))return unauthorized();const prior=await live(db);let revoked=true;for(const ep of prior.episodes||[]){if(ep.videoUrl?.startsWith('stream:')&&!await exposeStream(env,fetcher,ep.videoUrl.slice(7),false))revoked=false;}await db.batch([
      db.prepare('DELETE FROM editorial_live WHERE slot=1'),
      db.prepare('INSERT INTO editorial_audit(id,action,actor,revision,at) VALUES (?,?,?,?,?)').bind(eventId(),'unpublished',actor.email,null,now())
    ]);return reply({ok:true,status:'unpublished',streamAccessRevoked:revoked},revoked?200:207);
  }
  return null;
}
async function leads(req,env,actor,rest){
  if(!rest.startsWith('/leads'))return null;
  if(!permission(actor,'moderator'))return unauthorized();const db=env.DB;
  if(rest==='/leads'&&req.method==='GET'){
    const url=new URL(req.url),status=url.searchParams.get('status')||'all',offset=Number(url.searchParams.get('offset')||0);
    if(!['all','new','triaged','replied','closed'].includes(status)||!Number.isSafeInteger(offset)||offset<0||offset>10000)return reply({ok:false,error:'Недопустимый фильтр.'},400);
    const sql="SELECT l.id,l.kind,l.name,l.email,l.company,l.message,l.consent_at,l.created_at,COALESCE(r.status,'new') AS status,COALESCE(r.internal_note,'') AS internal_note,r.updated_by,r.updated_at FROM leads l LEFT JOIN lead_reviews r ON r.lead_id=l.id "+(status==='all'?'':'WHERE COALESCE(r.status,\'new\')=? ')+"ORDER BY l.created_at DESC,l.id DESC LIMIT 25 OFFSET ?";
    const rows=(await db.prepare(sql).bind(...(status==='all'?[]:[status]),offset).all()).results||[];
    return reply({ok:true,leads:rows,nextOffset:rows.length===25?offset+25:null});
  }
  const match=/^\/leads\/([0-9a-f-]{36})$/.exec(rest);if(!match)return null;
  const id=match[1];if(req.method==='PATCH'){
    const b=await jsonBody(req);if(!b||!hasOnly(b,['status','internalNote'])||!['new','triaged','replied','closed'].includes(b.status)||typeof b.internalNote!=='string'||b.internalNote.length>500||/[<>\u0000-\u001f]/.test(b.internalNote))return reply({ok:false,error:'Недопустимые поля статуса.'},400);
    const target=await db.prepare('SELECT id FROM leads WHERE id=?').bind(id).first();if(!target)return reply({ok:false,error:'Обращение не найдено.'},404);
    await db.batch([
      db.prepare("INSERT INTO lead_reviews(lead_id,status,internal_note,updated_by,updated_at) VALUES (?,?,?,?,?) ON CONFLICT(lead_id) DO UPDATE SET status=excluded.status,internal_note=excluded.internal_note,updated_by=excluded.updated_by,updated_at=excluded.updated_at").bind(id,b.status,b.internalNote,actor.email,now()),
      db.prepare('INSERT INTO operator_audit(id,event,actor,subject_id,at) VALUES (?,?,?,?,?)').bind(eventId(),'lead_status_changed',actor.email,id,now())
    ]);return reply({ok:true,id,status:b.status});
  }
  if(req.method==='DELETE'){
    const existing=await db.prepare('SELECT id FROM leads WHERE id=?').bind(id).first();if(!existing)return reply({ok:false,error:'Запись уже удалена.'},404);
    await db.batch([db.prepare('DELETE FROM lead_reviews WHERE lead_id=?').bind(id),db.prepare('DELETE FROM leads WHERE id=?').bind(id),
      db.prepare('INSERT INTO operator_audit(id,event,actor,subject_id,at) VALUES (?,?,?,?,?)').bind(eventId(),'lead_erased',actor.email,null,now())]);
    return reply({ok:true,erased:true});
  }
  return null;
}
async function campaigns(req,env,actor,rest,fetcher){
  if(!rest.startsWith('/campaigns'))return null;const db=env.DB;
  if(!actor.approver&&!actor.editor)return unauthorized();
  if(rest==='/campaigns'&&req.method==='GET'){
    const list=(await db.prepare("SELECT c.id,c.episode_day,c.subject,c.intro,c.status,c.created_by,c.created_at,c.approved_by,c.approved_at,c.completed_at, (SELECT COUNT(*) FROM digest_deliveries d WHERE d.campaign_id=c.id AND d.status='sent') AS sent_count FROM digest_campaigns c ORDER BY created_at DESC LIMIT 50").all()).results||[];
    return reply({ok:true,campaigns:list,sendEnabled:env.DIGEST_DELIVERY_ENABLED==='true'});
  }
  if(rest==='/campaigns'&&req.method==='POST'){
    if(!actor.editor)return unauthorized();const b=await jsonBody(req);
    if(!b||!hasOnly(b,['day','subject','intro'])||!Number.isInteger(b.day)||b.day<1||b.day>10||typeof b.subject!=='string'||b.subject.length<8||b.subject.length>140||/[^\S ]|[<>]/.test(b.subject)||
      typeof b.intro!=='string'||b.intro.length<20||b.intro.length>800||/[<>\u0000-\u001f]/.test(b.intro))return reply({ok:false,error:'Неверные параметры рассылки.'},400);
    const liveDoc=await visibleRelease(db,await live(db));if(!liveDoc.episodes?.some(e=>e.day===b.day))return reply({ok:false,error:'Нельзя отправлять письмо о неопубликованном выпуске.'},409);
    const id=eventId();await db.prepare("INSERT INTO digest_campaigns (id,episode_day,subject,intro,status,created_by,created_at) VALUES (?,?,?,?,'draft',?,?)").bind(id,b.day,b.subject,b.intro,actor.email,now()).run();return reply({ok:true,id,status:'draft'},201);
  }
  const match=/^\/campaigns\/([0-9a-f-]{36})\/(approve|cancel|send-batch)$/.exec(rest);if(!match)return null;
  if(!actor.approver)return unauthorized();const [_,id,operation]=match;if(req.method!=='POST')return reply({ok:false,error:'POST required'},405);
  const c=await db.prepare('SELECT id,episode_day,status,created_by FROM digest_campaigns WHERE id=?').bind(id).first();if(!c)return reply({ok:false,error:'Рассылка не найдена.'},404);
  if(operation==='cancel'){
    if(c.status==='completed')return reply({ok:false,error:'Уже завершено.'},409);
    await db.prepare("UPDATE digest_campaigns SET status='cancelled' WHERE id=?").bind(id).run();return reply({ok:true,status:'cancelled'});
  }
  if(operation==='approve'){
    if(c.status!=='draft')return reply({ok:false,error:'Кампания уже обработана.'},409);
    if(env.REQUIRE_TWO_PERSON_REVIEW==='true'&&c.created_by===actor.email)return reply({ok:false,error:'Требуется независимое утверждение.'},403);
    const release=await visibleRelease(db,await live(db));if(!release.episodes?.some(e=>e.day===c.episode_day))return reply({ok:false,error:'Выпуск больше не опубликован.'},409);
    if(env.DIGEST_DELIVERY_ENABLED!=='true'||!env.UNSUB_SIGNING_KEY||env.UNSUB_SIGNING_KEY.length<32||!env.RESEND_API_KEY||!env.EMAIL_FROM)return reply({ok:false,error:'Отправка писем отключена в конфигурации.'},503);
    await db.batch([db.prepare("INSERT OR IGNORE INTO digest_deliveries(campaign_id,email_hash,status) SELECT ?,email_hash,'pending' FROM subscriptions WHERE status='subscribed'").bind(id),
      db.prepare("UPDATE digest_campaigns SET status='queued',approved_by=?,approved_at=? WHERE id=? AND status='draft'").bind(actor.email,now(),id)]);
    const n=await db.prepare('SELECT COUNT(*) AS n FROM digest_deliveries WHERE campaign_id=?').bind(id).first();return reply({ok:true,status:'queued',recipients:Number(n?.n||0)});
  }
  if(operation==='send-batch'){
    if(env.DIGEST_DELIVERY_ENABLED!=='true')return reply({ok:false,error:'Отправка не активирована.'},503);
    if(!['queued','sending'].includes(c.status))return reply({ok:false,error:'Кампания не в очереди.'},409);
    // Prevent manual action from accidentally processing a different campaign.
    const result=await sendDigestBatch(env,fetcher,{campaignId:id,batchSize:10});return reply(result,result.ok?200:409);
  }
  return null;
}
export async function adminRoute(req,env,actor,fetcher=fetch){
  if(!env.DB)return reply({ok:false,error:'D1 не подключена.'},503);
  const rest=new URL(req.url).pathname.slice(base.length);
  if(rest==='/session'&&req.method==='GET')return reply({ok:true,actor});
  if(!['GET','HEAD'].includes(req.method) && (req.headers.get('Origin')!==new URL(req.url).origin||!req.headers.get('content-type')?.startsWith('application/json')))
    return reply({ok:false,error:'Неверный Origin или Content-Type.'},403);
  if(rest.startsWith('/media'))return await mediaRoute(req,env,actor,rest,fetcher)||reply({ok:false,error:'Route not found'},404);
  if(rest.startsWith('/calendar'))return await calendarRoute(req,env,actor,rest)||reply({ok:false,error:'Route not found'},404);
  if(rest.startsWith('/backups')||rest.startsWith('/versions'))return await recoveryRoute(req,env,actor,rest,fetcher)||reply({ok:false,error:'Route not found'},404);
  if(rest.startsWith('/editorial'))return await editorial(req,env,actor,rest,fetcher)||reply({ok:false,error:'Route not found'},404);
  if(rest.startsWith('/leads'))return await leads(req,env,actor,rest)||reply({ok:false,error:'Route not found'},404);
  if(rest.startsWith('/campaigns'))return await campaigns(req,env,actor,rest,fetcher)||reply({ok:false,error:'Route not found'},404);
  return reply({ok:false,error:'Route not found'},404);
}
