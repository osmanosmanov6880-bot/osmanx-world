/** R5 Stream Direct Creator tus URL provisioning. Never pass the CF Stream API token to the browser. */
import {streamConfigured} from './media.mjs';
const head={'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'};
const reply=(body,status=200)=>new Response(JSON.stringify(body),{status,headers:head});
const clean=x=>typeof x==='string'&&x.length>0&&x.length<=120&&!/[<>\u0000-\u001f\u007f]/.test(x);
const validUpload=x=>x&&Number.isInteger(x.day)&&x.day>=1&&x.day<=10&&clean(x.title)&&clean(x.fileName)&&/^[\w .()\-]+\.(mp4|webm)$/i.test(x.fileName)&&Number.isSafeInteger(x.sizeBytes)&&x.sizeBytes>0&&x.sizeBytes<=5*1024*1024*1024&&Number.isInteger(x.maxDurationSeconds)&&x.maxDurationSeconds>=1&&x.maxDurationSeconds<=3600;
const b64=v=>btoa(unescape(encodeURIComponent(String(v))));
export function tusMetadata({fileName,maxDurationSeconds},env,clock=new Date()){
 const expiry=new Date(clock.getTime()+30*60_000).toISOString();
 const host=new URL(env.SITE_ORIGIN||'https://osmanx.world').hostname;
 // Presence-only requiresignedurls flag is documented by Cloudflare Stream.
 return `name ${b64(fileName)},requiresignedurls,expiry ${b64(expiry)},maxdurationseconds ${b64(maxDurationSeconds)},allowedorigins ${b64(host)}`;
}
export function validTusLocation(url){try{const u=new URL(url);return u.protocol==='https:'&&u.hostname==='upload.videodelivery.net'&&u.username===''&&u.password===''&&u.pathname.startsWith('/')&&!u.hash;}catch{return false;}}
export async function createTusUpload(req,env,actor,fetcher=fetch){
 if(!actor?.editor)return reply({ok:false,error:'Требуется роль редактора.'},403);
 if(!streamConfigured(env)||env.STREAM_UPLOAD_ENABLED!=='true'||!env.DB)return reply({ok:false,error:'Stream/D1 не подключены или загрузка выключена.'},503);
 if(!req.headers.get('content-type')?.startsWith('application/json')||Number(req.headers.get('content-length')||0)>2048)return reply({ok:false,error:'Неверный запрос.'},400);
 let x;try{const s=await req.text();if(s.length>2048)return reply({ok:false,error:'Слишком большой запрос.'},400);x=JSON.parse(s);}catch{return reply({ok:false,error:'Неверный JSON.'},400);}
 if(!validUpload(x))return reply({ok:false,error:'MP4/WebM, до 5 ГиБ и 60 минут, корректные поля.'},400);
 const endpoint=`https://api.cloudflare.com/client/v4/accounts/${env.STREAM_ACCOUNT_ID}/stream?direct_user=true`;
 let response;try{response=await fetcher(endpoint,{method:'POST',headers:{'Authorization':'Bearer '+env.STREAM_API_TOKEN,'Tus-Resumable':'1.0.0','Upload-Length':String(x.sizeBytes),'Upload-Metadata':tusMetadata(x,env)}});}catch{return reply({ok:false,error:'Cloudflare Stream недоступен.'},502);}
 if(response.status!==201)return reply({ok:false,error:'Stream не создал безопасный адрес загрузки.'},502);
 const uploadURL=response.headers.get('Location'),uid=response.headers.get('stream-media-id');
 if(!validTusLocation(uploadURL)||!uid||!/^[a-f0-9]{32}$/i.test(uid))return reply({ok:false,error:'Неверные заголовки Stream. Загрузка заблокирована.'},502);
 const id=crypto.randomUUID();try{await env.DB.prepare('INSERT INTO media_assets(id,day,title,file_name,stream_uid,state,review_status,created_by,created_at,chapters_json) VALUES (?,?,?,?,?,?,?,?,?,?)')
 .bind(id,x.day,x.title.trim(),x.fileName,uid,'pendingupload','pending',actor.email,new Date().toISOString(),'[]').run();}catch{return reply({ok:false,error:'Не удалось сохранить сведения о загрузке; адрес не выдаётся.'},503);}
 return reply({ok:true,id,uploadURL,streamUid:uid,protocol:'tus-1.0.0',expiresInSeconds:1800,maxChunkBytes:50*1024*1024,rightsApproved:false},201);
}
