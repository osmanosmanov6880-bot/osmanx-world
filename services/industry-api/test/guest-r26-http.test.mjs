// R26 disposable, REAL PostgreSQL + Fastify two-person review rehearsal.
// Never connects to live production or accepts unmounted client data.
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
const password='Synthetic-R26-Nonproduction-2026!!';
const entities=[
  {slug:'r26-owner-'+tag,email:'owner-'+tag+'@example.test',role:'owner'},
  {slug:'r26-owner-'+tag,email:'manager-'+tag+'@example.test',role:'manager'},
  {slug:'r26-foreign-'+tag,email:'foreign-'+tag+'@example.test',role:'owner'}
];
const prev=process.env.GUEST_R26_SOURCE_REVIEW_ENABLED;
const root=new pg.Pool({connectionString:process.env.MIGRATION_DB_URL});
let dbName,admin,pool,app,base,pilot;
async function request(method,path,actor=null,body,extra={}){
  const response=await fetch(base+API+path,{
    method,redirect:'error',cache:'no-store',
    headers:{Accept:'application/json',
      ...(body===undefined?{}:{'Content-Type':'application/json'}),
      ...(actor?{Cookie:actor.cookie,'X-CSRF-Token':actor.csrf}:{}),...extra},
    ...(body===undefined?{}:{body:JSON.stringify(body)})
  });
  if((response.headers.get('content-type')||'').includes('text/csv'))
    return {status:response.status,bytes:Buffer.from(await response.arrayBuffer())};
  return {status:response.status,value:await response.json()};
}
const identity=(login)=>{
  const list=login.headers.getSetCookie().map(x=>x.split(';')[0]);
  const csrf=list.find(x=>x.startsWith('osmanx_industry_csrf='));
  assert.ok(csrf&&list.some(x=>x.startsWith('osmanx_industry_sid=')));
  return {cookie:list.join('; '),csrf:csrf.split('=')[1]};
};
const path=()=>'/guest/pilots/'+pilot+'/r26';
before(async()=>{
  const migration=new URL(process.env.MIGRATION_DB_URL||'');
  const runtime=new URL(process.env.DATABASE_URL||'');
  if(process.env.NODE_ENV!=='test'||
     migration.hostname!=='127.0.0.1'||runtime.hostname!=='127.0.0.1'||
     migration.pathname!=='/industry_ci'||runtime.pathname!=='/industry_ci')
    throw Error('R26 requires local synthetic industry_ci database');
  dbName='industry_r26_'+randomUUID().replaceAll('-','').slice(0,12);
  await root.query('CREATE DATABASE "'+dbName+'"');
  migration.pathname='/'+dbName;runtime.pathname='/'+dbName;
  admin=new pg.Pool({connectionString:migration.toString()});
  execFileSync(process.execPath,['scripts/migrate.mjs'],{
    cwd:fileURLToPath(new URL('../',import.meta.url)),
    env:{...process.env,MIGRATION_DB_URL:migration.toString()},
    stdio:'pipe'
  });
  pool=makePool(runtime.toString());
  const tenantA=(await admin.query(
    "INSERT INTO industry.tenants(slug,name,vertical) VALUES($1,$2,'cafe') RETURNING id",
    [entities[0].slug,entities[0].slug])).rows[0].id;
  const tenantB=(await admin.query(
    "INSERT INTO industry.tenants(slug,name,vertical) VALUES($1,$2,'cafe') RETURNING id",
    [entities[2].slug,entities[2].slug])).rows[0].id;
  for(const [index,item] of entities.entries()){
    item.tenant=index===2?tenantB:tenantA;
    item.account=(await admin.query(
      'INSERT INTO industry.accounts(email,password_hash) VALUES($1,$2) RETURNING id',
      [item.email,await hashPassword(password)])).rows[0].id;
    await admin.query(
      'INSERT INTO industry.memberships(tenant_id,account_id,role) VALUES($1,$2,$3)',
      [item.tenant,item.account,item.role]);
  }
  const protocol={startDate:'2026-11-01',endDate:'2026-11-12',
    outcomeWindowDays:7,allocation:'random',source:'pos',
    primaryMetric:'repeat_visit'};
  pilot=(await admin.query(
    'INSERT INTO industry.guest_pilots'+
    '(tenant_id,created_by,title,phase,plan,readiness,target_per_group,'+
    'protocol,protocol_registered_at)'+
    "VALUES($1,$2,'R26 isolated synthetic pilot','in_review',$3::jsonb,"+
    '$4::jsonb,30,$5::jsonb,$6) RETURNING id',
    [tenantA,entities[0].account,
      JSON.stringify({baselinePct:20,liftPp:10,margin:150,
        discount:5,fixed:100,fee:100}),
      JSON.stringify({repeatDefinition:true,sameWindow:true,
        independentGroups:true,marginVerified:true,
        contactConsent:true,ownerAgreed:true}),
      JSON.stringify(protocol),'2026-10-30T00:00:00Z']
  )).rows[0].id;
  const days=['2026-11-03','2026-11-06','2026-11-09'];
  for(let i=0;i<days.length;i++){
    await admin.query(
      'INSERT INTO industry.guest_r25_operational_tallies'+
      '(tenant_id,pilot_id,observed_on,shift,source_kind,sampled,'+
      'wait_count,stockout_count,ordering_count,price_count,service_count,'+
      'unknown_count,idempotency_key,payload_digest,recorded_by)'+
      "VALUES($1,$2,$3::date,$4,$5,20,6,3,2,2,1,6,$6,$7,$8)",
      [tenantA,pilot,days[i],['morning','evening','afternoon'][i],
        i===1?'anonymous_counter':'staff_estimate',
        'r26synthetic-'+tag+'-'+i,String(i).repeat(64),entities[0].account]
    );
  }
  process.env.GUEST_R26_SOURCE_REVIEW_ENABLED='true'; // ONLY synthetic test
  app=await buildApp(pool);
  await app.listen({host:'127.0.0.1',port:0});
  base='http://127.0.0.1:'+app.server.address().port;
  for(const item of entities){
    const response=await fetch(base+API+'/auth/login',{
      method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({tenantSlug:item.slug,email:item.email,password})
    });
    assert.equal(response.status,200);
    item.auth=identity(response);
  }
});
after(async()=>{
  if(app)await app.close();
  if(pool)await pool.end();
  if(admin)await admin.end();
  if(dbName)await root.query('DROP DATABASE "'+dbName+'"');
  await root.end();
  if(prev===undefined)delete process.env.GUEST_R26_SOURCE_REVIEW_ENABLED;
  else process.env.GUEST_R26_SOURCE_REVIEW_ENABLED=prev;
});
let initial,ownerInput;
test('R26 GET: tenant+manager isolation, NO-GO and private evidence',async()=>{
  assert.equal((await request('GET',path()+'/reliability')).status,401);
  assert.equal((await request('GET',path()+'/reliability',entities[2].auth)).status,404);
  const own=await request('GET',path()+'/reliability',entities[0].auth);
  assert.equal(own.status,200,JSON.stringify(own.value));
  initial=own.value;
  assert.equal(initial.schema,'osmanx.guest.r26.source-reliability-brief.v1');
  assert.equal(initial.sourceRowCount,3);
  assert.equal(initial.sourceSampled,60);
  assert.equal(initial.review.internalDeclarationsComplete,false);
  assert.equal(initial.reviewEnabled,true);
  assert.equal(initial.customerGo,false);
  assert.equal(initial.productionAuthorized,false);
  assert.equal(JSON.stringify(initial).includes(entities[0].email),false);
});
test('R26 HTTP: owner immutable source declaration, same-key replay and role conflict',async()=>{
  const body={expectedVersion:initial.version,
    sourceSha:initial.r25SourceSha,r24EvidenceSha:initial.r24EvidenceSha,
    evidenceSha:'b'.repeat(64),method:'staff_shift_crosscheck',
    verdict:'reconciled'};
  ownerInput=body;
  const p=path()+'/source-review';
  assert.equal((await request('POST',p,entities[0].auth,{
    ...body,guestPhone:'+12025550123'},{'Idempotency-Key':'r26-pii-'+tag})).status,400);
  assert.equal((await request('POST',p,entities[0].auth,{
    ...body,sourceSha:'a'.repeat(64)},
    {'Idempotency-Key':'r26-wrong-'+tag})).status,409);
  const saved=await request('POST',p,entities[0].auth,body,
    {'Idempotency-Key':'r26-owner-'+tag});
  assert.equal(saved.status,201,JSON.stringify(saved.value));
  assert.ok(saved.value.reviewId);
  const replay=await request('POST',p,entities[0].auth,body,
    {'Idempotency-Key':'r26-owner-'+tag});
  assert.equal(replay.status,200);
  assert.equal(replay.value.duplicate,true);
  assert.equal((await request('POST',p,entities[0].auth,{
    ...body,evidenceSha:'e'.repeat(64)},
    {'Idempotency-Key':'r26-owner-'+tag})).status,409);
  assert.equal((await request('POST',p,entities[0].auth,body,
    {'Idempotency-Key':'r26-owner-second-'+tag})).status,409);
  const pending=(await request('GET',path()+'/reliability',entities[0].auth)).value;
  assert.equal(pending.review.current.owner.present,true);
  assert.equal(pending.review.current.manager.present,false);
  assert.equal(pending.review.internalDeclarationsComplete,false);
  assert.equal(pending.customerGo,false);
});
test('R26 separate manager document completes only INTERNAL declarations, not external audit',async()=>{
  const body={...ownerInput,evidenceSha:'c'.repeat(64),
    method:'independent_aggregate_recount'};
  const response=await request('POST',path()+'/source-review',
    entities[1].auth,body,{'Idempotency-Key':'r26-manager-'+tag});
  assert.equal(response.status,201,JSON.stringify(response.value));
  const report=(await request('GET',path()+'/reliability',entities[0].auth)).value;
  assert.equal(report.review.internalDeclarationsComplete,true);
  assert.equal(report.review.current.owner.verdict,'reconciled');
  assert.equal(report.review.current.manager.verdict,'reconciled');
  assert.equal(report.externalAuditCompleted,false);
  assert.equal(report.customerMotivesEstablished,false);
  assert.equal(report.reportSigned,false);
  assert.equal(report.customerGo,false);
  assert.equal(JSON.stringify(report).includes(entities[1].email),false);
  const foreign=await request('GET',path()+'/report.csv',entities[2].auth);
  assert.equal(foreign.status,404);
  const csv=await request('GET',path()+'/report.csv',entities[1].auth);
  assert.equal(csv.status,200);
  assert.equal(csv.bytes.subarray(0,3).toString('hex'),'efbbbf');
  for(const item of entities)assert.equal(csv.bytes.toString().includes(item.email),false);
});
test('R26 pilot version invalidates both internal declarations without rewriting history',async()=>{
  const before=(await admin.query(
    'SELECT count(*)::int AS n FROM industry.guest_r26_source_reviews'
  )).rows[0].n;
  assert.equal(before,2);
  await admin.query('UPDATE industry.guest_pilots SET version=version+1 WHERE id=$1',
    [pilot]);
  const later=(await request('GET',path()+'/reliability',entities[1].auth)).value;
  assert.equal(later.review.internalDeclarationsComplete,false);
  assert.equal(later.review.historicalReviewCount,2);
  assert.equal(later.review.currentReviewCount,0);
  assert.equal((await request('POST',path()+'/source-review',
    entities[0].auth,ownerInput,
    {'Idempotency-Key':'r26-old-version-'+tag})).status,409);
});
test('R27 actual Fastify/PostgreSQL: private pilot handoff, synthetic paths and expiring CSV',async()=>{
  const owned='/guest/pilots/'+pilot+'/r27';
  assert.equal((await request('GET',owned+'/readiness')).status,401);
  assert.equal((await request('GET',owned+'/readiness',entities[2].auth)).status,404);
  assert.equal((await request('GET',owned+'/rehearsal',entities[2].auth)).status,404);
  assert.equal((await request('GET',owned+'/handoff.csv',entities[2].auth)).status,404);
  const readiness=await request('GET',owned+'/readiness',entities[1].auth);
  assert.equal(readiness.status,200,JSON.stringify(readiness.value));
  const packet=readiness.value;
  assert.equal(packet.schema,'osmanx.guest.r27.operator-handoff.v1');
  assert.equal(packet.pilotId,pilot);
  assert.equal(packet.version,initial.version+1);
  assert.equal(packet.customerGo,false);
  assert.equal(packet.productionAuthorized,false);
  assert.equal(packet.reportContainsPersonalData,false);
  assert.equal(packet.decision.stage,'DATA_BLOCKED');
  assert.ok(packet.blockers.includes('R27_EXTERNAL_SOURCE_AUDIT_REQUIRED'));
  assert.ok(packet.blockers.includes('R27_HUMAN_MERGE_AND_CHANGE_TICKET_REQUIRED'));
  assert.equal(Date.parse(packet.expiresAt)-Date.parse(packet.issuedAt),1800000);
  const rehearsal=await request('GET',owned+'/rehearsal',entities[0].auth);
  assert.equal(rehearsal.status,200);
  assert.equal(rehearsal.value.schema,
    'osmanx.guest.r27.synthetic-first-client-rehearsal.v1');
  assert.equal(rehearsal.value.allPassed,true,JSON.stringify(rehearsal.value.cases));
  assert.equal(rehearsal.value.passedCases,7);
  assert.equal(packet.rehearsal.sha256,rehearsal.value.sha256);
  assert.equal(rehearsal.value.realCustomerDataUsed,false);
  assert.equal(rehearsal.value.runtimeExternalCalls,0);
  const exported=await request('GET',owned+'/handoff.csv',entities[0].auth);
  assert.equal(exported.status,200);
  assert.equal(exported.bytes.subarray(0,3).toString('hex'),'efbbbf');
  for(const item of entities)
    assert.equal(exported.bytes.toString('utf8').includes(item.email),false);
  assert.equal(exported.bytes.toString('utf8').includes('ПЕРВОЕ РАЗРЕШЕНИЕ НА ЗАПУСК'),false);
});
test('R26 PostgreSQL FORCE RLS, immutable trigger and STOP veto with zero writes',async()=>{
  const flags=(await admin.query(
    "SELECT relrowsecurity,relforcerowsecurity FROM pg_class"+
    " WHERE oid='industry.guest_r26_source_reviews'::regclass"
  )).rows[0];
  assert.deepEqual(flags,{relrowsecurity:true,relforcerowsecurity:true});
  const client=await pool.connect();
  try{
    await client.query('BEGIN READ ONLY');
    await client.query("SELECT set_config('app.tenant_id',$1,true)",
      [entities[2].tenant]);
    assert.equal((await client.query(
      'SELECT id FROM industry.guest_r26_source_reviews')).rowCount,0);
    const grants=await client.query(
      "SELECT has_table_privilege(current_user,'industry.guest_r26_source_reviews',"+
      "'UPDATE') AS can_update,has_table_privilege(current_user,"+
      "'industry.guest_r26_source_reviews','DELETE') AS can_delete");
    assert.equal(grants.rows[0].can_update,false);
    assert.equal(grants.rows[0].can_delete,false);
    await client.query('ROLLBACK');
  }finally{client.release();}
  await assert.rejects(admin.query(
    "UPDATE industry.guest_r26_source_reviews SET verdict='rejected'"),
    /append-only/);
  await assert.rejects(admin.query(
    'DELETE FROM industry.guest_r26_source_reviews'),/append-only/);
  await admin.query(
    "INSERT INTO industry.guest_pilot_holds"+
    "(tenant_id,pilot_id,active,reason_code,held_by)"+
    "VALUES($1,$2,true,'data_quality',$3)",
    [entities[0].tenant,pilot,entities[0].account]
  );
  const stopped=(await request('GET',path()+'/reliability',entities[0].auth)).value;
  assert.equal(stopped.stopActive,true);
  assert.equal(stopped.reviewEnabled,false);
  assert.equal(stopped.decision.firstAction.code,'SAFETY_STOP');
  assert.equal((await request('POST',path()+'/source-review',
    entities[1].auth,{...ownerInput,expectedVersion:initial.version+1},
    {'Idempotency-Key':'r26-after-stop-'+tag})).status,409);
  process.env.GUEST_R26_SOURCE_REVIEW_ENABLED='false';
  assert.equal((await request('POST',path()+'/source-review',
    entities[0].auth,{...ownerInput,expectedVersion:initial.version+1},
    {'Idempotency-Key':'r26-feature-off-'+tag})).status,503);
  const unchanged=(await admin.query(
    'SELECT count(*)::int AS n FROM industry.guest_r26_source_reviews'
  )).rows[0].n;
  assert.equal(unchanged,2);
  const stopped=await request('GET','/guest/pilots/'+pilot+'/r27/readiness',
    entities[0].auth);
  assert.equal(stopped.status,200);
  assert.equal(stopped.value.decision.stage,'SAFETY_HOLD');
  assert.equal(stopped.value.customerGo,false);
  assert.equal(stopped.value.productionAuthorized,false);
});
