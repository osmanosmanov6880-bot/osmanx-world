// R5 integration: isolated PostgreSQL 16, RLS, authenticated real Fastify handlers.
import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {buildApp} from '../src/app.mjs';
import {makePool,withTenant} from '../src/database.mjs';
import {hashPassword} from '../src/password.mjs';
import {parseContactActivity,assigneeValue,exactEmail,reportDays} from '../src/cinema-r5.mjs';
import {inspectCinemaR5} from '../scripts/cinema-r5-readiness.mjs';

const P='/api/industry/v1',tag=randomUUID().slice(0,8);
const admin=new pg.Pool({connectionString:process.env.MIGRATION_DB_URL});
const pool=makePool(),users={};
const previous=Object.fromEntries(['CINEMA_TENANT_ID','CINEMA_RATE_SECRET','CINEMA_PUBLIC_WRITE_ENABLED','CINEMA_AGGREGATE_EVENTS_ENABLED'].map(k=>[k,process.env[k]]));
const password='R5-evidence-CI-2026-Strong-Pass!';
let app,tenant,other,leadId;
const p=(email='r5-client-'+tag+'@example.test')=>({
  storyId:'07-coffee',contactName:'Test Coffee',contactEmail:email,
  organization:'Test Coffeehouse',observation:'Visitors leave before they are served.',
  goal:'Measure waiting time and check staff suggestions',source:'cinema',
  campaignCode:'r5_fieldwork',consent:true,website:''
});
function send(method,url,user,payload,extra={}){
  return app.inject({method,url:P+url,headers:{
    ...(user?{cookie:user.cookie,'x-csrf-token':user.csrf}:{}),...extra
  },...(payload===undefined?{}:{payload})});
}
function expect(res,status){assert.equal(res.statusCode,status,res.body);return res.json();}
before(async()=>{
  tenant=(await admin.query("INSERT INTO industry.tenants(slug,name,vertical) VALUES($1,'R5 operator test','cafe') RETURNING id",['r5-'+tag])).rows[0].id;
  other=(await admin.query("INSERT INTO industry.tenants(slug,name,vertical) VALUES($1,'R5 other test','cafe') RETURNING id",['r5-other-'+tag])).rows[0].id;
  for(const [name,role,tid] of [['owner','owner',tenant],['manager','manager',tenant],['viewer','viewer',tenant],['outsider','owner',other]]){
    const email='r5-'+name+'-'+tag+'@example.test';
    const id=(await admin.query('INSERT INTO industry.accounts(email,password_hash) VALUES($1,$2) RETURNING id',[email,await hashPassword(password)])).rows[0].id;
    await admin.query('INSERT INTO industry.memberships(tenant_id,account_id,role) VALUES($1,$2,$3)',[tid,id,role]);
    users[name]={id,email,slug:tid===tenant?'r5-'+tag:'r5-other-'+tag};
  }
  process.env.CINEMA_TENANT_ID=tenant;
  process.env.CINEMA_RATE_SECRET='CINEMA_R5_CI_SECRET_2026_LONG_ENOUGH_TEST_ONLY';
  process.env.CINEMA_PUBLIC_WRITE_ENABLED='true';
  process.env.CINEMA_AGGREGATE_EVENTS_ENABLED='true';
  app=await buildApp(pool);
  for(const user of Object.values(users)){
    const login=await send('POST','/auth/login',null,{tenantSlug:user.slug,email:user.email,password});
    expect(login,200);
    const cookies=[].concat(login.headers['set-cookie']||[]).map(x=>x.split(';')[0]);
    const token=cookies.find(x=>x.startsWith('osmanx_industry_csrf='));
    assert(token,'CSRF cookie absent');user.cookie=cookies.join('; ');user.csrf=token.split('=')[1];
  }
});
after(async()=>{
  try{await app?.close();await pool.end();}
  finally{
    try{
      if(tenant&&other)await admin.query('DELETE FROM industry.tenants WHERE id=$1 OR id=$2',[tenant,other]);
      await admin.query('DELETE FROM industry.accounts WHERE email LIKE $1',['r5-%-'+tag+'@example.test']);
    }finally{
      await admin.end();
      for(const [key,val] of Object.entries(previous)){
        if(val===undefined)delete process.env[key];else process.env[key]=val;
      }
    }
  }
});
test('R5 parses all sensitive inputs conservatively',()=>{
  assert.equal(reportDays(undefined),30);
  assert.equal(reportDays('90'),90);
  assert.throws(()=>reportDays(365));
  assert.throws(()=>reportDays('3e1'));
  assert.throws(()=>exactEmail('bad@example.test?x=1'));
  assert.equal(exactEmail(' TEST@example.test '),'test@example.test');
  assert.equal(assigneeValue(null),null);
  assert.throws(()=>assigneeValue('not a uuid'));
  assert.equal(parseContactActivity({expectedVersion:1,channel:'whatsapp',outcome:'no_reply',completeFollowup:true}).completeFollowup,true);
  assert.throws(()=>parseContactActivity({expectedVersion:1,channel:'whatsapp',outcome:'connected',note:'secret'}));
});
test('R5 routes remain private and assign only currently active same-tenant staff',async()=>{
  const key='r5-contact-first-'+tag;
  const created=expect(await send('POST','/cinema/public/leads',null,p(),{'idempotency-key':key}),201);
  leadId=created.reference;
  expect(await send('GET','/cinema/assignees',null),401);
  expect(await send('GET','/cinema/assignees',users.viewer),403);
  expect(await send('GET','/cinema/assignees',users.outsider),403);
  const people=expect(await send('GET','/cinema/assignees',users.manager),200).items;
  assert(people.some(x=>x.id===users.owner.id));
  assert(people.some(x=>x.id===users.manager.id));
  assert(!people.some(x=>x.id===users.viewer.id));
  let version=1;
  expect(await send('PATCH','/cinema/leads/'+leadId,users.manager,{expectedVersion:version,assignedTo:users.viewer.id}),400);
  expect(await send('PATCH','/cinema/leads/'+leadId,users.manager,{expectedVersion:version,assignedTo:users.outsider.id}),400);
  const set=expect(await send('PATCH','/cinema/leads/'+leadId,users.manager,{expectedVersion:version,assignedTo:users.manager.id}),200);
  assert.equal(set.item.assigned_to,users.manager.id);version=set.item.version;
  expect(await send('PATCH','/cinema/leads/'+leadId,users.owner,{expectedVersion:version-1,assignedTo:null}),409);
  const list=expect(await send('GET','/cinema/leads',users.owner),200);
  assert.equal(list.items.find(x=>x.id===leadId).assigned_to,users.manager.id);
  const fromOther=await withTenant(pool,other,db=>db.query('SELECT id FROM industry.cinema_leads WHERE id=$1',[leadId]));
  assert.equal(fromOther.rowCount,0);
});
test('R5 contact attempts are counted, connected is a separate manually recorded event',async()=>{
  const row=expect(await send('GET','/cinema/leads',users.manager),200).items.find(x=>x.id===leadId);
  const scheduled=new Date(Date.now()+86400000).toISOString();
  const plan=expect(await send('PATCH','/cinema/leads/'+leadId,users.manager,{
    expectedVersion:row.version,nextActionAt:scheduled,nextActionKind:'email'
  }),200).item;
  expect(await send('POST','/cinema/leads/'+leadId+'/contacts',users.viewer,{
    expectedVersion:plan.version,channel:'email',outcome:'attempted'
  }),403);
  const tried=expect(await send('POST','/cinema/leads/'+leadId+'/contacts',users.manager,{
    expectedVersion:plan.version,channel:'email',outcome:'no_reply',completeFollowup:true
  }),200);
  assert.equal(tried.item.contact_count,1);
  assert.equal(tried.item.first_contact_at,null);
  assert.equal(tried.item.next_action_at,null);
  assert.equal(tried.verification,'manual_manager_record');
  expect(await send('POST','/cinema/leads/'+leadId+'/contacts',users.manager,{
    expectedVersion:plan.version,channel:'phone',outcome:'connected'
  }),409);
  const reached=expect(await send('POST','/cinema/leads/'+leadId+'/contacts',users.owner,{
    expectedVersion:tried.item.version,channel:'phone',outcome:'connected'
  }),200);
  assert.equal(reached.item.contact_count,2);
  assert(reached.item.first_contact_at);
  const history=expect(await send('GET','/cinema/leads/'+leadId+'/history',users.owner),200).items;
  const contacts=history.filter(x=>x.event_type==='contact_logged');
  assert.equal(contacts.length,2);
  assert.deepEqual(contacts.map(x=>x.contact_outcome),['no_reply','connected']);
  assert(contacts.every(x=>!('contact_message' in x)));
});
test('R5 performance measures actual leads separately from anonymous view actions',async()=>{
  expect(await send('POST','/cinema/public/events',null,{eventType:'film_started',storyId:'07-coffee',campaignCode:'r5_fieldwork'}),202);
  const perf=expect(await send('GET','/cinema/performance?days=30',users.manager),200);
  assert.equal(perf.schema,'osmanx.cinema.performance.v1');
  const campaign=perf.campaigns.find(x=>x.campaign_code==='r5_fieldwork');
  assert(campaign&&campaign.leads===1);
  assert.equal(campaign.with_attempt,1);
  assert.equal(campaign.connected,1);
  assert.equal(Number(campaign.attempts),2);
  assert(perf.actions.some(x=>x.campaign_code==='r5_fieldwork'&&x.event_type==='film_started'));
  assert.match(perf.measurement.actions,/НЕ уникальные/);
  expect(await send('GET','/cinema/performance?days=3',users.manager),400);
  expect(await send('GET','/cinema/performance',users.viewer),403);
  expect(await send('GET','/cinema/performance',users.outsider),403);
});
test('R5 subject rights allow exact owner lookup and JSON export, deny manager and foreign tenant',async()=>{
  const email='r5-client-'+tag+'@example.test';
  expect(await send('GET','/cinema/privacy/search?email='+encodeURIComponent(email),users.manager),403);
  expect(await send('GET','/cinema/privacy/search?email='+encodeURIComponent(email),users.outsider),403);
  const list=expect(await send('GET','/cinema/privacy/search?email='+encodeURIComponent(email),users.owner),200);
  assert(list.requiresIdentityVerification);
  assert.equal(list.items.length,1);assert.equal(list.items[0].id,leadId);
  expect(await send('GET','/cinema/privacy/search?email=r5-client',users.owner),400);
  expect(await send('GET','/cinema/leads/'+leadId+'/export',users.manager),403);
  expect(await send('GET','/cinema/leads/'+leadId+'/export',users.outsider),403);
  const resp=await send('GET','/cinema/leads/'+leadId+'/export',users.owner);
  const exported=expect(resp,200);
  assert.equal(exported.lead.contact_email,email);
  assert.equal(exported.verifiedByOperator,false);
  assert(!('idempotency_key' in exported.lead));
  assert.equal(exported.events.some(x=>x.contact_outcome==='connected'),true);
  assert.match(resp.headers['cache-control'],/no-store/);
});
test('R5 infrastructure gate checks migration and staff; no automatic activation',async()=>{
  const gate=await inspectCinemaR5(pool,{CINEMA_TENANT_ID:tenant,CINEMA_RATE_SECRET:'Strong-test-secret-r5-at-least-thirty-two-chars'});
  assert.equal(gate.checks.r5Schema,true);
  assert.equal(gate.checks.r5Staff,true);
  assert.equal(gate.go,false);
  assert.equal(gate.checks.r5Review,false);
  expect(await send('DELETE','/cinema/leads/'+leadId,users.manager),403);
  expect(await send('DELETE','/cinema/leads/'+leadId,users.owner),200);
  expect(await send('GET','/cinema/leads/'+leadId+'/export',users.owner),404);
});
