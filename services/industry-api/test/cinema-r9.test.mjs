// CINEMA R9 integration: real PostgreSQL, owner CSV snapshot, human-recorded response evidence.
import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {buildApp} from '../src/app.mjs';
import {makePool,withTenant} from '../src/database.mjs';
import {hashPassword} from '../src/password.mjs';
import {exportInput,csvCell,makeCsv,reviewPeriod,rate} from '../src/cinema-r9.mjs';
import {inspectCinemaR9} from '../scripts/cinema-r9-readiness.mjs';
import {cinemaR9Canary} from '../scripts/cinema-r9-canary.mjs';
const PREFIX='/api/industry/v1',suffix=randomUUID().slice(0,8),users={},pwd='CINEMA-R9-ci-safe-password-2026!!';
const admin=new pg.Pool({connectionString:process.env.MIGRATION_DB_URL});
const pool=makePool();let app,tenant,foreign,firstId,otherId;
const envKeys=['CINEMA_TENANT_ID','CINEMA_RATE_SECRET','CINEMA_PUBLIC_WRITE_ENABLED','CINEMA_AGGREGATE_EVENTS_ENABLED'];
const previous=Object.fromEntries(envKeys.map(k=>[k,process.env[k]]));
const send=(method,path,user,payload,headers={})=>app.inject({method,url:PREFIX+path,
  headers:{...(user?{cookie:user.cookie,'x-csrf-token':user.csrf}:{}),...headers},
  ...(payload===undefined?{}:{payload})});
const ok=(res,status)=>{assert.equal(res.statusCode,status,res.body);return res;};
before(async()=>{
  tenant=(await admin.query("INSERT INTO industry.tenants(slug,name,vertical) VALUES($1,'R9 synthetic','cafe') RETURNING id",['r9-'+suffix])).rows[0].id;
  foreign=(await admin.query("INSERT INTO industry.tenants(slug,name,vertical) VALUES($1,'R9 foreign','cafe') RETURNING id",['r9-foreign-'+suffix])).rows[0].id;
  for(const [name,role,t] of [['owner','owner',tenant],['manager','manager',tenant],['viewer','viewer',tenant],['foreign','owner',foreign]]){
    const email='r9-'+name+'-'+suffix+'@example.test';
    const id=(await admin.query('INSERT INTO industry.accounts(email,password_hash) VALUES($1,$2) RETURNING id',
      [email,await hashPassword(pwd)])).rows[0].id;
    await admin.query('INSERT INTO industry.memberships(tenant_id,account_id,role) VALUES($1,$2,$3)',[t,id,role]);
    users[name]={id,email,slug:t===tenant?'r9-'+suffix:'r9-foreign-'+suffix};
  }
  process.env.CINEMA_TENANT_ID=tenant;
  process.env.CINEMA_RATE_SECRET='R9-SYNTHETIC-TEST-SECRET-AT-LEAST-THIRTY-TWO';
  process.env.CINEMA_PUBLIC_WRITE_ENABLED='true';
  process.env.CINEMA_AGGREGATE_EVENTS_ENABLED='true';
  app=await buildApp(pool);
  for(const u of Object.values(users)){
    const response=ok(await send('POST','/auth/login',null,{tenantSlug:u.slug,email:u.email,password:pwd}),200);
    const cookies=[].concat(response.headers['set-cookie']||[]).map(x=>x.split(';')[0]);
    const csrf=cookies.find(x=>x.startsWith('osmanx_industry_csrf='));
    assert(csrf);u.cookie=cookies.join('; ');u.csrf=csrf.split('=')[1];
  }
  const newLead=async(n)=>{
    const payload={storyId:'07-coffee',contactName:'Synthetic R9 '+n,
      contactEmail:'r9-contact-'+n+'-'+suffix+'@example.test',organization:'Synthetic coffee',
      observation:'Contact response evidence test row for a synthetic customer',
      source:'cinema',campaignCode:'r9_verified',consent:true,website:''};
    return ok(await send('POST','/cinema/public/leads',null,payload,
      {'idempotency-key':'r9-entry-'+n+'-'+suffix+'-key'}),201).json().reference;
  };
  firstId=await newLead(1);otherId=await newLead(2);
});
after(async()=>{
  try{await app?.close();await pool.end();}
  finally{
    try{
      if(tenant&&foreign)await admin.query('DELETE FROM industry.tenants WHERE id=$1 OR id=$2',[tenant,foreign]);
      await admin.query('DELETE FROM industry.accounts WHERE email LIKE $1',['r9-%-'+suffix+'@example.test']);
    }finally{
      await admin.end();
      for(const [k,v] of Object.entries(previous)){if(v===undefined)delete process.env[k];else process.env[k]=v;}
    }
  }
});
test('R9 rejects formula injection and malformed export requests',()=>{
  assert.equal(csvCell('=HYPERLINK("evil")'),'"\'=HYPERLINK(""evil"")"');
  assert.equal(csvCell('  +SUM(1,2)'),'"\'  +SUM(1,2)"');
  assert.equal(csvCell('-10'),'"\'-10"');
  assert.equal(csvCell('Normal "label"'),'"Normal ""label"""');
  assert.equal(csvCell('first\nsecond'),'"first second"');
  assert(makeCsv([{id:firstId,contact_name:'=BAD'}]).startsWith('\uFEFF'));
  assert.deepEqual(exportInput({confirm:'GENERATE_CSV',leadIds:[firstId.toUpperCase()]}),[firstId]);
  assert.throws(()=>exportInput({confirm:'GENERATE_CSV',leadIds:[firstId,firstId]}));
  assert.throws(()=>exportInput({confirm:'GENERATE_CSV',leadIds:Array(501).fill(firstId)}));
  assert.throws(()=>exportInput({confirm:'GENERATE_CSV',leadIds:[firstId],debug:true}));
  assert.throws(()=>reviewPeriod({days:'60'}));
  assert.throws(()=>reviewPeriod({days:'07'}));
  assert.equal(rate(1,2),50);
  assert.equal(rate(0,0),null);
});
test('R9 CSV rereads current database rows, denies other roles and logs generation transactionally',async()=>{
  const url='/cinema/exports/csv',body={confirm:'GENERATE_CSV',leadIds:[firstId]};
  ok(await send('POST',url,null,body),401);
  ok(await send('POST',url,users.manager,body),403);
  ok(await send('POST',url,users.viewer,body),403);
  ok(await send('POST',url,users.foreign,body),403);
  ok(await send('POST',url,users.owner,{...body,leadIds:[firstId,randomUUID()]}),409);
  ok(await send('POST',url,users.owner,{...body,confirm:'EXPORT_LOADED'}),400);
  await withTenant(pool,tenant,db=>db.query(
    'UPDATE industry.cinema_leads SET contact_name=$3 WHERE tenant_id=$1 AND id=$2',
    [tenant,firstId,'=HYPERLINK("https://invalid.test")']));
  const response=ok(await send('POST',url,users.owner,body),200);
  assert.match(response.headers['content-type'],/text\/csv/i);
  assert.match(response.headers['cache-control'],/no-store/);
  assert.match(response.headers['content-disposition'],/attachment/i);
  assert(response.body.startsWith('\uFEFF'));
  assert(response.body.includes('"\u0027=HYPERLINK('));
  assert(response.body.includes(firstId));
  assert(!response.body.includes('Synthetic R9 1'),'CSV must reflect the database snapshot, not stale UI data');
  const access=await withTenant(pool,tenant,db=>db.query(
    "SELECT action,actor_id,lead_id,result_count FROM industry.cinema_access_events WHERE tenant_id=$1 AND action='bulk_export_generated'",
    [tenant]));
  assert.equal(access.rowCount,1);
  assert.equal(access.rows[0].actor_id,users.owner.id);
  assert.equal(access.rows[0].lead_id,null);
  assert.equal(access.rows[0].result_count,1);
  const segregated=await withTenant(pool,foreign,db=>db.query(
    "SELECT count(*)::int AS n FROM industry.cinema_access_events WHERE action='bulk_export_generated'"));
  assert.equal(segregated.rows[0].n,0);
});
test('R9 counts first contact attempts from events with explicit one-hour denominator',async()=>{
  await withTenant(pool,tenant,db=>db.query(
    "UPDATE industry.cinema_leads SET created_at=now()-interval '2 hours' WHERE tenant_id=$1 AND id=$2",
    [tenant,firstId]));
  // A manually recorded contact now is >1h after the synthetic lead's timestamp.
  ok(await send('POST','/cinema/leads/'+firstId+'/contacts',users.manager,
    {expectedVersion:1,channel:'email',outcome:'attempted',completeFollowup:false},
    {'idempotency-key':'r9-contact-'+suffix+'-verify'}),200);
  const report=ok(await send('GET','/cinema/ops/response-review?days=7',users.manager),200).json();
  assert.equal(report.schema,'osmanx.cinema.response-review.v1');
  assert.equal(report.counts.total,2);
  assert.equal(report.counts.with_attempt,1);
  assert.equal(report.counts.eligible_1h,1);
  assert.equal(report.counts.responded_within_1h,0);
  assert.equal(report.percentages.everAttempted,50);
  assert.equal(report.percentages.respondedWithin1h,0);
  assert(Number(report.counts.avg_minutes_to_first_attempt)>=120);
  assert.equal(report.counts.manager_marked_connected,0);
  assert(!JSON.stringify(report).includes('r9-contact-'));
  ok(await send('GET','/cinema/ops/response-review?days=7',users.viewer),403);
  ok(await send('GET','/cinema/ops/response-review?days=7',users.foreign),403);
  ok(await send('GET','/cinema/ops/response-review?days=7%3Bdrop',users.owner),400);
  const runtime=ok(await send('GET','/cinema/public/r9-runtime',null),200).json();
  assert.equal(runtime.apiRelease,'r9');
  assert.equal(runtime.capabilities.serverCsvSnapshot,true);
  assert(!JSON.stringify(runtime).includes(tenant));
});
test('R9 staging gate stays NO-GO even when schema exists',async()=>{
  const result=await inspectCinemaR9(pool,{CINEMA_TENANT_ID:tenant,
    CINEMA_RATE_SECRET:'R9-TEST-SECRET-AT-LEAST-THIRTY-TWO-CHARACTERS',
    CINEMA_PUBLIC_WRITE_ENABLED:'false',CINEMA_AGGREGATE_EVENTS_ENABLED:'false'});
  assert.equal(result.checks.r9AuditAction,true);
  assert.equal(result.checks.r9ContactIndex,true);
  assert.equal(result.checks.r9OperatorReviewed,false);
  assert.equal(result.go,false);
});
test('R9 loopback canary rejects unauthorized data access and active intake',async()=>{
  const fake=async(url,request)=>{
    const path=new URL(url).pathname;
    let status=401,data={error:'Unauthorized'};
    if(path.endsWith('/health/live')){status=200;data={status:'live'};}
    if(path.endsWith('/cinema/public/config')){status=200;data={intakeEnabled:false,aggregateEventsEnabled:false};}
    if(path.endsWith('/cinema/public/leads')){status=503;data={error:'disabled'};}
    if(path.endsWith('/cinema/public/runtime')){status=200;data={
      apiRelease:'r8',onlineIntakeEnabled:false,aggregateActionsEnabled:false,
      capabilities:{ownerCsvApproval:true}};}
    if(path.endsWith('/cinema/public/r9-runtime')){status=200;data={
      apiRelease:'r9',onlineIntakeEnabled:false,aggregateActionsEnabled:false,
      capabilities:{serverCsvSnapshot:true}};}
    if(path.endsWith('/cinema/exports/approve')){status=404;data={error:'GET disabled'};}
    if(path.endsWith('/cinema/exports/csv')&&request.method==='GET'){
      status=404;data={error:'GET disabled'};
    }
    return {status,async json(){return data;}};
  };
  const result=await cinemaR9Canary({fetcher:fake});
  assert(result.safe);
  assert.equal(result.checks.anonymousCsvDenied,true);
  const unsafe=async(url,request)=>{
    if(url.endsWith('/cinema/public/r9-runtime'))return {status:200,async json(){
      return {apiRelease:'r9',onlineIntakeEnabled:true,aggregateActionsEnabled:false,
        capabilities:{serverCsvSnapshot:true}};}};
    return fake(url,request);
  };
  await assert.rejects(()=>cinemaR9Canary({fetcher:unsafe}),/NO-GO/);
});
