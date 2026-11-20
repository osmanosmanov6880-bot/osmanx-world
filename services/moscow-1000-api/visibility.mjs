/** R5 cross-service outbox: SQL remains authoritative for public visibility.
 * Fail closed for scheduled Stream episodes until Stream acknowledgement is stored.
 * No public endpoint, Access token, or credential is exposed by this module.
 */
import {exposeStream} from './media.mjs';
const UID=/^[a-f0-9]{32}$/i;
export async function visibilityReady(db){try{await db.prepare('SELECT uid FROM stream_visibility LIMIT 1').all();return true;}catch{return false;}}
export async function recordVisibility(db,uid,desired,applied=false,reason='editorial'){
 if(!UID.test(uid)||!['public','private'].includes(desired))throw Error('Invalid visibility change');
 if(!await visibilityReady(db))return false; // Existing R4 D1 schema remains readable until migration.
 const timestamp=new Date().toISOString(),state=applied?'applied':'pending';
 await db.prepare("INSERT INTO stream_visibility(uid,desired,state,attempts,last_error,reason,updated_at) VALUES(?,?,?,0,NULL,?,?) ON CONFLICT(uid) DO UPDATE SET desired=excluded.desired,state=excluded.state,attempts=0,last_error=NULL,reason=excluded.reason,updated_at=excluded.updated_at")
 .bind(uid,desired,state,reason,timestamp).run();return true;
}
export async function reconcileVisibility(env,fetcher=fetch,{limit=8,clock=new Date()}={}){
 if(!env.DB||!await visibilityReady(env.DB))return {ok:false,reason:'visibility migration not applied',applied:0,failed:0};
 const db=env.DB,when=clock.toISOString(),stale=new Date(clock.getTime()-5*60_000).toISOString();
 const rows=(await db.prepare("SELECT uid,desired,state FROM stream_visibility WHERE attempts<8 AND (state IN ('pending','failed') OR (state='processing' AND updated_at<?)) ORDER BY updated_at ASC LIMIT ?").bind(stale,Math.max(1,Math.min(limit,20))).all()).results||[];
 let applied=0,failed=0;
 for(const row of rows){const claim=await db.prepare("UPDATE stream_visibility SET state='processing',attempts=attempts+1,updated_at=? WHERE uid=? AND desired=? AND attempts<8 AND (state IN ('pending','failed') OR (state='processing' AND updated_at<?))").bind(when,row.uid,row.desired,stale).run();if(!claim?.meta?.changes)continue;
  const successful=await exposeStream(env,fetcher,row.uid,row.desired==='public');
  const update=await db.prepare("UPDATE stream_visibility SET state=?,updated_at=?,last_error=? WHERE uid=? AND desired=? AND state='processing'").bind(successful?'applied':'failed',when,successful?null:'Stream update not acknowledged',row.uid,row.desired).run();
  if(update?.meta?.changes){if(successful)applied++;else failed++;}
 }
 const outstanding=await db.prepare("SELECT count(*) AS n FROM stream_visibility WHERE state!='applied'").first();
 return {ok:true,applied,failed,outstanding:Number(outstanding?.n||0)};
}
