// R19 live Fastify/PostgreSQL exercise, entirely synthetic and loopback-only.
// Separate disposable DB prevents previous R17/R18 monotonic fences from being reset.
import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import pg from 'pg';
import {hashPassword} from '../src/password.mjs';
import {makePool} from '../src/database.mjs';
import {buildApp} from '../src/app.mjs';
import {syntheticR19} from './r19-synthetic-fixture.mjs';
import {stopR19} from '../scripts/r19-operator.mjs';
import {rehearseR23TenantIsolation} from '../scripts/r23-tenant-isolation.mjs';

const API='/api/industry/v1',ORIGIN='https://osmanx.world';
const tag=randomUUID().slice(0,8);
const pass='R19-Temporary-Synthetic-Owner-2026!';
const tenants=[
  {slug:'r19-first-'+tag,email:'r19-first-'+tag+'@example.test'},
  {slug:'r19-second-'+tag,email:'r19-second-'+tag+'@example.test'}
];
const envKeys=['NODE_ENV','ALLOWED_ORIGIN','GUEST_WRITES_ENABLED','GUEST_RELEASE_COMMIT',
  'GUEST_R16_REGISTRY_FILE','GUEST_R16_OWNER_PUBLIC_KEY',
  'GUEST_R16_MANAGER_PUBLIC_KEY','GUEST_R16_MIN_REVISION',
  'GUEST_R17_JOURNAL_FILE','GUEST_R17_OWNER_WITNESS_FILE',
  'GUEST_R17_MANAGER_WITNESS_FILE','GUEST_R17_OWNER_PUBLIC_KEY',
  'GUEST_R17_MANAGER_PUBLIC_KEY','GUEST_R17_MIN_SEQUENCE',
  'GUEST_R17_MIN_REVISION','GUEST_R18_ANCHOR_FILE',
  'GUEST_R18_CUSTODIAN_PUBLIC_KEY','GUEST_R18_MIN_REVISION',
  'GUEST_R18_MIN_SEQUENCE','GUEST_R19_SCOPE_FILE',
  'GUEST_R19_OPERATOR_PUBLIC_KEY','GUEST_R19_STOP_FILE',
  'GUEST_R19_MIN_SEQUENCE','GUEST_R19_ROLLOUT_ENABLED'];
const prev=Object.fromEntries(envKeys.map(key=>[key,process.env[key]]));
const rootAdmin=new pg.Pool({connectionString:process.env.MIGRATION_DB_URL});
let app,pool,admin,dbName,fixture,url,pilotRow,firstDate,secondDate,thirdDate;
function dateAt(offset){
  return new Date(Date.now()+offset*86400000).toISOString().slice(0,10);
}
async function call(method,path,auth,body,headers={}){
  const response=await fetch(url+API+path,{
    method,redirect:'error',cache:'no-store',
    headers:{Accept:'application/json',
      ...(body===undefined?{}:{'Content-Type':'application/json'}),
      ...(method==='GET'?{}:{Origin:ORIGIN}),
      ...(auth?{Cookie:auth.cookie,'X-CSRF-Token':auth.csrf}:{}),...headers},
    ...(body===undefined?{}:{body:JSON.stringify(body)})
  });
  return {status:response.status,json:await response.json(),headers:response.headers};
}
function expect(response,status){
  assert.equal(response.status,status,JSON.stringify(response.json));
  return response.json;
}
function session(result){
  const cookies=result.headers.getSetCookie().map(x=>x.split(';')[0]);
  const csrf=cookies.find(x=>x.startsWith('__Host-osmanx_industry_csrf='));
  assert.ok(csrf&&cookies.some(x=>x.startsWith('__Host-osmanx_industry_sid=')));
  return {cookie:cookies.join('; '),csrf:csrf.split('=')[1]};
}
async function usage(){
  const [daily,events]=await Promise.all([
    admin.query('SELECT used_count,max_daily FROM industry.guest_r19_daily_usage'),
    admin.query('SELECT id FROM industry.guest_r19_collection_events')
  ]);
  return {used:Number(daily.rows[0]?.used_count??0),
    maxDaily:Number(daily.rows[0]?.max_daily??0),events:events.rowCount};
}
async function fences(){
  const [a,b]=await Promise.all([
    admin.query('SELECT max_sequence FROM industry.guest_registry_checkpoint_fence WHERE id=1'),
    admin.query('SELECT max_sequence FROM industry.guest_external_anchor_fence WHERE id=1')
  ]);
  return {r17:Number(a.rows[0].max_sequence),r18:Number(b.rows[0].max_sequence)};
}
before(async()=>{
  const migrate=new URL(process.env.MIGRATION_DB_URL||'');
  const runtime=new URL(process.env.DATABASE_URL||'');
  if(process.env.NODE_ENV!=='test'||migrate.hostname!=='127.0.0.1'||
    runtime.hostname!=='127.0.0.1'||migrate.pathname!=='/industry_ci'||
    runtime.pathname!=='/industry_ci')
    throw Error('R19 HTTP tests require local synthetic industry_ci, never production');
  dbName='industry_r19_'+randomUUID().replaceAll('-','').slice(0,12);
  await rootAdmin.query('CREATE DATABASE "'+dbName+'"');
  migrate.pathname='/'+dbName;
  runtime.pathname='/'+dbName;
  admin=new pg.Pool({connectionString:migrate.toString()});
  execFileSync(process.execPath,['scripts/migrate.mjs'],{
    cwd:fileURLToPath(new URL('../',import.meta.url)),
    env:{...process.env,MIGRATION_DB_URL:migrate.toString()},
    stdio:'pipe'
  });
  pool=makePool(runtime.toString());
  for(const t of tenants){
    t.tenantId=(await admin.query(
      "INSERT INTO industry.tenants(slug,name,vertical) VALUES($1,$2,'cafe') RETURNING id",
      [t.slug,t.slug])).rows[0].id;
    t.accountId=(await admin.query(
      'INSERT INTO industry.accounts(email,password_hash) VALUES($1,$2) RETURNING id',
      [t.email,await hashPassword(pass)])).rows[0].id;
    await admin.query(
      "INSERT INTO industry.memberships(tenant_id,account_id,role) VALUES($1,$2,'owner')",
      [t.tenantId,t.accountId]);
  }
  firstDate=dateAt(-2);secondDate=dateAt(-1);thirdDate=dateAt(0);
  const protocol={
    startDate:dateAt(-5),endDate:dateAt(5),outcomeWindowDays:7,
    allocation:'random',source:'pos',primaryMetric:'repeat_visit'
  };
  const previouslyRegistered=new Date(Date.now()-7*86400000);
  const ready={
    repeatDefinition:true,sameWindow:true,independentGroups:true,
    marginVerified:true,contactConsent:true,ownerAgreed:true
  };
  pilotRow=(await admin.query(
    "INSERT INTO industry.guest_pilots(tenant_id,created_by,title,phase,plan,readiness,target_per_group,protocol,protocol_registered_at,launch_gate_enrolled_at)"+
    " VALUES($1,$2,'R19 synthetic repeat visit','running',$3::jsonb,$4::jsonb,20,$5::jsonb,$6,$6)"+
    " RETURNING id,protocol,protocol_registered_at",
    [tenants[0].tenantId,tenants[0].accountId,
      JSON.stringify({baselinePct:20,liftPp:10,margin:200,discount:20,fixed:100,fee:100}),
      JSON.stringify(ready),JSON.stringify(protocol),previouslyRegistered]
  )).rows[0];
  fixture=await syntheticR19(tenants.map(x=>x.tenantId),pilotRow.id,pilotRow,{
    now:new Date(),maxDailyWrites:2,retentionDays:30
  });
  Object.assign(process.env,fixture.env,{ALLOWED_ORIGIN:ORIGIN});
  app=await buildApp(pool);
  await app.listen({host:'127.0.0.1',port:0});
  url='http://127.0.0.1:'+app.server.address().port;
  for(const t of tenants){
    const logged=await call('POST','/auth/login',null,{
      tenantSlug:t.slug,email:t.email,password:pass
    });
    expect(logged,200);t.auth=session(logged);
  }
});
after(async()=>{
  if(app)await app.close();
  if(pool)await pool.end();
  if(admin)await admin.end();
  if(dbName)await rootAdmin.query('DROP DATABASE "'+dbName+'"');
  await rootAdmin.end();
  if(fixture)await fixture.cleanup();
  for(const [name,value] of Object.entries(prev)){
    if(value===undefined)delete process.env[name];else process.env[name]=value;
  }
});
test('R19 live: tenant and pilot isolation, idempotency, rollback quota, emergency stop and audit',async()=>{
  const own=tenants[0].auth;
  const scope=expect(await call('GET','/guest/admission/self',own),200);
  assert.equal(scope.pilotCollection.valid,true);
  assert.equal(scope.pilotCollection.pilotId,pilotRow.id);
  const other=expect(await call('GET','/guest/admission/self',tenants[1].auth),200);
  assert.equal(other.pilotCollection.valid,false);
  assert.equal(other.pilotCollection.pilotId,null);
  assert.equal((await call('GET','/guest/admission/self')).status,401);
  assert.equal((await call('GET','/guest/pilots/'+pilotRow.id+'/r19/preflight',tenants[1].auth)).status,404);
  const preflight=expect(await call('GET','/guest/pilots/'+pilotRow.id+'/r19/preflight',own),200);
  assert.equal(preflight.checks.signedTenantAndPilot,true);
  assert.equal(preflight.checks.exactRegisteredProtocol,true);
  assert.equal(preflight.maxDailyWrites,2);
  // R20 is accessible only to this authenticated company. It is a GET
  // inspection: no signed keys, approval artifacts or live writes returned.
  const inspectionPath='/guest/pilots/'+pilotRow.id+'/r20/inspection';
  assert.equal((await call('GET',inspectionPath,tenants[1].auth)).status,404);
  assert.equal((await call('GET',inspectionPath)).status,401);
  const inspection=expect(await call('GET',inspectionPath,own),200);
  assert.equal(inspection.schema,'osmanx.guest.r20.pilot-inspection.v1');
  assert.equal(inspection.checks.r19ScopeExact,true);
  assert.equal(inspection.daily.used,0);
  assert.equal(inspection.daily.auditEvents,0);
  assert.equal(inspection.customerGo,false);
  assert.equal(inspection.productionAuthorized,false);
  assert.equal(inspection.legalGo,false);
  assert.equal(JSON.stringify(inspection).includes('PRIVATE KEY'),false);
  const securityPath='/guest/pilots/'+pilotRow.id+'/r21/posture';
  assert.equal((await call('GET',securityPath,tenants[1].auth)).status,404);
  assert.equal((await call('GET',securityPath)).status,401);
  const posture=expect(await call('GET',securityPath,own),200);
  assert.equal(posture.schema,'osmanx.guest.r21.database-posture.v1');
  assert.equal(posture.signedScopeCurrent,true);
  assert.equal(posture.auditEventCount,0);
  assert.equal(posture.customerGo,false);
  assert.equal(posture.productionAuthorized,false);
  assert.equal(posture.independentHostAuditVerified,false);
  assert.equal(JSON.stringify(posture).includes('PRIVATE KEY'),false);
  assert.equal(JSON.stringify(posture).includes('r19-first-'+tag+'@'),false);
  const r22Path='/guest/pilots/'+pilotRow.id+'/r22/launch-review';
  assert.equal((await call('GET',r22Path,tenants[1].auth)).status,404);
  assert.equal((await call('GET',r22Path)).status,401);
  const r22=expect(await call('GET',r22Path,own),200);
  assert.equal(r22.schema,'osmanx.guest.r22.launch-review.v1');
  assert.equal(r22.checks.signedPilotScope,true);
  assert.equal(r22.checks.independentVpsWitness,false);
  assert.equal(r22.checks.twoDistinctDrCopiesVerified,false);
  assert.equal(r22.checks.allPrsMergedAndMainProtected,false);
  assert.equal(r22.customerGo,false);
  assert.equal(r22.productionAuthorized,false);
  assert.equal(JSON.stringify(r22).includes('PRIVATE KEY'),false);
  const handoffPath='/guest/pilots/'+pilotRow.id+'/r23/handoff';
  assert.equal((await call('GET',handoffPath,tenants[1].auth)).status,404);
  assert.equal((await call('GET',handoffPath)).status,401);
  const handoff=expect(await call('GET',handoffPath,own),200);
  assert.equal(handoff.schema,'osmanx.guest.r23.first-customer-handoff.v1');
  assert.equal(handoff.checks.independentSignedPilot,true);
  assert.equal(handoff.checks.orderedPrMergesVerified,false);
  assert.equal(handoff.checks.independentOffsiteDrVerified,false);
  assert.equal(handoff.customerGo,false);
  assert.equal(handoff.productionAuthorized,false);
  assert.equal(JSON.stringify(handoff).includes('PRIVATE KEY'),false);
  const before=await fences();
  assert.deepEqual(before,{r17:0,r18:0});
  const first={
    date:firstDate,control:100,controlReturn:21,offer:90,offerReturn:20
  };
  const path='/guest/pilots/'+pilotRow.id+'/observations';
  const invalid=await call('POST',path,own,
    {expectedVersion:400,observation:first},
    {'Idempotency-Key':'r19-invalid-'+tag});
  assert.equal(invalid.status,409);
  assert.equal((await usage()).used,0);
  assert.deepEqual(await fences(),before);
  const record=expect(await call('POST',path,own,
    {expectedVersion:1,observation:first},
    {'Idempotency-Key':'r19-valid-1-'+tag}),201);
  assert.ok(record.observationId);
  assert.equal((await usage()).used,1);
  assert.equal((await usage()).events,1);
  const duplicate=expect(await call('POST',path,own,
    {expectedVersion:1,observation:first},
    {'Idempotency-Key':'r19-valid-1-'+tag}),200);
  assert.equal(duplicate.duplicate,true);
  assert.equal((await usage()).used,1);
  const second=expect(await call('POST',path,own,
    {expectedVersion:2,observation:{
      date:secondDate,control:110,controlReturn:22,offer:95,offerReturn:24
    }},{'Idempotency-Key':'r19-valid-2-'+tag}),201);
  assert.equal(second.version,3);
  assert.deepEqual(await usage(),{used:2,maxDaily:2,events:2});
  const limit=await call('POST',path,own,{
    expectedVersion:3,observation:{
      date:thirdDate,control:70,controlReturn:14,offer:75,offerReturn:16
    }},{'Idempotency-Key':'r19-over-limit-'+tag});
  assert.equal(limit.status,429);
  assert.deepEqual(await usage(),{used:2,maxDaily:2,events:2});
  const entries=await admin.query(
    'SELECT version FROM industry.guest_pilots WHERE id=$1',[pilotRow.id]);
  assert.equal(entries.rows[0].version,3);
  const all=await admin.query(
    'SELECT count(*)::int AS n FROM industry.guest_observations WHERE pilot_id=$1',
    [pilotRow.id]);
  assert.equal(Number(all.rows[0].n),2);
  assert.equal((await call('POST',path,tenants[1].auth,
    {expectedVersion:3,observation:{date:thirdDate,control:80,controlReturn:10,offer:81,offerReturn:15}},
    {'Idempotency-Key':'r19-other-tenant-'+tag})).status,503);
  // If the pilot owner's daily allowance is exhausted, explicit safety hold
  // must still work; it is never charged against the collection quota.
  const hold=await call('POST','/guest/pilots/'+pilotRow.id+'/safety/hold',
    own,{expectedVersion:3,reasonCode:'consent_review'});
  expect(hold,200);
  assert.equal((await usage()).used,2);
  const stopped=await stopR19(fixture.env,{
    reasonCode:'consent_withdrawn',ack:'CONFIRM_R19_PERMANENT_STOP'
  });
  assert.equal(stopped.stopped,true);
  const lastStatus=expect(await call('GET','/guest/admission/self',own),200);
  assert.equal(lastStatus.pilotCollection.valid,false);
  const inspectionStopped=expect(await call('GET',inspectionPath,own),200);
  assert.equal(inspectionStopped.technicalReviewPossible,false);
  assert.equal(inspectionStopped.checks.r19ScopeExact,false);
  assert.equal(inspectionStopped.customerGo,false);
  assert.equal((await call('POST',path,own,{
    expectedVersion:3,observation:{date:thirdDate,control:80,controlReturn:10,offer:80,offerReturn:20}},
    {'Idempotency-Key':'r19-after-stop-'+tag})).status,503);
  assert.deepEqual(await usage(),{used:2,maxDaily:2,events:2});
  const afterStopPosture=expect(await call('GET',securityPath,own),200);
  assert.equal(afterStopPosture.signedScopeCurrent,false);
  assert.equal(afterStopPosture.technicalPostureReady,false);
  assert.equal(afterStopPosture.auditEventCount,2);
  assert.equal(afterStopPosture.customerGo,false);
  const afterStopR22=expect(await call('GET',r22Path,own),200);
  assert.equal(afterStopR22.checks.signedPilotScope,false);
  assert.equal(afterStopR22.localTechnicalReviewPossible,false);
  assert.equal(afterStopR22.customerGo,false);
  const afterStopR23=expect(await call('GET',handoffPath,own),200);
  assert.equal(afterStopR23.checks.independentSignedPilot,false);
  assert.equal(afterStopR23.localTechnicalPossible,false);
  assert.equal(afterStopR23.customerGo,false);
  const grants=(await admin.query(
    "SELECT has_table_privilege('industry_app','industry.guest_r19_collection_events','DELETE') AS del,"+
    "has_table_privilege('industry_app','industry.guest_r19_collection_events','UPDATE') AS upd"
  )).rows[0];
  assert.equal(grants.del,false);assert.equal(grants.upd,false);
  const rollback=await admin.query(
    'UPDATE industry.guest_r19_daily_usage SET used_count=0'
  ).then(()=>null,e=>e);
  assert.equal(rollback?.code,'23514');
  const unsafe=await admin.query(
    "SELECT relrowsecurity,relforcerowsecurity FROM pg_class WHERE oid='industry.guest_r19_daily_usage'::regclass"
  );
  assert.equal(unsafe.rows[0].relrowsecurity,true);
  assert.equal(unsafe.rows[0].relforcerowsecurity,true);
});

test('R23 SQL rehearsal: two real synthetic company pilots never cross RLS',async()=>{
  // Test-only secondary pilot is inserted by the disposable CI admin account;
  // both visibility checks themselves use the real non-BYPASSRLS app pool.
  const second=(await admin.query(
    "INSERT INTO industry.guest_pilots"+
    " (tenant_id,created_by,title,plan,readiness,target_per_group)"+
    " VALUES($1,$2,'R23 isolated control','{}'::jsonb,'{}'::jsonb,10) RETURNING id",
    [tenants[1].tenantId,tenants[1].accountId]
  )).rows[0];
  const report=await rehearseR23TenantIsolation(pool,{
    tenantA:tenants[0].tenantId,pilotA:pilotRow.id,
    tenantB:tenants[1].tenantId,pilotB:second.id
  });
  assert.equal(report.schema,'osmanx.guest.r23.read-only-rls-rehearsal.v1');
  assert.equal(report.technicalIsolationPass,true,JSON.stringify(report.blockers));
  assert.equal(report.firstOwnVisible,true);
  assert.equal(report.firstForeignHidden,true);
  assert.equal(report.secondOwnVisible,true);
  assert.equal(report.secondForeignHidden,true);
  assert.equal(report.transactionRolledBack,true);
  assert.equal(report.customerGo,false);
  assert.equal(report.customerDataReturned,false);
});
