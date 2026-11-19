// R25 complete synthetic HTTP/PostgreSQL rehearsal. NEVER connects to live DB.
import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import pg from 'pg';
import {hashPassword} from '../src/password.mjs';
import {makePool} from '../src/database.mjs';
import {buildApp} from '../src/app.mjs';
const API='/api/industry/v1',tag=randomUUID().slice(0,8);
const password='R25-Synthetic-Password-2026!!';
const tenants=[
  {slug:'r25-a-'+tag,email:'r25-a-'+tag+'@example.test'},
  {slug:'r25-b-'+tag,email:'r25-b-'+tag+'@example.test'}
];
const priorFlag=process.env.GUEST_R25_SIGNALS_ENABLED;
const rootAdmin=new pg.Pool({connectionString:process.env.MIGRATION_DB_URL});
let dbName,admin,pool,app,base,pilot;
async function call(method,path,auth,body,headers={}){
  const response=await fetch(base+API+path,{
    method,redirect:'error',cache:'no-store',
    headers:{Accept:'application/json',
      ...(body===undefined?{}:{'Content-Type':'application/json'}),
      ...(auth?{Cookie:auth.cookie,'X-CSRF-Token':auth.csrf}:{}),
      ...headers},
    ...(body===undefined?{}:{body:JSON.stringify(body)})
  });
  const value=await response.json();
  return {status:response.status,value};
}
function authorizedLogin(login){
  const cookies=login.headers.getSetCookie().map(x=>x.split(';')[0]);
  const csrf=cookies.find(x=>x.startsWith('osmanx_industry_csrf='));
  assert.ok(csrf&&cookies.some(x=>x.startsWith('osmanx_industry_sid=')));
  return {cookie:cookies.join('; '),csrf:csrf.split('=')[1]};
}
function tally(date,wait){
  return {date,shift:'morning',source:'staff_estimate',
    sampled:20,counts:{
      wait,stockout:2,ordering:2,price:1,service:1,
      unknown:14-wait
    }};
}
const signalPath=()=>'/guest/pilots/'+pilot+'/operational-signals';
const insightsPath=()=>'/guest/pilots/'+pilot+'/r25/insights';
before(async()=>{
  const migration=new URL(process.env.MIGRATION_DB_URL||'');
  const runtime=new URL(process.env.DATABASE_URL||'');
  if(process.env.NODE_ENV!=='test'||
     !['localhost','127.0.0.1'].includes(migration.hostname)||
     !['localhost','127.0.0.1'].includes(runtime.hostname)||
     migration.pathname!=='/industry_ci'||runtime.pathname!=='/industry_ci')
    throw Error('R25 requires disposable local industry_ci PostgreSQL');
  dbName='industry_r25_'+randomUUID().replaceAll('-','').slice(0,12);
  await rootAdmin.query('CREATE DATABASE "'+dbName+'"');
  migration.pathname='/'+dbName;runtime.pathname='/'+dbName;
  admin=new pg.Pool({connectionString:migration.toString()});
  execFileSync(process.execPath,['scripts/migrate.mjs'],{
    cwd:fileURLToPath(new URL('../',import.meta.url)),
    env:{...process.env,MIGRATION_DB_URL:migration.toString()},
    stdio:'pipe'
  });
  pool=makePool(runtime.toString());
  for(const entry of tenants){
    entry.tenant=(await admin.query(
      "INSERT INTO industry.tenants(slug,name,vertical) VALUES($1,$2,'cafe') RETURNING id",
      [entry.slug,entry.slug])).rows[0].id;
    entry.account=(await admin.query(
      'INSERT INTO industry.accounts(email,password_hash) VALUES($1,$2) RETURNING id',
      [entry.email,await hashPassword(password)])).rows[0].id;
    await admin.query(
      "INSERT INTO industry.memberships(tenant_id,account_id,role) VALUES($1,$2,'owner')",
      [entry.tenant,entry.account]);
  }
  const protocol={
    startDate:'2026-11-01',endDate:'2026-11-30',
    allocation:'random',source:'pos',outcomeWindowDays:7,
    primaryMetric:'repeat_visit'
  };
  pilot=(await admin.query(
    "INSERT INTO industry.guest_pilots"+
    "(tenant_id,created_by,title,phase,plan,readiness,target_per_group,"+
    "protocol,protocol_registered_at)"+
    "VALUES($1,$2,'Synthetic R25 pilot','running',$3::jsonb,"+
    "$4::jsonb,20,$5::jsonb,$6) RETURNING id",
    [tenants[0].tenant,tenants[0].account,
      JSON.stringify({baselinePct:20,liftPp:5,margin:100,
        discount:5,fixed:20,fee:100}),
      JSON.stringify({repeatDefinition:true,sameWindow:true,
        independentGroups:true,marginVerified:true,contactConsent:true,
        ownerAgreed:true}),
      JSON.stringify(protocol),'2026-10-30T00:00:00Z']
  )).rows[0].id;
  process.env.GUEST_R25_SIGNALS_ENABLED='true'; // synthetic CI only
  app=await buildApp(pool);
  await app.listen({host:'127.0.0.1',port:0});
  base='http://127.0.0.1:'+app.server.address().port;
  for(const entry of tenants){
    const response=await fetch(base+API+'/auth/login',{
      method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({
        tenantSlug:entry.slug,email:entry.email,password
      })
    });
    assert.equal(response.status,200);
    entry.auth=authorizedLogin(response);
  }
});
after(async()=>{
  if(app)await app.close();
  if(pool)await pool.end();
  if(admin)await admin.end();
  if(dbName)await rootAdmin.query('DROP DATABASE "'+dbName+'"');
  await rootAdmin.end();
  if(priorFlag===undefined)delete process.env.GUEST_R25_SIGNALS_ENABLED;
  else process.env.GUEST_R25_SIGNALS_ENABLED=priorFlag;
});
test('R25 actual Fastify/PostgreSQL: owner GET, cross-tenant and unauthenticated denial',async()=>{
  const bad=await call('GET',insightsPath(),tenants[1].auth);
  assert.equal(bad.status,404);
  assert.equal((await call('GET',insightsPath())).status,401);
  const good=await call('GET',insightsPath(),tenants[0].auth);
  assert.equal(good.status,200,JSON.stringify(good.value));
  assert.equal(good.value.schema,'osmanx.guest.r25.operational-brief.v1');
  assert.equal(good.value.profile.totalSampled,0);
  assert.equal(good.value.recordingAvailable,true);
  assert.equal(good.value.individualGuestsLinked,false);
  assert.equal(good.value.customerGo,false);
});
test('R25 denies malformed input, saves immutable anonymous shift and deduplicates',async()=>{
  const owner=tenants[0].auth,path=signalPath();
  const broken=tally('2026-11-01',6);
  broken.counts.wait=100;
  assert.equal((await call('POST',path,owner,{
    expectedVersion:1,tally:broken},{'Idempotency-Key':'r25-bad-'+tag})).status,400);
  const extra={...tally('2026-11-01',6),guestPhone:'+12025550123'};
  assert.equal((await call('POST',path,owner,{
    expectedVersion:1,tally:extra},{'Idempotency-Key':'r25-pii-'+tag})).status,400);
  const first=tally('2026-11-01',6);
  const accepted=await call('POST',path,owner,{
    expectedVersion:1,tally:first},{'Idempotency-Key':'r25-good-'+tag});
  assert.equal(accepted.status,201,JSON.stringify(accepted.value));
  assert.equal(accepted.value.version,2);
  const replay=await call('POST',path,owner,{
    expectedVersion:1,tally:first},{'Idempotency-Key':'r25-good-'+tag});
  assert.equal(replay.status,200,JSON.stringify(replay.value));
  assert.equal(replay.value.duplicate,true);
  assert.equal(replay.value.version,2);
  assert.equal((await call('POST',path,owner,{
    expectedVersion:2,tally:tally('2026-11-01',7)},
    {'Idempotency-Key':'r25-new-'+tag})).status,409);
  assert.equal((await call('POST',path,tenants[1].auth,{
    expectedVersion:2,tally:tally('2026-11-03',8)},
    {'Idempotency-Key':'r25-foreign-'+tag})).status,404);
  const second=await call('POST',path,owner,{
    expectedVersion:2,tally:tally('2026-11-03',8)},
    {'Idempotency-Key':'r25-second-'+tag});
  assert.equal(second.status,201,JSON.stringify(second.value));
  const after=await call('GET',insightsPath(),owner);
  assert.equal(after.status,200);
  assert.equal(after.value.profile.recordedShifts,2);
  assert.equal(after.value.profile.totalSampled,40);
  assert.equal(after.value.profile.periodComparison.comparable,true);
  assert.equal(after.value.recordingAvailable,true);
  assert.equal(after.value.customerGo,false);
  const records=await admin.query(
    'SELECT count(*)::int AS n FROM industry.guest_r25_operational_tallies');
  assert.equal(records.rows[0].n,2);
});
test('R25 SQL enforces FORCE RLS, least privileges, immutable table and private CSV',async()=>{
  const client=await pool.connect();
  try{
    await client.query('BEGIN READ ONLY');
    await client.query("SELECT set_config('app.tenant_id',$1,true)",[tenants[1].tenant]);
    const foreign=await client.query(
      'SELECT id FROM industry.guest_r25_operational_tallies WHERE pilot_id=$1',
      [pilot]);
    assert.equal(foreign.rowCount,0);
    const priv=await client.query(
      "SELECT has_table_privilege(current_user,"+
      "'industry.guest_r25_operational_tallies','UPDATE') AS can_update,"+
      " has_table_privilege(current_user,"+
      "'industry.guest_r25_operational_tallies','DELETE') AS can_delete");
    assert.equal(priv.rows[0].can_update,false);
    assert.equal(priv.rows[0].can_delete,false);
    await client.query('ROLLBACK');
  }finally{client.release();}
  const flags=await admin.query(
    "SELECT relrowsecurity,relforcerowsecurity FROM pg_class"+
    " WHERE oid='industry.guest_r25_operational_tallies'::regclass");
  assert.deepEqual(flags.rows[0],{
    relrowsecurity:true,relforcerowsecurity:true
  });
  const entry=(await admin.query(
    'SELECT id FROM industry.guest_r25_operational_tallies LIMIT 1')).rows[0];
  await assert.rejects(admin.query(
    'UPDATE industry.guest_r25_operational_tallies SET wait_count=9 WHERE id=$1',
    [entry.id]),/append-only/);
  await assert.rejects(admin.query(
    'DELETE FROM industry.guest_r25_operational_tallies WHERE id=$1',
    [entry.id]),/append-only/);
  const csv=await fetch(base+API+'/guest/pilots/'+pilot+'/r25/report.csv',{
    headers:{Cookie:tenants[0].auth.cookie,
      'X-CSRF-Token':tenants[0].auth.csrf,Accept:'text/csv'}
  });
  assert.equal(csv.status,200);
  const bytes=Buffer.from(await csv.arrayBuffer());
  assert.equal(bytes.subarray(0,3).toString('hex'),'efbbbf');
  assert.equal(bytes.toString('utf8').includes(tenants[0].email),false);
  assert.equal(bytes.toString('utf8').includes(tenants[1].email),false);
});
test('R25 explicit emergency STOP and separate collection switch block new writes',async()=>{
  await admin.query(
    "INSERT INTO industry.guest_pilot_holds"+
    "(tenant_id,pilot_id,active,reason_code,held_by)"+
    "VALUES($1,$2,true,'consent_review',$3)",
    [tenants[0].tenant,pilot,tenants[0].account]);
  const before=await call('GET',insightsPath(),tenants[0].auth);
  assert.equal(before.status,200);
  assert.equal(before.value.emergencyStopActive,true);
  assert.equal(before.value.recordingAvailable,false);
  assert.equal(before.value.nextExperiment.protocolDraft,null);
  assert.equal((await call('POST',signalPath(),tenants[0].auth,{
    expectedVersion:3,tally:tally('2026-11-05',5)},
    {'Idempotency-Key':'r25-stopped-'+tag})).status,409);
  process.env.GUEST_R25_SIGNALS_ENABLED='false';
  assert.equal((await call('POST',signalPath(),tenants[0].auth,{
    expectedVersion:3,tally:tally('2026-11-05',5)},
    {'Idempotency-Key':'r25-disabled-'+tag})).status,503);
  const count=(await admin.query(
    'SELECT count(*)::int AS n FROM industry.guest_r25_operational_tallies'
  )).rows[0].n;
  assert.equal(count,2);
});
