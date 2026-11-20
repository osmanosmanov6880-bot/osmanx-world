/** Delivery engine: only confirmed subscribers, finite batch, deterministic per-recipient idempotency keys. */
const origin=env=>String(env.SITE_ORIGIN||'https://osmanx.world').replace(/\/$/,'');
const digestBytes=buf=>Array.from(new Uint8Array(buf)).map(x=>x.toString(16).padStart(2,'0')).join('');
const safe=x=>String(x).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export async function optOutToken(env,emailHash){
  if(!env.UNSUB_SIGNING_KEY||env.UNSUB_SIGNING_KEY.length<32)throw Error('Unsubscribe signing key missing');
  const key=await crypto.subtle.importKey('raw',new TextEncoder().encode(env.UNSUB_SIGNING_KEY),{name:'HMAC',hash:'SHA-256'},false,['sign']);
  const mac=await crypto.subtle.sign('HMAC',key,new TextEncoder().encode('osmanx-unsub-v1:'+emailHash));
  return 'v2_'+emailHash+'_'+digestBytes(mac);
}
export async function verifiedOptOut(env,raw){
  const match=/^v2_([0-9a-f]{64})_([0-9a-f]{64})$/.exec(raw||'');
  if(!match)return null;
  const expected=await optOutToken(env,match[1]);
  const a=new TextEncoder().encode(expected),b=new TextEncoder().encode(raw);
  let diff=0;for(let i=0;i<a.length;i++)diff|=a[i]^b[i];
  return diff===0?match[1]:null;
}
export async function sendDigestBatch(env,fetcher=fetch,{batchSize=10,campaignId=null}={}){
  if(!env.DB||!env.RESEND_API_KEY||!env.EMAIL_FROM||!env.UNSUB_SIGNING_KEY)return {ok:false,reason:'Missing sending bindings'};
  const campaign=campaignId?await env.DB.prepare("SELECT id,episode_day,subject,intro,status FROM digest_campaigns WHERE id=? AND status IN ('queued','sending')").bind(campaignId).first():await env.DB.prepare("SELECT id,episode_day,subject,intro,status FROM digest_campaigns WHERE status IN ('queued','sending') ORDER BY approved_at ASC LIMIT 1").first();
  if(!campaign)return {ok:true,sent:0,failed:0,remaining:0};
  const live=await env.DB.prepare('SELECT public_json FROM editorial_live WHERE slot=1').first();
  const published=live?JSON.parse(live.public_json).episodes?.find(e=>e.day===campaign.episode_day):null;
  if(!published)return {ok:false,reason:'Episode is no longer published; send paused',campaign:campaign.id};
  const rows=(await env.DB.prepare("SELECT d.email_hash, s.email, d.attempts FROM digest_deliveries d INNER JOIN subscriptions s ON d.email_hash=s.email_hash WHERE d.campaign_id=? AND d.status IN ('pending','failed') AND d.attempts<3 AND s.status='subscribed' ORDER BY d.email_hash LIMIT ?").bind(campaign.id,Math.max(1,Math.min(10,batchSize))).all()).results||[];
  let sent=0,failed=0;
  await env.DB.prepare("UPDATE digest_campaigns SET status='sending' WHERE id=? AND status='queued'").bind(campaign.id).run();
  for(const row of rows){
    // Claim delivery atomically to avoid two scheduled Workers sending simultaneously.
    const claim=await env.DB.prepare("UPDATE digest_deliveries SET status='processing', attempts=attempts+1, locked_at=? WHERE campaign_id=? AND email_hash=? AND status IN ('pending','failed') AND attempts<3").bind(new Date().toISOString(),campaign.id,row.email_hash).run();
    if(!claim?.meta?.changes)continue;
    const unsubscribe=await optOutToken(env,row.email_hash);
    const link=origin(env)+'/moscow-1000/api/unsubscribe?token='+unsubscribe;
    const episodeUrl=origin(env)+'/moscow-1000/episodes/'+String(campaign.episode_day).padStart(2,'0')+'/';
    const body=`<p>${safe(campaign.intro)}</p><p><a href="${episodeUrl}">Смотреть опубликованный эпизод</a></p><p>Вы получили письмо, потому что подтвердили подписку на новые выпуски OSMANX.</p><p><a href="${link}">Отписаться от писем</a></p>`;
    let ok=false,messageId=null;
    try{const response=await fetcher('https://api.resend.com/emails',{method:'POST',headers:{Authorization:'Bearer '+env.RESEND_API_KEY,'Content-Type':'application/json','Idempotency-Key':'osmanx-'+campaign.id+'-'+row.email_hash},body:JSON.stringify({from:env.EMAIL_FROM,to:[row.email],subject:campaign.subject,html:body})});ok=response.ok;if(ok){const json=await response.json();messageId=String(json.id||'');}}catch{}
    if(ok){await env.DB.prepare("UPDATE digest_deliveries SET status='sent',sent_at=?,message_id=?,locked_at=NULL WHERE campaign_id=? AND email_hash=?").bind(new Date().toISOString(),messageId,campaign.id,row.email_hash).run();sent++;}
    else{await env.DB.prepare("UPDATE digest_deliveries SET status='failed',locked_at=NULL WHERE campaign_id=? AND email_hash=?").bind(campaign.id,row.email_hash).run();failed++;}
  }
  const count=await env.DB.prepare("SELECT count(*) AS n FROM digest_deliveries WHERE campaign_id=? AND status IN ('pending','processing')").bind(campaign.id).first();
  const retryable=await env.DB.prepare("SELECT count(*) AS n FROM digest_deliveries WHERE campaign_id=? AND status='failed' AND attempts<3").bind(campaign.id).first();
  const remaining=Number(count?.n||0)+Number(retryable?.n||0);
  if(!remaining)await env.DB.prepare("UPDATE digest_campaigns SET status='completed',completed_at=? WHERE id=? AND status='sending'").bind(new Date().toISOString(),campaign.id).run();
  return {ok:true,campaign:campaign.id,sent,failed,remaining};
}
