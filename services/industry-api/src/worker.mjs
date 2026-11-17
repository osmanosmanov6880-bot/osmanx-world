// Reliable signed integration delivery. Endpoint operator-configured, never from user input.
import pg from 'pg';
import { createHmac } from 'node:crypto';
const {WORKER_DB_URL,WEBHOOK_URL,WEBHOOK_HMAC_KEY}=process.env;
if(!WORKER_DB_URL || !WEBHOOK_URL || !WEBHOOK_HMAC_KEY || WEBHOOK_HMAC_KEY.length < 32) throw Error('WORKER_DB_URL, WEBHOOK_URL and 32+ char WEBHOOK_HMAC_KEY required');
const endpoint=new URL(WEBHOOK_URL);
const localTest=process.env.NODE_ENV==='test' && endpoint.protocol==='http:' && ['127.0.0.1','localhost'].includes(endpoint.hostname);
if((endpoint.protocol!=='https:'&&!localTest)||endpoint.username||endpoint.password||endpoint.hash) throw Error('Only trusted HTTPS webhook URLs permitted');
const pool=new pg.Pool({connectionString:WORKER_DB_URL,max:3,application_name:'osmanx_industry_outbox'});
const once=process.argv.includes('--once');
let closing=false;
process.once('SIGINT',()=>closing=true);
process.once('SIGTERM',()=>closing=true);
async function claim(batch=12){
  const r=await pool.query(
    "WITH selected AS (SELECT id FROM industry.outbox WHERE delivered_at IS NULL AND dead_at IS NULL AND available_at<=now() "+
    "AND (locked_until IS NULL OR locked_until<now()) ORDER BY created_at ASC FOR UPDATE SKIP LOCKED LIMIT $1) "+
    "UPDATE industry.outbox o SET locked_until=now()+interval '180 seconds',lease_token=gen_random_uuid(),attempts=o.attempts+1 "+
    "FROM selected s WHERE o.id=s.id RETURNING o.id,o.tenant_id,o.kind,o.payload,o.attempts,o.lease_token",[batch]);
  return r.rows;
}
async function deliver(row){
  const now=String(Math.floor(Date.now()/1000));
  const body=JSON.stringify({id:row.id,tenantId:row.tenant_id,kind:row.kind,occurredAt:now,payload:row.payload});
  const signature=createHmac('sha256',WEBHOOK_HMAC_KEY).update(now+'.'+body).digest('hex');
  let success=false,errorText='';
  try{
    const response=await fetch(endpoint,{method:'POST',redirect:'error',signal:AbortSignal.timeout(7000),
      headers:{'Content-Type':'application/json','X-OSMANX-Event-Id':row.id,'X-OSMANX-Timestamp':now,'X-OSMANX-Signature':'sha256='+signature},
      body});
    success=response.ok;
    if(!success)errorText='Receiver HTTP '+response.status;
  }catch(error){errorText=String(error.message).slice(0,220)}
  if(success){
    const result=await pool.query(
      'UPDATE industry.outbox SET delivered_at=now(),locked_until=NULL,lease_token=NULL,last_error=NULL WHERE id=$1 AND lease_token=$2 AND delivered_at IS NULL',
      [row.id,row.lease_token]);
    if(!result.rowCount)console.warn('Stale webhook acknowledgement rejected:',row.id);
    return;
  }
  const delay=Math.min(3600,30*Math.pow(2,Math.min(row.attempts,7)));
  const result=await pool.query(
    "UPDATE industry.outbox SET locked_until=NULL,lease_token=NULL,available_at=now()+($3::int * interval '1 second'),"+
    "dead_at=CASE WHEN $4 THEN now() ELSE NULL END,last_error=$5 WHERE id=$1 AND lease_token=$2 AND delivered_at IS NULL",
    [row.id,row.lease_token,delay,row.attempts>=8,errorText]);
  if(!result.rowCount)console.warn('Stale webhook retry rejected:',row.id);
  else console.warn('Webhook deferred:',row.id,'attempt',row.attempts,errorText);
}
try{
  do{
    const rows=await claim();
    for(const event of rows) await deliver(event);
    if(once)break;
    await new Promise(resolve=>setTimeout(resolve,rows.length?100:3500));
  }while(!closing);
}catch(error){console.error('Worker stopped:',error.message);process.exitCode=1}
finally{await pool.end()}
