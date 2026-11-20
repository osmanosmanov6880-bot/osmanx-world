// CINEMA R8: transaction-backed retention evidence and owner-only bulk export.
import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {buildApp} from '../src/app.mjs';
import {makePool,withTenant} from '../src/database.mjs';
import {hashPassword} from '../src/password.mjs';
import {sweepCinemaTenant} from '../src/cinema-retention.mjs';
import {approveExportInput,runtimeStatus,retentionAssessment} from '../src/cinema-r8.mjs';
import {inspectCinemaR8} from '../scripts/cinema-r8-readiness.mjs';
import {cinemaR8Canary} from '../scripts/cinema-r8-canary.mjs';
const P='/api/industry/v1',suffix=randomUUID().slice(0,8),users={},password='CINEMA-R8-safe-unit-2026-Strong!';
const admin=new pg.Pool({connectionString:process.env.MIGRATION_DB_URL}),pool=makePool();
let app,tenant,foreign,leadId,foreignId;
const keys=['CINEMA_TENANT_ID','CINEMA_RATE_SECRET','CINEMA_PUBLIC_WRITE_ENABLED','CINEMA_AGGREGATE_EVENTS_ENABLED'];
const previous=Object.fromEntries(keys.map(x=>[x,process.env[x]]));
function send(method,url,user,payload,headers={}){
  return app.inject({method,url:P+url,headers:{
    ...(user?{cookie:user.cookie,'x-csrf-token':user.csrf}:{}),...headers},
    ...(payload===undefined?{}:{payload})});
}
const expect=(res,status)=>{assert.equal(res.statusCode,status,res.body);return res.json();};
before(async()=>{
  tenant=(await admin.query("INSERT INTO industry.tenants(slug,name,vertical) VALUES($1,'R8 test','cafe') RETURNING id",['r8-'+suffix])).rows[0].id;
  foreign=(await admin.query("INSERT INTO industry.tenants(slug,name,vertical) VALUES($1,'R8 foreign test','cafe') RETURNING id",['r8-foreign-'+suffix])).rows[0].id;
  for(const [name,role,t] of [['owner','owner',tenant],['manager','manager',tenant],['viewer','viewer',tenant],['foreign','owner',foreign]]){
    const email='r8-'+name+'-'+suffix+'@example.test';
    const id=(await admin.query('INSERT INTO industry.accounts(email,password_hash) VALUES($1,$2) RETURNING id',
      [email,await hashPassword(password)])).rows[0].id;
    await admin.query('INSERT INTO industry.memberships(tenant_id,account_id,role) VALUES($1,$2,$3)',[t,id,role]);
    users[name]={id,email,slug:t===tenant?'r8-'+suffix:'r8-foreign-'+suffix};
  }
  process.env.CINEMA_TENANT_ID=tenant;
  process.env.CINEMA_RATE_SECRET='R8-staging-ci-secret-only-at-least-thirtytwo';
  process.env.CINEMA_PUBLIC_WRITE_ENABLED='true';
  process.env.CINEMA_AGGREGATE_EVENTS_ENABLED='true';
  app=await buildApp(pool);
  for(const user of Object.values(users)){
    const login=expect(await send('POST','/auth/login',null,
      {tenantSlug:user.slug,email:user.email,password}),200);
    const cookies=[].concat((await app.inject({method:'POST',url:P+'/auth/login',
      payload:{tenantSlug:user.slug,email:user.email,password}})).headers['set-cookie']||[])
      .map(x=>x.split(';')[0]);
    const csrf=cookies.find(x=>x.startsWith('osmanx_industry_csrf='));
    assert(csrf);user.cookie=cookies.join('; ');user.csrf=csrf.split('=')[1];
  }
  const lead=(await send('POST','/cinema/public/leads',null,{
    storyId:'07-coffee',contactName:'Synthetic R8',contactEmail:'r8-client-'+suffix+'@example.test',
    organization:'Synthetic coffee',observation:'Test drop in repeat visitors',source:'cinema',
    campaignCode:'r8_integrity',consent:true,website:''
  },{'idempotency-key':'r8-public-'+suffix+'-first'}));
  leadId=expect(lead,201).reference;
  foreignId=(await withTenant(pool,foreign,db=>db.query(
    "INSERT INTO industry.cinema_leads(tenant_id,contact_name,contact_email,story_id,observation,source,idempotency_key,payload_digest) VALUES($1,'Foreign synthetic','other@example.test','07-coffee','Only staging data','cinema',$2,repeat('a',64)) RETURNING id",
    [foreign,'r8-foreign-'+suffix+'-entry']))).rows[0].id;
});
after(async()=>{
  try{await app?.close();await pool.end();}
  finally{
    try{
      if(tenant&&foreign)await admin.query('DELETE FROM industry.tenants WHERE id=$1 OR id=$2',[tenant,foreign]);
      await admin.query('DELETE FROM industry.accounts WHERE email LIKE $1',['r8-%-'+suffix+'@example.test']);
    }finally{
      await admin.end();
      for(const [key,value] of Object.entries(previous)){
        if(value===undefined)delete process.env[key];else process.env[key]=value;
      }
    }
  }
});
test('R8 strict owner export IDs and public truthful runtime',async()=>{
  assert.deepEqual(approveExportInput({confirm:'EXPORT_LOADED',leadIds:[leadId.toUpperCase()]}),[leadId]);
  assert.throws(()=>approveExportInput({confirm:'EXPORT_LOADED',leadIds:[leadId,leadId]}));
  assert.throws(()=>approveExportInput({confirm:'EXPORT_LOADED',leadIds:[]}));
  assert.throws(()=>approveExportInput({confirm:'EXPORT_LOADED',leadIds:[leadId],email:'leak@example.test'}));
  const runtime=expect(await send('GET','/cinema/public/runtime',null),200);
  assert.equal(runtime.apiRelease,'r8');
  assert.equal(runtime.onlineIntakeEnabled,true);
  assert.equal(runtime.capabilities.ownerCsvApproval,true);
  assert(!JSON.stringify(runtime).includes(tenant));
  assert(!JSON.stringify(runtime).includes('RATE_SECRET'));
  assert.equal(runtimeStatus({enabled:false,metrics:false,configured:false}).onlineIntakeEnabled,false);
});
test('R8 bulk CSV must be owner-approved, tenant-bound and auditable without PII',async()=>{
  expect(await send('POST','/cinema/exports/approve',null,{confirm:'EXPORT_LOADED',leadIds:[leadId]}),401);
  expect(await send('POST','/cinema/exports/approve',users.manager,{confirm:'EXPORT_LOADED',leadIds:[leadId]}),403);
  expect(await send('POST','/cinema/exports/approve',users.viewer,{confirm:'EXPORT_LOADED',leadIds:[leadId]}),403);
  expect(await send('POST','/cinema/exports/approve',users.foreign,{confirm:'EXPORT_LOADED',leadIds:[leadId]}),403);
  expect(await send('POST','/cinema/exports/approve',users.owner,{confirm:'EXPORT_LOADED',leadIds:[foreignId]}),409);
  expect(await send('POST','/cinema/exports/approve',users.owner,{confirm:'EXPORT_LOADED',leadIds:[leadId,leadId]}),400);
  expect(await send('POST','/cinema/exports/approve',users.owner,{confirm:'EXPORT_LOADED',leadIds:[leadId],extra:true}),400);
  const approved=expect(await send('POST','/cinema/exports/approve',users.owner,{confirm:'EXPORT_LOADED',leadIds:[leadId]}),200);
  assert.equal(approved.approvedCount,1);
  assert(!JSON.stringify(approved).includes('contact_email'));
  const audit=await withTenant(pool,tenant,db=>db.query(
    "SELECT action,actor_id,lead_id,result_count FROM industry.cinema_access_events WHERE tenant_id=$1 AND action='bulk_export_authorized'",
    [tenant]));
  assert.equal(audit.rowCount,1);
  assert.equal(audit.rows[0].actor_id,users.owner.id);
  assert.equal(audit.rows[0].lead_id,null);
  assert.equal(audit.rows[0].result_count,1);
  const foreignAudit=await withTenant(pool,foreign,db=>db.query(
    "SELECT count(*)::int AS n FROM industry.cinema_access_events WHERE action='bulk_export_authorized'"
  ));
  assert.equal(foreignAudit.rows[0].n,0);
});
test('R8 retention is recorded atomically and reported honestly only to the owner',async()=>{
  let health=expect(await send('GET','/cinema/ops/preflight',users.owner),200);
  assert.equal(health.apiRelease,'r8');
  assert.equal(health.retention.assessment.status,'not_observed');
  expect(await send('GET','/cinema/ops/preflight',users.manager),403);
  expect(await send('GET','/cinema/ops/preflight',users.foreign),403);
  const run=await sweepCinemaTenant(pool,tenant);
  assert.equal(run.retentionRecorded,true);
  health=expect(await send('GET','/cinema/ops/preflight',users.owner),200);
  assert.equal(health.retention.assessment.status,'recent');
  assert(health.retention.lastExecution.executed_at);
  assert.equal(health.leads.total,1);
  const traces=await withTenant(pool,tenant,db=>db.query(
    'SELECT count(*)::int AS n FROM industry.cinema_retention_runs'
  ));
  assert.equal(traces.rows[0].n,1);
  assert.equal(retentionAssessment(null,0).status,'not_observed');
  assert.equal(retentionAssessment(new Date(Date.now()-49*3600000).toISOString(),0).status,'stale');
  const gate=await inspectCinemaR8(pool,{CINEMA_TENANT_ID:tenant,
    CINEMA_RATE_SECRET:'R8-test-secret-thirtytwo-characters',
    CINEMA_PUBLIC_WRITE_ENABLED:'false',CINEMA_AGGREGATE_EVENTS_ENABLED:'false'});
  assert.equal(gate.checks.r8ReceiptRls,true);
  assert.equal(gate.checks.r8AuditAction,true);
  assert.equal(gate.checks.r8RecentRetentionObserved,true);
  assert.equal(gate.go,false);
});
test('R8 canary fails closed if runtime release or collection flags are inconsistent',async()=>{
  const fake=async(url,options)=>{
    const path=new URL(url).pathname;
    let status=401,body={error:'unauthorized'};
    if(path.endsWith('/health/live')){status=200;body={status:'live'};}
    if(path.endsWith('/cinema/public/config')){status=200;body={intakeEnabled:false,aggregateEventsEnabled:false};}
    if(path.endsWith('/cinema/public/leads')){status=503;body={error:'intake-disabled'};}
    if(path.endsWith('/cinema/public/runtime')){status=200;body=runtimeStatus({enabled:false,metrics:false,configured:true});}
    if(path.endsWith('/cinema/exports/approve')){status=404;body={error:'not found'};}
    return {status,async json(){return body;}};
  };
  const verified=await cinemaR8Canary({fetcher:fake});
  assert.equal(verified.safe,true);
  assert.equal(verified.checks.bulkExportNotExposed,true);
  const bad=async(url,opts)=>{
    const response=await fake(url,opts);
    if(url.endsWith('/cinema/public/runtime'))return {status:200,async json(){
      return runtimeStatus({enabled:true,metrics:true,configured:true});}};
    return response;
  };
  await assert.rejects(()=>cinemaR8Canary({fetcher:bad}),/NO-GO/);
});
