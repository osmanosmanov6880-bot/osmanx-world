/** Editorial release calendar. A scheduled release requires a separate approver and an actually approved documentary film. */
import {exposeStream,checkStreamReady} from './media.mjs';
import {visibilityReady} from './visibility.mjs';
const res=(x,s=200)=>new Response(JSON.stringify(x),{status:s,headers:{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});
const text=(x,max)=>typeof x==='string'&&x.trim().length>0&&x.length<=max&&!/[<>\u0000-\u001f\u007f]/.test(x)&&!/[\w.+-]+@[\w.-]+\.[a-z]{2,}/i.test(x);
const ISO=/^20\d\d-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/;
const dayValid=x=>Number.isInteger(x)&&x>=1&&x<=10;
const steps=['filmed','consents','music','captions','factCheck','poster'];
const exact=(obj,keys)=>obj&&typeof obj==='object'&&!Array.isArray(obj)&&Object.keys(obj).every(x=>keys.includes(x));
async function body(req){if(!req.headers.get('content-type')?.startsWith('application/json'))return null;const raw=await req.text();if(raw.length>7000)return null;try{const x=JSON.parse(raw);return x&&typeof x==='object'&&!Array.isArray(x)?x:null;}catch{return null;}}
const now=()=>new Date().toISOString();
export async function calendarRoute(req,env,actor,rest){
 if(!rest.startsWith('/calendar'))return null;if(!env.DB)return res({ok:false,error:'D1 не подключена.'},503);
 const db=env.DB;if(!actor?.editor&&!actor?.approver)return res({ok:false,error:'Доступ запрещён.'},403);
 if(rest==='/calendar'&&req.method==='GET'){
  const rows=(await db.prepare('SELECT day,title,publish_at,checklist_json,status,revision,updated_by,approved_by,updated_at FROM episode_calendar ORDER BY day').all()).results||[];
  return res({ok:true,days:rows.map(x=>({...x,checklist:JSON.parse(x.checklist_json)}))});
 }
 const m=/^\/calendar\/(10|[1-9])(?:\/(approve|cancel))?$/.exec(rest);if(!m)return null;const day=Number(m[1]),op=m[2];
 if(req.method==='PUT'&&!op){if(!actor.editor)return res({ok:false,error:'Требуется роль редактора.'},403);
  const x=await body(req);const valid=x&&exact(x,['title','synopsis','publishAt','checklist','expectedRevision'])&&text(x.title,120)&&text(x.synopsis,400)&&ISO.test(x.publishAt||'')&&!Number.isNaN(Date.parse(x.publishAt))&&exact(x.checklist,steps)&&steps.every(k=>typeof x.checklist[k]==='boolean')&&Number.isSafeInteger(x.expectedRevision)&&x.expectedRevision>=0;
  if(!valid)return res({ok:false,error:'Неполный редакционный план.'},400);
  const old=await db.prepare('SELECT revision,status FROM episode_calendar WHERE day=?').bind(day).first();if((old?.revision||0)!==x.expectedRevision||['approved','released'].includes(old?.status))return res({ok:false,error:'Конфликт версии или утверждённый план.'},409);
  const content=JSON.stringify({checklist:x.checklist,synopsis:x.synopsis});const stamp=now();
  const result=await db.prepare("INSERT INTO episode_calendar(day,title,publish_at,checklist_json,status,revision,updated_by,updated_at) VALUES(?,?,?,?,'planned',1,?,?) ON CONFLICT(day) DO UPDATE SET title=excluded.title,publish_at=excluded.publish_at,checklist_json=excluded.checklist_json,status='planned',revision=episode_calendar.revision+1,updated_by=excluded.updated_by,updated_at=excluded.updated_at WHERE episode_calendar.revision=?").bind(day,x.title,x.publishAt,content,actor.email,stamp,x.expectedRevision).run();
  if(!result.meta?.changes)return res({ok:false,error:'Параллельное редактирование.'},409);
  return res({ok:true,revision:x.expectedRevision+1});
 }
 if(req.method==='POST'&&op){if(!actor.approver)return res({ok:false,error:'Требуется утверждающий.'},403);
  const x=await body(req);const old=await db.prepare('SELECT * FROM episode_calendar WHERE day=?').bind(day).first();if(!x||!old||x.expectedRevision!==old.revision)return res({ok:false,error:'План изменился.'},409);
  if(op==='cancel'){
    const cancelled=await db.prepare("UPDATE episode_calendar SET status='cancelled',revision=revision+1,updated_at=? WHERE day=? AND status!='released'").bind(now(),day).run();return cancelled.meta?.changes?res({ok:true,status:'cancelled'}):res({ok:false,error:'Опубликованный выпуск нельзя отменить через план. Используйте снятие публикации.'},409);
  }
  const checklist=JSON.parse(old.checklist_json),draft=await db.prepare('SELECT document_json FROM editorial_draft WHERE slot=1').first();let doc;try{doc=JSON.parse(draft?.document_json||'{}');}catch{}
  if(old.status!=='planned'||!steps.every(k=>checklist.checklist?.[k]===true)||!doc?.episodes?.some(e=>e.day===day&&e.rightsConfirmed))return res({ok:false,error:'Нужны все проверки и утверждаемый эпизод в черновике.'},422);
  if(env.REQUIRE_TWO_PERSON_REVIEW==='true'&&old.updated_by===actor.email)return res({ok:false,error:'Нужен второй утверждающий.'},403);
  await db.prepare("UPDATE episode_calendar SET status='approved',approved_by=?,revision=revision+1,updated_at=? WHERE day=? AND status='planned'").bind(actor.email,now(),day).run();return res({ok:true,status:'approved',publishAt:old.publish_at});
 }
 return res({ok:false,error:'Недопустимый метод.'},405);
}
export async function visibleRelease(db,release){if(!release||release.status!=='published'||!Array.isArray(release.episodes))return release;
 let rows=[];try{rows=(await db.prepare('SELECT day,status,publish_at,checklist_json FROM episode_calendar').all()).results||[];}catch{return release;}
 const cal=new Map(rows.map(x=>[x.day,x]));let jobStates=new Map();
 try{const jobs=(await db.prepare('SELECT uid,desired,state FROM stream_visibility').all()).results||[];jobStates=new Map(jobs.map(j=>[j.uid,j]));}catch{}
 const filtered=release.episodes.filter(e=>{const c=cal.get(e.day);if(c&&c.status!=='released')return false;
   if(e.videoUrl?.startsWith('stream:')){const j=jobStates.get(e.videoUrl.slice(7));if(j&&(j.desired!=='public'||j.state!=='applied'))return false;}return true;});
 return {...release,episodes:filtered};
}
export async function releaseDueEpisodes(env,fetcher=fetch,clock=new Date()){
 if(!env.DB)return {ok:false,reason:'no D1'};const db=env.DB;const useOutbox=await visibilityReady(db);
 const due=(await db.prepare("SELECT day FROM episode_calendar WHERE status='approved' AND publish_at<=? ORDER BY publish_at LIMIT 5").bind(clock.toISOString()).all()).results||[];let released=0,blocked=0;
 for(const item of due){const row=await db.prepare('SELECT public_json FROM editorial_live WHERE slot=1').first();const release=row?.public_json?JSON.parse(row.public_json):null;const ep=release?.episodes?.find(e=>e.day===item.day);
   if(!ep){blocked++;continue;}
   if(ep.videoUrl?.startsWith('stream:')){const uid=ep.videoUrl.slice(7);if(!await checkStreamReady(env,fetcher,uid)){blocked++;continue;}
     if(useOutbox){const stamp=clock.toISOString();await db.batch([
       db.prepare("UPDATE episode_calendar SET status='released',updated_at=? WHERE day=? AND status='approved' AND publish_at<=?").bind(stamp,item.day,stamp),
       db.prepare("INSERT INTO stream_visibility(uid,desired,state,attempts,reason,updated_at) VALUES(?,'public','pending',0,'scheduled-release',?) ON CONFLICT(uid) DO UPDATE SET desired='public',state='pending',attempts=0,reason='scheduled-release',updated_at=excluded.updated_at").bind(uid,stamp)
     ]);released++;continue;}
     if(!await exposeStream(env,fetcher,uid,true)){blocked++;continue;}
   }
   const result=await db.prepare("UPDATE episode_calendar SET status='released',updated_at=? WHERE day=? AND status='approved' AND publish_at<=?").bind(clock.toISOString(),item.day,clock.toISOString()).run();if(result.meta?.changes)released++;
 }
 return {ok:true,released,blocked};
}
