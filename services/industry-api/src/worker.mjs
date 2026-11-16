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
  const client=await pool.connect();
  try{
    await client.query('BEGIN');
    const {rows}=await client.query(
      "SELECT id,tenant_id,kind,payload,attempts FROM industry.outbox WHERE delivered_at IS NULL AND dead_at IS NULL AND available_at<=now() AND (locked_until IS NULL OR locked_until<now()) ORDER BY created_at ASC FOR UPDATE SKIP LOCKED LIMIT $1",[batch]);
    if(rows.length)await client.query(
      "UPDATE industry.outbox SET locked_until=now()+interval '90 seconds', attempts=attempts+1 WHERE id=ANY($1::uuid[])",[rows.map(r=>r.id)]);
    await client.query('COMMIT');return rows;
  }catch(err){await client.query('ROLLBACK').catch(()=>{});throw err}
  finally{client.release()}
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
  if(success) {
    await pool.query('UPDATE industry.outbox SET delivered_at=now(),locked_until=NULL,last_error=NULL WHERE id=$1',[row.id]);
    return;
  }
  const attempts=row.attempts+1;
  const delay=Math.min(3600,30*Math.pow(2,Math.min(attempts,7)));
  await pool.query(
    "UPDATE industry.outbox SET locked_until=NULL,available_at=now()+($2::int * interval '1 second'),dead_at=CASE WHEN $3 THEN now() ELSE NULL END,last_error=$4 WHERE id=$1",
    [row.id,delay,attempts>=8,errorText]);
  console.warn('Webhook deferred:',row.id,'attempt',attempts,errorText);
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
