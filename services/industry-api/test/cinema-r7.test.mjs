// CINEMA R7 real PostgreSQL and Fastify integration, no production writes.
import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {buildApp} from '../src/app.mjs';
import {makePool,withTenant} from '../src/database.mjs';
import {hashPassword} from '../src/password.mjs';
import {claimInput,checkEventContinuity} from '../src/cinema-r7.mjs';
import {inspectCinemaR7} from '../scripts/cinema-r7-readiness.mjs';
import {canaryTarget,cinemaR7Canary} from '../scripts/cinema-r7-canary.mjs';

const P='/api/industry/v1',suffix=randomUUID().slice(0,8),users={};
const admin=new pg.Pool({connectionString:process.env.MIGRATION_DB_URL}),pool=makePool();
let app,tenant,foreign,leadId,secondLeadId,version=1;
const previous=Object.fromEntries(['CINEMA_TENANT_ID','CINEMA_RATE_SECRET','CINEMA_PUBLIC_WRITE_ENABLED','CINEMA_AGGREGATE_EVENTS_ENABLED'].map(k=>[k,process.env[k]]));
const password='CINEMA-R7-ci-safe-password-2026!!';
const payload=email=>({
  storyId:'07-coffee',contactName:'Synthetic director',contactEmail:email,
  organization:'Synthetic coffeehouse',observation:'Guests may be leaving before checkout.',
  goal:'Check the cause without guessing',source:'cinema',campaignCode:'r7_controlled',consent:true,website:''
});
const send=(method,url,user,body,headers={})=>app.inject({
  method,url:P+url,headers:{...(user?{cookie:user.cookie,'x-csrf-token':user.csrf}:{}),...headers},
  ...(body===undefined?{}:{payload:body})});
const expect=(res,status)=>{assert.equal(res.statusCode,status,res.body);return res.json();};
before(async()=>{
  tenant=(await admin.query("INSERT INTO industry.tenants(slug,name,vertical) VALUES($1,'R7 test','cafe') RETURNING id",['r7-'+suffix])).rows[0].id;
  foreign=(await admin.query("INSERT INTO industry.tenants(slug,name,vertical) VALUES($1,'R7 other','cafe') RETURNING id",['r7-other-'+suffix])).rows[0].id;
  for(const [name,role,t] of [['owner','owner',tenant],['manager','manager',tenant],['manager2','manager',tenant],['viewer','viewer',tenant],['other','owner',foreign]]){
    const email='r7-'+name+'-'+suffix+'@example.test';
    const id=(await admin.query('INSERT INTO industry.accounts(email,password_hash) VALUES($1,$2) RETURNING id',
      [email,await hashPassword(password)])).rows[0].id;
    await admin.query('INSERT INTO industry.memberships(tenant_id,account_id,role) VALUES($1,$2,$3)',[t,id,role]);
    users[name]={id,email,slug:t===tenant?'r7-'+suffix:'r7-other-'+suffix};
  }
  process.env.CINEMA_TENANT_ID=tenant;
  process.env.CINEMA_RATE_SECRET='R7-CINEMA-CI-SAFE-SECRET-EXACTLY-ENOUGH-2026';
  process.env.CINEMA_PUBLIC_WRITE_ENABLED='true';
  process.env.CINEMA_AGGREGATE_EVENTS_ENABLED='true';
  app=await buildApp(pool);
  for(const user of Object.values(users)){
    const r=await send('POST','/auth/login',null,{tenantSlug:user.slug,email:user.email,password});
    expect(r,200);
    const cookies=[].concat(r.headers['set-cookie']||[]).map(v=>v.split(';')[0]);
    const csrf=cookies.find(x=>x.startsWith('osmanx_industry_csrf='));
    assert(csrf,'Missing CSRF');
    user.cookie=cookies.join('; ');user.csrf=csrf.split('=')[1];
  }
  const email='r7-person-'+suffix+'@example.test';
  leadId=expect(await send('POST','/cinema/public/leads',null,payload(email),
    {'idempotency-key':'r7-public-'+suffix+'-first'}),201).reference;
  secondLeadId=expect(await send('POST','/cinema/public/leads',null,{
    ...payload(email),observation:'This might be a different visit, confirm manually.'
  },{'idempotency-key':'r7-public-'+suffix+'-second'}),201).reference;
});
after(async()=>{
  try{await app?.close();await pool.end();}
  finally{
    try{
      if(tenant&&foreign)await admin.query('DELETE FROM industry.tenants WHERE id=$1 OR id=$2',[tenant,foreign]);
      await admin.query('DELETE FROM industry.accounts WHERE email LIKE $1',['r7-%-'+suffix+'@example.test']);
    }finally{
      await admin.end();
      for(const [k,v] of Object.entries(previous)){if(v===undefined)delete process.env[k];else process.env[k]=v;}
    }
  }
});
test('R7 validates claim input and checks simple version continuity without claiming crypto proof',()=>{
  assert.equal(claimInput({expectedVersion:1,action:'claim'}).action,'claim');
  assert.throws(()=>claimInput({expectedVersion:1,action:'claim',isAdmin:true}));
  assert.throws(()=>claimInput({expectedVersion:0,action:'release'}));
  assert.equal(checkEventContinuity(2,{event_count:2,first_version:1,last_version:2}).complete,true);
  assert.equal(checkEventContinuity(3,{event_count:2,first_version:1,last_version:3}).complete,false);
});
test('R7 two competing managers: exactly one atomic claim; foreign and viewer denied',async()=>{
  expect(await send('POST','/cinema/leads/'+leadId+'/claim',users.viewer,{expectedVersion:1,action:'claim'}),403);
  expect(await send('POST','/cinema/leads/'+leadId+'/claim',users.other,{expectedVersion:1,action:'claim'}),403);
  const responses=await Promise.all([
    send('POST','/cinema/leads/'+leadId+'/claim',users.manager,{expectedVersion:1,action:'claim'}),
    send('POST','/cinema/leads/'+leadId+'/claim',users.manager2,{expectedVersion:1,action:'claim'})
  ]);
  assert.deepEqual(responses.map(x=>x.statusCode).sort(),[200,409]);
  const success=responses.find(x=>x.statusCode===200).json();
  assert([users.manager.id,users.manager2.id].includes(success.item.assigned_to));
  const winning=success.item.assigned_to===users.manager.id?'manager':'manager2';
  const losing=winning==='manager'?'manager2':'manager';
  version=success.item.version;
  assert.equal(version,2);
  // Unprivileged manager cannot use the legacy PATCH route to take over another's lead.
  expect(await send('PATCH','/cinema/leads/'+leadId,users[losing],
    {expectedVersion:version,assignedTo:users[losing].id}),403);
  expect(await send('POST','/cinema/leads/'+leadId+'/claim',users[losing],
    {expectedVersion:version,action:'release'}),403);
  expect(await send('POST','/cinema/leads/'+leadId+'/claim',users[winning],
    {expectedVersion:version-1,action:'release'}),409);
  const released=expect(await send('POST','/cinema/leads/'+leadId+'/claim',users[winning],
    {expectedVersion:version,action:'release'}),200).item;
  version=released.version;
  assert.equal(released.assigned_to,null);
  const claimed=expect(await send('POST','/cinema/leads/'+leadId+'/claim',users[losing],
    {expectedVersion:version,action:'claim'}),200).item;
  version=claimed.version;
  assert.equal(claimed.assigned_to,users[losing].id);
  const events=expect(await send('GET','/cinema/leads/'+leadId+'/history',users.owner),200).items;
  assert.equal(events.filter(x=>x.event_type==='assigned_changed').length,3);
  const load=expect(await send('GET','/cinema/team/workload',users.owner),200);
  assert(load.items.some(x=>x.id===users[losing].id&&x.active>=1));
  expect(await send('GET','/cinema/team/workload',users.viewer),403);
  expect(await send('GET','/cinema/team/workload',users.other),403);
});
test('R7 duplicate lookup matches same-tenant exact email, never merges records',async()=>{
  const duplicates=expect(await send('GET','/cinema/leads/'+leadId+'/similar',users.manager),200);
  assert.equal(duplicates.total,1);
  assert.equal(duplicates.items[0].id,secondLeadId);
  assert.equal(duplicates.matchBasis,'exact_email_only');
  assert(!JSON.stringify(duplicates.items).includes('contact_email'));
  const none=expect(await send('GET','/cinema/leads/'+secondLeadId+'/similar',users.owner),200);
  assert.equal(none.total,1);
  expect(await send('GET','/cinema/leads/'+leadId+'/similar',users.viewer),403);
  expect(await send('GET','/cinema/leads/'+leadId+'/similar',users.other),403);
});
test('R7 owner audit detects injected gaps; manager is denied independent audit',async()=>{
  const report=expect(await send('GET','/cinema/leads/'+leadId+'/audit-integrity',users.owner),200);
  assert.equal(report.complete,true);
  assert.equal(report.eventCount,version);
  assert.match(report.proofLevel,/not_cryptographic/);
  expect(await send('GET','/cinema/leads/'+leadId+'/audit-integrity',users.manager),403);
  // Construct isolated synthetic corruption with migration role; app role cannot alter events.
  await admin.query(
    "INSERT INTO industry.cinema_lead_events(tenant_id,lead_id,event_type,old_state,new_state,version) VALUES($1,$2,'state_changed','new','new',999)",
    [tenant,leadId]);
  const broken=expect(await send('GET','/cinema/leads/'+leadId+'/audit-integrity',users.owner),200);
  assert.equal(broken.complete,false);
  await admin.query("DELETE FROM industry.cinema_lead_events WHERE tenant_id=$1 AND lead_id=$2 AND version=999",[tenant,leadId]);
  assert.equal(expect(await send('GET','/cinema/leads/'+leadId+'/audit-integrity',users.owner),200).complete,true);
});
test('R7 private subject email lookup POST uses CSRF and keeps legacy GET',async()=>{
  const email='r7-person-'+suffix+'@example.test';
  const r=await send('POST','/cinema/privacy/search',users.owner,{email});
  const results=expect(r,200);
  assert.equal(results.items.length,2);
  assert.match(r.headers['cache-control'],/no-store/);
  expect(await send('POST','/cinema/privacy/search',users.manager,{email}),403);
  expect(await send('POST','/cinema/privacy/search',users.other,{email}),403);
  expect(await send('POST','/cinema/privacy/search',users.owner,{email,debug:true}),400);
  const missingCsrf=await app.inject({method:'POST',url:P+'/cinema/privacy/search',
    headers:{cookie:users.owner.cookie},payload:{email}});
  assert.equal(missingCsrf.statusCode,403);
  const old=await send('GET','/cinema/privacy/search?email='+encodeURIComponent(email),users.owner);
  expect(old,200);
  assert.equal(old.headers.deprecation,'true');
});
test('R7 read-only preflight and loopback canary refuse any live write configuration',async()=>{
  const preflight=await inspectCinemaR7(pool,{CINEMA_TENANT_ID:tenant,
    CINEMA_RATE_SECRET:'A-long-ci-secret-for-r7-at-least-thirty-two',
    CINEMA_PUBLIC_WRITE_ENABLED:'false',CINEMA_AGGREGATE_EVENTS_ENABLED:'false'});
  assert.equal(preflight.checks.r7Index,true);
  assert.equal(preflight.checks.publicIntakeOff,true);
  assert.equal(preflight.checks.r7OperatorReviewed,false);
  assert.equal(preflight.go,false);
  assert.throws(()=>canaryTarget('https://osmanx.world'));
  assert.throws(()=>canaryTarget('http://host.example'));
  assert.throws(()=>canaryTarget('http://127.0.0.1:3149/@other'));
  const fake=async(url,opts)=>{
    const path=new URL(url).pathname;
    let status=401,body={error:'unauthorized'};
    if(path.endsWith('/health/live')){status=200;body={status:'live'};}
    if(path.endsWith('/cinema/public/config')){status=200;body={intakeEnabled:false,aggregateEventsEnabled:false};}
    if(path.endsWith('/cinema/public/leads')){status=503;body={error:'disabled'};}
    return {status,async json(){return body;}};
  };
  const summary=await cinemaR7Canary({fetcher:fake});
  assert(summary.safe);
  assert.equal(summary.checks.anonymousPrivateRoutesDenied,4);
  const unsafe=async(url,opts)=>{
    const response=await fake(url,opts);
    if(url.endsWith('/cinema/public/config'))return {status:200,async json(){
      return {intakeEnabled:true,aggregateEventsEnabled:false};}};
    return response;
  };
  await assert.rejects(()=>cinemaR7Canary({fetcher:unsafe}),/NO-GO/);
});
