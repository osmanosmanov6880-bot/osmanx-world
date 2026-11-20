// CINEMA R6 real PostgreSQL acceptance: tenant queue, paging, replay, data rights.
import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {buildApp} from '../src/app.mjs';
import {makePool,withTenant} from '../src/database.mjs';
import {hashPassword} from '../src/password.mjs';
import {queueOptions,explainTriage} from '../src/cinema-r6.mjs';
import {contactRequest} from '../src/cinema-r5.mjs';
import {inspectCinemaR6} from '../scripts/cinema-r6-readiness.mjs';

const P='/api/industry/v1',suffix=randomUUID().slice(0,8),users={};
const admin=new pg.Pool({connectionString:process.env.MIGRATION_DB_URL});
const pool=makePool();let app,tenant,foreign,leadId,leadVersion;
const password='CINEMA-R6-verified-CI-pass-2026!';
const previous=Object.fromEntries(['CINEMA_TENANT_ID','CINEMA_RATE_SECRET','CINEMA_PUBLIC_WRITE_ENABLED','CINEMA_AGGREGATE_EVENTS_ENABLED'].map(k=>[k,process.env[k]]));
function send(method,path,user,payload,headers={}){
  return app.inject({method,url:P+path,headers:{
    ...(user?{cookie:user.cookie,'x-csrf-token':user.csrf}:{}),...headers
  },...(payload===undefined?{}:{payload})});
}
const expect=(res,status)=>{assert.equal(res.statusCode,status,res.body);return res.json();};
before(async()=>{
  tenant=(await admin.query("INSERT INTO industry.tenants(slug,name,vertical) VALUES($1,'R6 operator test','cafe') RETURNING id",['r6-'+suffix])).rows[0].id;
  foreign=(await admin.query("INSERT INTO industry.tenants(slug,name,vertical) VALUES($1,'R6 foreign test','cafe') RETURNING id",['r6-foreign-'+suffix])).rows[0].id;
  for(const [role,tenantId] of [['owner',tenant],['manager',tenant],['viewer',tenant],['foreign',foreign]]){
    const email='r6-'+role+'-'+suffix+'@example.test';
    const id=(await admin.query('INSERT INTO industry.accounts(email,password_hash) VALUES($1,$2) RETURNING id',
      [email,await hashPassword(password)])).rows[0].id;
    await admin.query('INSERT INTO industry.memberships(tenant_id,account_id,role) VALUES($1,$2,$3)',
      [tenantId,id,role==='foreign'?'owner':role]);
    users[role]={id,email,slug:tenantId===tenant?'r6-'+suffix:'r6-foreign-'+suffix};
  }
  process.env.CINEMA_TENANT_ID=tenant;
  process.env.CINEMA_RATE_SECRET='R6-PostgreSQL-Integration-Secret-At-Least-32-Bytes';
  process.env.CINEMA_PUBLIC_WRITE_ENABLED='true';
  process.env.CINEMA_AGGREGATE_EVENTS_ENABLED='true';
  app=await buildApp(pool);
  for(const user of Object.values(users)){
    const res=await send('POST','/auth/login',null,{tenantSlug:user.slug,email:user.email,password});
    expect(res,200);
    const cookies=[].concat(res.headers['set-cookie']||[]).map(x=>x.split(';')[0]);
    const csrf=cookies.find(x=>x.startsWith('osmanx_industry_csrf='));
    assert(csrf);user.cookie=cookies.join('; ');user.csrf=csrf.split('=')[1];
  }
  await withTenant(pool,tenant,async db=>{
    await db.query(
      "INSERT INTO industry.cinema_leads(tenant_id,contact_name,contact_email,story_id,observation,source,idempotency_key,payload_digest,created_at,campaign_code)"+
      " SELECT $1,'Synthetic lead','synthetic-'||g::text||'@example.test','07-coffee','Synthetic lead for cursor testing','cinema',"+
      " 'r6-cursor-'||g::text||'-'||$2,repeat('a',64),now()-g*interval '1 minute','r6_bulk'"+
      " FROM generate_series(1,135) g",[tenant,suffix]
    );
  });
  const payload={storyId:'07-coffee',contactName:'Test prospect',contactEmail:'r6-contact-'+suffix+'@example.test',
    observation:'Clients exit after long waits',source:'cinema',campaignCode:'r6_field',consent:true,website:''};
  const created=expect(await send('POST','/cinema/public/leads',null,payload,
    {'idempotency-key':'r6-new-lead-'+suffix+'-abcd'}),201);
  leadId=created.reference;leadVersion=1;
});
after(async()=>{
  try{await app?.close();await pool.end();}
  finally{
    try{
      if(tenant&&foreign)await admin.query('DELETE FROM industry.tenants WHERE id=$1 OR id=$2',[tenant,foreign]);
      await admin.query('DELETE FROM industry.accounts WHERE email LIKE $1',['r6-%-'+suffix+'@example.test']);
    }finally{
      await admin.end();
      for(const [key,val] of Object.entries(previous)){if(val===undefined)delete process.env[key];else process.env[key]=val;}
    }
  }
});
test('R6 deterministic signals are transparent, not AI scoring',()=>{
  const now=Date.parse('2026-11-20T12:00:00Z');
  const x=explainTriage({state:'new',created_at:'2026-11-19T10:00:00Z',next_action_at:'2026-11-20T11:00:00Z',assigned_to:null,contact_count:0},now);
  assert.equal(x.priority,'urgent');
  assert.deepEqual(x.signals.map(x=>x.code),['followup_overdue','unassigned','first_contact_24h']);
  assert.equal(explainTriage({state:'won'},now).priority,'closed');
  assert.equal(queueOptions({view:'unassigned',assignedTo:'mine'},users.owner.id).assignedId,users.owner.id);
  assert.throws(()=>queueOptions({beforeCreatedAt:'2026-11-20T00:00:00Z'},users.owner.id));
  assert.throws(()=>queueOptions({limit:'999'},users.owner.id));
  assert.throws(()=>queueOptions({view:'fake'},users.owner.id));
  assert.throws(()=>contactRequest('short',{expectedVersion:1,channel:'email',outcome:'connected',completeFollowup:false}));
});
test('R6 complete queue pages >100 distinct rows with stable keyset order, filters and RLS',async()=>{
  const ids=new Set();let cursor=null;
  for(let page=0;page<10;page++){
    const qs=new URLSearchParams({limit:'25',view:'all'});
    if(cursor){qs.set('beforeCreatedAt',cursor.beforeCreatedAt);qs.set('beforeId',cursor.beforeId);}
    const result=expect(await send('GET','/cinema/queue?'+qs,users.owner),200);
    assert.equal(result.schema,'osmanx.cinema.queue.v1');
    assert.equal(result.total,136);
    for(const item of result.items){
      assert(!ids.has(item.id),'duplicate page item');ids.add(item.id);
    }
    if(!result.hasMore){assert.equal(result.nextCursor,null);break;}
    assert.equal(result.items.length,25);
    cursor=result.nextCursor;assert(cursor.beforeCreatedAt&&cursor.beforeId);
  }
  assert.equal(ids.size,136,'the first 100 must not hide the remaining leads');
  const filtered=expect(await send('GET','/cinema/queue?limit=10&view=unassigned',users.manager),200);
  assert.equal(filtered.total,136);
  const own=expect(await send('GET','/cinema/queue?assignedTo=mine',users.manager),200);
  assert.equal(own.total,0);
  const summary=expect(await send('GET','/cinema/queue/summary',users.manager),200);
  assert.equal(summary.counts.active,136);
  assert.equal(summary.counts.unassigned,136);
  expect(await send('GET','/cinema/queue',users.viewer),403);
  expect(await send('GET','/cinema/queue',users.foreign),403);
  expect(await send('GET','/cinema/queue?state=%3Cscript%3E',users.owner),400);
});
test('R6 contact replay is atomic and does not double-count concurrent requests',async()=>{
  const key='r6-contact-'+suffix+'-request';
  const body={expectedVersion:leadVersion,channel:'email',outcome:'no_reply',completeFollowup:false};
  const res=await Promise.all(Array.from({length:7},()=>send('POST','/cinema/leads/'+leadId+'/contacts',users.manager,body,{'idempotency-key':key})));
  assert.equal(res.filter(x=>x.statusCode===200).length,7,res.map(x=>x.statusCode).join(','));
  assert.equal(res.map(x=>x.json().duplicate).filter(x=>x===false).length,1);
  assert.equal(res.map(x=>x.json().duplicate).filter(x=>x===true).length,6);
  const events=await withTenant(pool,tenant,db=>db.query(
    "SELECT count(*)::int AS n FROM industry.cinema_lead_events WHERE lead_id=$1 AND event_type='contact_logged'",[leadId]));
  assert.equal(events.rows[0].n,1);
  const lead=expect(await send('GET','/cinema/leads',users.manager),200).items.find(x=>x.id===leadId);
  assert.equal(lead.contact_count,1);leadVersion=lead.version;
  expect(await send('POST','/cinema/leads/'+leadId+'/contacts',users.manager,
    {...body,outcome:'connected'},{'idempotency-key':key}),409);
  expect(await send('POST','/cinema/leads/'+leadId+'/contacts',users.manager,
    body,{'idempotency-key':'invalid'}),400);
  expect(await send('POST','/cinema/leads/'+leadId+'/contacts',users.manager,
    body,{'idempotency-key':'r6-another-'+suffix+'-request'}),409);
});
test('R6 subject export loads all >1000 audit events, logs receipt without email, owner only',async()=>{
  await withTenant(pool,tenant,db=>db.query(
    "INSERT INTO industry.cinema_lead_events(tenant_id,lead_id,event_type,old_state,new_state,version) "+
    "SELECT $1,$2,'state_changed','new','new',g FROM generate_series(10,1080) g",[tenant,leadId]
  ));
  const first=expect(await send('GET','/cinema/leads/'+leadId+'/export',users.owner),200);
  assert(first.truncated);assert.equal(first.events.length,1000);
  assert.equal(first.nextAfterVersion,first.events.at(-1).version);
  const second=expect(await send('GET','/cinema/leads/'+leadId+'/export?afterVersion='+first.nextAfterVersion,users.owner),200);
  assert(!second.truncated);assert(second.events.length>50);
  assert.equal(first.events.length+second.events.length,1073);
  assert.equal(second.nextAfterVersion,null);
  expect(await send('GET','/cinema/leads/'+leadId+'/export',users.viewer),403);
  expect(await send('GET','/cinema/leads/'+leadId+'/export',users.foreign),403);
  expect(await send('GET','/cinema/leads/'+leadId+'/export?afterVersion=hack',users.owner),400);
  const match=expect(await send('GET','/cinema/privacy/search?email=r6-contact-'+suffix+'%40example.test',users.owner),200);
  assert.equal(match.items.length,1);
  const access=expect(await send('GET','/cinema/privacy/access-log',users.owner),200);
  assert(access.items.some(x=>x.action==='subject_search'));
  assert.equal(access.items.filter(x=>x.action==='subject_export').length,2);
  assert(!JSON.stringify(access).includes('r6-contact-'+suffix+'@'));
  expect(await send('GET','/cinema/privacy/access-log',users.manager),403);
  const inOther=await withTenant(pool,foreign,db=>db.query('SELECT count(*)::int AS n FROM industry.cinema_access_events',[tenant]));
  assert.equal(inOther.rows[0].n,0);
});
test('R6 gate never auto-activates; erasure leaves only unlinkable receipts',async()=>{
  const ready=await inspectCinemaR6(pool,{CINEMA_TENANT_ID:tenant,CINEMA_RATE_SECRET:'R6-TEST-SECRET-AT-LEAST-32-CHARACTERS'});
  assert.equal(ready.checks.r6Schema,true);
  assert.equal(ready.checks.r6AuditRls,true);
  assert.equal(ready.checks.r6ContactUnique,true);
  assert.equal(ready.go,false);
  expect(await send('DELETE','/cinema/leads/'+leadId,users.manager),403);
  expect(await send('DELETE','/cinema/leads/'+leadId,users.owner),200);
  const receipts=expect(await send('GET','/cinema/privacy/access-log',users.owner),200).items;
  assert(receipts.some(x=>x.action==='lead_deleted'&&x.lead_id===null));
  assert(receipts.every(x=>x.lead_id!==leadId));
  expect(await send('GET','/cinema/leads/'+leadId+'/export',users.owner),404);
});
