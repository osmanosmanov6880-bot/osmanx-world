// Real PostgreSQL + Fastify acceptance of CINEMA R4: tenant isolation,
// concurrent deduplication, campaigns, follow-ups and deletion.
import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {buildApp} from '../src/app.mjs';
import {makePool,withTenant} from '../src/database.mjs';
import {hashPassword} from '../src/password.mjs';
import {parseLead,parseEvent} from '../src/cinema.mjs';
import {campaignCode,planFollowup,followupWindow} from '../src/cinema-r4.mjs';
import {sweepCinemaTenant} from '../src/cinema-retention.mjs';
import {requireConfiguration} from '../scripts/cinema-retention.mjs';

const P='/api/industry/v1',suffix=randomUUID().slice(0,8);
const admin=new pg.Pool({connectionString:process.env.MIGRATION_DB_URL}),pool=makePool();
const previous=Object.fromEntries(['CINEMA_TENANT_ID','CINEMA_RATE_SECRET','CINEMA_PUBLIC_WRITE_ENABLED','CINEMA_AGGREGATE_EVENTS_ENABLED'].map(k=>[k,process.env[k]]));
const users={};let app,tenant,foreign,mainLead,actorId;
const password='CINEMA-R4-real-postgresql-Test_2026!';
const name='r4cinema-'+suffix;
const data=(campaign='moscow_launch')=>({
  storyId:'01-restaurant',contactName:'Test Cafe Owner',
  contactEmail:'r4'+suffix+'@example.test',organization:'Test Cafe',
  observation:'Visitor exits before checkout; needs verification.',
  goal:'Measure true reasons, without assumptions',source:'cinema',
  campaignCode:campaign,consent:true,website:''
});
const send=(method,path,user,payload,headers={})=>app.inject({
  method,url:P+path,
  headers:{...(user?{cookie:user.cookie,'x-csrf-token':user.csrf}:{}),...headers},
  ...(payload===undefined?{}:{payload})
});
const expect=(response,status)=>{assert.equal(response.statusCode,status,response.body);return response.json();};
const cookies=res=>{
  const rows=[].concat(res.headers['set-cookie']||[]).map(x=>x.split(';')[0]);
  const csrf=rows.find(x=>x.startsWith('osmanx_industry_csrf='));
  assert(csrf,'Missing same-site CSRF token');
  return {cookie:rows.join('; '),csrf:csrf.split('=')[1]};
};
before(async()=>{
  tenant=(await admin.query("INSERT INTO industry.tenants(slug,name,vertical) VALUES($1,'R4 test operator','cafe') RETURNING id",[name])).rows[0].id;
  foreign=(await admin.query("INSERT INTO industry.tenants(slug,name,vertical) VALUES($1,'R4 other','cafe') RETURNING id",[name+'-other'])).rows[0].id;
  for(const [kind,role,t] of [
    ['owner','owner',tenant],['manager','manager',tenant],['viewer','viewer',tenant],['other','owner',foreign]]){
    const email='r4-'+kind+'-'+suffix+'@example.test';
    const id=(await admin.query('INSERT INTO industry.accounts(email,password_hash) VALUES($1,$2) RETURNING id',[email,await hashPassword(password)])).rows[0].id;
    if(kind==='owner')actorId=id;
    await admin.query('INSERT INTO industry.memberships(tenant_id,account_id,role) VALUES($1,$2,$3)',[t,id,role]);
    users[kind]={email,slug:kind==='other'?name+'-other':name};
  }
  process.env.CINEMA_TENANT_ID=tenant;
  process.env.CINEMA_RATE_SECRET='CinemaR4-Secret-for-CI-only-long-enough-2026';
  process.env.CINEMA_PUBLIC_WRITE_ENABLED='true';
  process.env.CINEMA_AGGREGATE_EVENTS_ENABLED='true';
  app=await buildApp(pool);
  for(const user of Object.values(users)){
    const response=await send('POST','/auth/login',null,{
      tenantSlug:user.slug,email:user.email,password
    });
    expect(response,200);
    const session=cookies(response);
    user.cookie=session.cookie;
    user.csrf=session.csrf;
  }
});
after(async()=>{
  await app?.close();await pool.end();
  try{
    if(tenant&&foreign)await admin.query('DELETE FROM industry.tenants WHERE id=$1 OR id=$2',[tenant,foreign]);
    await admin.query("DELETE FROM industry.accounts WHERE email LIKE $1",['r4-%-'+suffix+'@example.test']);
  }finally{await admin.end();
    for(const [k,v] of Object.entries(previous)){
      if(v===undefined)delete process.env[k];else process.env[k]=v;
    }
  }
});
test('R4 pure campaign, deadline and operator CLI rules are fail-closed',()=>{
  assert.equal(campaignCode(undefined),'direct');
  assert.equal(campaignCode('moscow_november'),'moscow_november');
  assert.throws(()=>campaignCode('https://example.test/redirect'));
  assert.throws(()=>campaignCode('UPPERCASE'));
  assert.equal(parseLead(data(),'r4-campaign-test-'+suffix).campaignCode,'moscow_launch');
  assert.equal(parseEvent({eventType:'brief_created',campaignCode:'moscow_launch'}).campaignCode,'moscow_launch');
  assert.throws(()=>parseEvent({eventType:'film_started',campaignCode:'url space'}));
  assert.throws(()=>planFollowup({state:'new',next_action_at:null,next_action_kind:null,loss_reason_code:null},{nextActionAt:'2026-11-24T00:00:00Z'}));
  assert.throws(()=>planFollowup({state:'new',next_action_at:null,next_action_kind:null,loss_reason_code:null},{state:'lost'}));
  assert.throws(()=>planFollowup({state:'new',next_action_at:null,next_action_kind:null,loss_reason_code:null},{nextActionKind:'call',nextActionAt:'2000-01-01T00:00:00Z'}));
  assert.equal(followupWindow('today').after.length,24);
  assert.throws(()=>requireConfiguration({CINEMA_RETENTION_ENABLED:'false',CINEMA_TENANT_ID:tenant,DATABASE_URL:'postgres://safe'}));
  assert.equal(requireConfiguration({CINEMA_RETENTION_ENABLED:'true',CINEMA_TENANT_ID:tenant,DATABASE_URL:'postgres://safe'}),tenant);
});
test('R4 simultaneous replay creates one lead and does not consume eight rate slots',async()=>{
  const key='cinema-r4-concurrent-'+suffix;
  const response=await Promise.all(Array.from({length:9},()=>send('POST','/cinema/public/leads',null,data(),{'idempotency-key':key})));
  const codes=response.map(x=>x.statusCode);
  assert.equal(codes.filter(x=>x===201).length,1,JSON.stringify(codes));
  assert.equal(codes.filter(x=>x===200).length,8,JSON.stringify(codes));
  const ids=new Set(response.map(x=>x.json().reference));
  assert.equal(ids.size,1);
  mainLead=[...ids][0];
  const count=await withTenant(pool,tenant,async db=>
    db.query('SELECT count(*)::int AS n FROM industry.cinema_leads WHERE tenant_id=$1 AND idempotency_key=$2',[tenant,key]));
  assert.equal(count.rows[0].n,1);
  const rate=await withTenant(pool,tenant,async db=>db.query('SELECT max(hits)::int AS n FROM industry.cinema_rate_limits WHERE tenant_id=$1',[tenant]));
  assert.equal(rate.rows[0].n,1,'replay must not charge rate counters');
  expect(await send('POST','/cinema/public/leads',null,{...data(),observation:'Changed observation for conflicting same key'}, {'idempotency-key':key}),409);
});
test('R4 campaign attribution is tenant-scoped, consent-based and honest about events',async()=>{
  expect(await send('POST','/cinema/public/events',null,{eventType:'film_started',campaignCode:'moscow_launch'}),202);
  expect(await send('POST','/cinema/public/events',null,{eventType:'brief_created',storyId:'01-restaurant',campaignCode:'moscow_launch'}),202);
  const m=expect(await send('GET','/cinema/metrics',users.manager),200);
  assert.equal(m.schema,'osmanx.cinema.metrics.v2');
  assert(m.campaigns.some(x=>x.campaign_code==='moscow_launch'&&x.leads>=1));
  assert(m.events.some(x=>x.campaign_code==='moscow_launch'&&x.event_type==='film_started'));
  assert.match(m.warning,/не уникальных/);
  expect(await send('GET','/cinema/leads?campaign=moscow_launch',users.manager),200);
  expect(await send('GET','/cinema/leads?campaign=%3Cscript%3E',users.manager),400);
  expect(await send('GET','/cinema/leads',users.other),403);
  expect(await send('GET','/cinema/followups',users.viewer),403);
  const hidden=await withTenant(pool,foreign,db=>db.query('SELECT id FROM industry.cinema_leads WHERE id=$1',[mainLead]));
  assert.equal(hidden.rowCount,0);
});
test('R4 follows dates and coded losses; optimistic updates and history are enforced',async()=>{
  let row=expect(await send('GET','/cinema/leads',users.owner),200).items.find(x=>x.id===mainLead);
  assert(row);
  const date=new Date(Date.now()+86400000).toISOString();
  const planned=expect(await send('PATCH','/cinema/leads/'+mainLead,users.manager,{
    expectedVersion:row.version,nextActionKind:'email',nextActionAt:date
  }),200).item;
  assert.equal(planned.next_action_kind,'email');
  assert.equal(planned.next_action_at,date);
  expect(await send('PATCH','/cinema/leads/'+mainLead,users.manager,{
    expectedVersion:row.version,state:'contacted'
  }),409);
  const future=expect(await send('GET','/cinema/followups?window=next7',users.manager),200);
  assert(future.items.some(x=>x.id===mainLead));
  expect(await send('PATCH','/cinema/leads/'+mainLead,users.manager,{
    expectedVersion:planned.version,state:'lost'
  }),400);
  const closed=expect(await send('PATCH','/cinema/leads/'+mainLead,users.manager,{
    expectedVersion:planned.version,state:'lost',lossReasonCode:'timing'
  }),200).item;
  assert.equal(closed.state,'lost');assert.equal(closed.next_action_at,null);
  assert.equal(closed.loss_reason_code,'timing');
  expect(await send('PATCH','/cinema/leads/'+mainLead,users.manager,{
    expectedVersion:closed.version,nextActionAt:date,nextActionKind:'call'
  }),409);
  const history=expect(await send('GET','/cinema/leads/'+mainLead+'/history',users.owner),200).items;
  assert.equal(history.length,3);
  assert.deepEqual(history.map(x=>x.version),[1,2,3]);
  assert.equal(history[1].event_type,'followup_changed');
  assert.equal(history[2].loss_reason_code,'timing');
});
test('R4 operator-only retention clears expired records and old anonymous counts',async()=>{
  const key='cinema-r4-expired-'+suffix;
  const created=expect(await send('POST','/cinema/public/leads',null,
    {...data('old_campaign'),contactEmail:'expired-'+suffix+'@example.test'},
    {'idempotency-key':key}),201);
  // Admin is permitted to construct time-travel synthetic fixtures; runtime app is not.
  await admin.query("UPDATE industry.cinema_leads SET created_at=now()-interval '91 days' WHERE id=$1",[created.reference]);
  await admin.query("INSERT INTO industry.cinema_daily_events(tenant_id,date_utc,event_type,story_id,campaign_code,total) VALUES($1,(now() AT TIME ZONE 'UTC')::date-interval '181 days','film_started','all','old_campaign',5)",[tenant]);
  const summary=await sweepCinemaTenant(pool,tenant);
  assert(summary.erasedLeads>=1,JSON.stringify(summary));
  assert(summary.expiredMetrics>=1);
  const lookup=expect(await send('GET','/cinema/leads',users.owner),200);
  assert(!lookup.items.some(x=>x.id===created.reference));
  assert(lookup.items.some(x=>x.id===mainLead),'fresh lead must remain');
  expect(await send('POST','/cinema/retention',users.manager,{confirm:'ERASE_EXPIRED'}),403);
  const repeat=expect(await send('POST','/cinema/retention',users.owner,{confirm:'ERASE_EXPIRED'}),200);
  assert.equal(repeat.erasedLeads,0,'retention is idempotent');
});
