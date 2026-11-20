import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {buildApp} from '../src/app.mjs';
import {makePool,withTenant} from '../src/database.mjs';
import {hashPassword} from '../src/password.mjs';
import {cinemaConfig,parseLead,parseEvent,permittedTransition} from '../src/cinema.mjs';

const P='/api/industry/v1',tag=randomUUID().slice(0,8);
const admin=new pg.Pool({connectionString:process.env.MIGRATION_DB_URL});
const pool=makePool();
const password='Cinema-R3-CI-Str0ng-Password-2026!';
const saved=Object.fromEntries(['CINEMA_TENANT_ID','CINEMA_RATE_SECRET','CINEMA_PUBLIC_WRITE_ENABLED','CINEMA_AGGREGATE_EVENTS_ENABLED'].map(k=>[k,process.env[k]]));
let app,tenantId,otherTenantId,owner,manager,viewer,outsider,leadId;
const config=(enabled=true,events=true)=>{
  process.env.CINEMA_TENANT_ID=tenantId;
  process.env.CINEMA_RATE_SECRET='cinema-ci-strong-secret-hmac-2026-at-least-32';
  process.env.CINEMA_PUBLIC_WRITE_ENABLED=String(enabled);
  process.env.CINEMA_AGGREGATE_EVENTS_ENABLED=String(events);
};
function send(method,url,who,payload,extra={}){
  return app.inject({method,url:P+url,headers:{
    ...(who?{cookie:who.cookie,'x-csrf-token':who.csrf}:{}),...extra
  },...(payload===undefined?{}:{payload})});
}
function expect(res,status){
  assert.equal(res.statusCode,status,res.body);return res.json();
}
function getCookie(response){
  const cookies=[].concat(response.headers['set-cookie']||[]).map(x=>x.split(';')[0]);
  const c=cookies.find(x=>x.startsWith('osmanx_industry_csrf='));
  assert.ok(c,'Cookie should include CSRF');
  return {cookie:cookies.join('; '),csrf:c.split('=')[1]};
}
const payload=(email='cinema-client@example.test')=>({
  storyId:'01-restaurant',contactName:'Сергей',contactEmail:email,
  organization:'Проверяемое кафе',observation:'Гости не возвращаются после первого визита.',
  goal:'Узнать реальную причину',source:'cinema',consent:true,website:''
});
before(async()=>{
  tenantId=(await admin.query("INSERT INTO industry.tenants(slug,name,vertical) VALUES($1,$2,'cafe') RETURNING id",['cinema-r3-'+tag,'Cinema R3 test'])).rows[0].id;
  otherTenantId=(await admin.query("INSERT INTO industry.tenants(slug,name,vertical) VALUES($1,$2,'cafe') RETURNING id",['cinema-other-'+tag,'Other R3 test'])).rows[0].id;
  const users=[['owner','owner',tenantId],['manager','manager',tenantId],['viewer','viewer',tenantId],['outsider','owner',otherTenantId]];
  for(const [key,role,tenant] of users){
    const email='cinema-'+key+'-'+tag+'@example.test';
    const id=(await admin.query('INSERT INTO industry.accounts(email,password_hash) VALUES($1,$2) RETURNING id',[email,await hashPassword(password)])).rows[0].id;
    await admin.query('INSERT INTO industry.memberships(tenant_id,account_id,role) VALUES($1,$2,$3)',[tenant,id,role]);
    usersByName[key]={email,tenant:tenant===tenantId?'cinema-r3-'+tag:'cinema-other-'+tag};
  }
  config();
  app=await buildApp(pool);
  for(const [key,user] of Object.entries(usersByName)){
    const r=await send('POST','/auth/login',null,{tenantSlug:user.tenant,email:user.email,password});
    expect(r,200);user.auth=getCookie(r);
  }
  owner=usersByName.owner.auth;manager=usersByName.manager.auth;viewer=usersByName.viewer.auth;outsider=usersByName.outsider.auth;
});
const usersByName={};
after(async()=>{
  try{await app?.close();}finally{
    await pool.end();
    if(tenantId)await admin.query('DELETE FROM industry.tenants WHERE id=$1 OR id=$2',[tenantId,otherTenantId]);
    await admin.query('DELETE FROM industry.accounts WHERE email LIKE $1',['cinema-%-'+tag+'@example.test']);
    await admin.end();
    for(const [key,value] of Object.entries(saved)){if(value===undefined)delete process.env[key];else process.env[key]=value;}
  }
});
test('R3 public routes are disabled by default and reject missing tenant secret',async()=>{
  const bad=cinemaConfig({CINEMA_TENANT_ID:tenantId,CINEMA_RATE_SECRET:'tiny',CINEMA_PUBLIC_WRITE_ENABLED:'true'});
  assert.equal(bad.enabled,false);
  config(false);
  try {
    const status=expect(await send('GET','/cinema/public/config',null),200);
    assert.equal(status.intakeEnabled,false);
    // The platform intentionally masks 5xx error strings; status code is the public contract.
    expect(await send('POST','/cinema/public/leads',null,payload(),{'idempotency-key':'r3-safe-test-disabled-0001'}),503);
  } finally {
    config(true);
  }
});
test('R3 input validation rejects unknown stories, missing consent and unexpected fields',()=>{
  assert.equal(parseLead(payload(),'r3-safe-test-valid-0001').storyId,'01-restaurant');
  assert.throws(()=>parseLead({...payload(),consent:false},'r3-safe-test-invalid-001'));
  assert.throws(()=>parseLead({...payload(),storyId:'../../evil'},'r3-safe-test-invalid-002'));
  assert.throws(()=>parseLead({...payload(),hacker:true},'r3-safe-test-invalid-003'));
  assert.throws(()=>parseLead(payload(),'bad'));
  assert.throws(()=>parseEvent({eventType:'phone_collected'}));
  assert.equal(parseEvent({eventType:'film_started',storyId:'01-restaurant'}).eventType,'film_started');
  assert.equal(permittedTransition('new','contacted'),true);
  assert.equal(permittedTransition('new','won'),false);
});
test('R3 consent-only lead is stored once; duplicate is idempotent and replay collision fails',async()=>{
  const key='r3-client-first-'+tag+'-a';
  const first=expect(await send('POST','/cinema/public/leads',null,payload(),{'idempotency-key':key}),201);
  assert.equal(first.accepted,true);leadId=first.reference;
  assert.match(leadId,/^[0-9a-f-]{36}$/i);
  const twice=expect(await send('POST','/cinema/public/leads',null,payload(),{'idempotency-key':key}),200);
  assert.deepEqual({id:twice.reference,duplicate:twice.duplicate},{id:leadId,duplicate:true});
  expect(await send('POST','/cinema/public/leads',null,{...payload(),observation:'Совершенно иной запрос клиентов в тесте'}, {'idempotency-key':key}),409);
  const honey=expect(await send('POST','/cinema/public/leads',null,{...payload(),website:'spambot.test'},{'idempotency-key':'honeypot-'+tag+'-abcdefgh'}),202);
  assert.equal(honey.accepted,false);
});
test('R3 ownership checks block unauthorized tenants and viewers; managers may inspect data',async()=>{
  expect(await send('GET','/cinema/leads',null),401);
  expect(await send('GET','/cinema/leads',outsider),403);
  expect(await send('GET','/cinema/leads',viewer),403);
  const rows=expect(await send('GET','/cinema/leads?limit=100',manager),200).items;
  assert(rows.some(x=>x.id===leadId));
  assert(rows.find(x=>x.id===leadId).contact_email.includes('@example.test'));
  // Check actual database row-level security under a foreign session tenant.
  const unowned=await withTenant(pool,otherTenantId,db=>db.query('SELECT id FROM industry.cinema_leads WHERE id=$1',[leadId]));
  assert.equal(unowned.rowCount,0);
});
test('R3 state machine, optimistic versions and audit trail protect sales pipeline',async()=>{
  let row=expect(await send('GET','/cinema/leads?limit=100',owner),200).items.find(x=>x.id===leadId);
  expect(await send('PATCH','/cinema/leads/'+leadId,manager,{state:'won',expectedVersion:row.version}),409);
  const changed=expect(await send('PATCH','/cinema/leads/'+leadId,manager,{state:'contacted',expectedVersion:row.version}),200).item;
  assert.equal(changed.state,'contacted');
  expect(await send('PATCH','/cinema/leads/'+leadId,manager,{state:'qualified',expectedVersion:row.version}),409);
  const qualified=expect(await send('PATCH','/cinema/leads/'+leadId,manager,{state:'qualified',expectedVersion:changed.version,dealValueMinor:2500000}),200).item;
  const proposal=expect(await send('PATCH','/cinema/leads/'+leadId,manager,{state:'proposal',expectedVersion:qualified.version}),200).item;
  const won=expect(await send('PATCH','/cinema/leads/'+leadId,owner,{state:'won',expectedVersion:proposal.version}),200).item;
  assert.equal(won.state,'won');
  assert.equal(won.deal_value_minor,'2500000');
  expect(await send('PATCH','/cinema/leads/'+leadId,owner,{state:'contacted',expectedVersion:won.version}),409);
  const history=expect(await send('GET','/cinema/leads/'+leadId+'/history',manager),200);
  assert.equal(history.items.length,5);
  assert.deepEqual(history.items.map(x=>x.version),[1,2,3,4,5]);
});
test('R3 metrics are explicit about non-unique clicks and only manually entered amounts',async()=>{
  expect(await send('POST','/cinema/public/events',null,{eventType:'film_started',storyId:'01-restaurant'}),202);
  expect(await send('POST','/cinema/public/events',null,{eventType:'brief_created',storyId:'01-restaurant'}),202);
  const metric=expect(await send('GET','/cinema/metrics',owner),200);
  assert.equal(metric.schema,'osmanx.cinema.metrics.v1');
  assert(metric.stages.some(x=>x.state==='won' && Number(x.leads)>=1));
  assert(metric.events.some(x=>x.event_type==='film_started' && Number(x.total)>=1));
  assert.match(metric.warning,/не уникальных посетителей/);
  config(true,false);
  expect(await send('POST','/cinema/public/events',null,{eventType:'film_started'}),503);
  config(true,true);
});
test('R3 server rate limits repeated emails and allows manual erasure plus retention cleanup',async()=>{
  const customer=payload('cinema-ratelimit-'+tag+'@example.test');
  for(let i=0;i<4;i++){
    const r=await send('POST','/cinema/public/leads',null,customer,{'idempotency-key':'r3-rate-'+tag+'-'+i+'-abcdefgh'});
    assert.equal(r.statusCode,201,r.body);
  }
  expect(await send('POST','/cinema/public/leads',null,customer,{'idempotency-key':'r3-rate-'+tag+'-5-abcdefgh'}),429);
  expect(await send('DELETE','/cinema/leads/'+leadId,manager),403);
  expect(await send('DELETE','/cinema/leads/'+leadId,owner),200);
  expect(await send('GET','/cinema/leads/'+leadId+'/history',owner),404);
  const cleanup=expect(await send('POST','/cinema/retention',owner,{confirm:'ERASE_EXPIRED'}),200);
  assert.equal(cleanup.retentionDays,90);
});
