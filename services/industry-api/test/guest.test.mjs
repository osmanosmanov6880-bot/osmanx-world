import test, {before,after} from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import {randomUUID,createHash} from 'node:crypto';
import {hashPassword} from '../src/password.mjs';
import {buildApp} from '../src/app.mjs';
import {makePool,withTenant} from '../src/database.mjs';

const PREFIX='/api/industry/v1';
const G='/guest';
const admin=new pg.Pool({connectionString:process.env.MIGRATION_DB_URL});
const db=makePool(process.env.DATABASE_URL);
const stamp=randomUUID().slice(0,8);
const secret='GuestR4-Integration-Test-Strong-2026!';
const tenants=[
  {slug:'guest-a-'+stamp,email:'guest-a-'+stamp+'@example.test',vertical:'cafe'},
  {slug:'guest-b-'+stamp,email:'guest-b-'+stamp+'@example.test',vertical:'auto'}
];
const employees=[
  {email:'guest-manager-'+stamp+'@example.test',role:'manager',tenant:0},
  {email:'guest-viewer-'+stamp+'@example.test',role:'viewer',tenant:0},
  {email:'guest-operator-'+stamp+'@example.test',role:'operator',tenant:0}
];
const plan={baselinePct:20,liftPp:10,margin:250,discount:10,fixed:200,fee:25000};
const protocol={startDate:'2026-11-01',endDate:'2026-11-16',outcomeWindowDays:1,allocation:'random',source:'pos',primaryMetric:'repeat_visit'};
const checks={repeatDefinition:true,sameWindow:true,independentGroups:true,marginVerified:true,
  contactConsent:true,ownerAgreed:true};
const period1={date:'2026-11-02',control:400,controlReturn:80,offer:400,offerReturn:120};
const period2={date:'2026-11-09',control:400,controlReturn:80,offer:400,offerReturn:120};
let app,owner,other,manager,viewer,operator;
let requestId,pilotId,currentVersion,evidenceDigest,firstObsId,secondObsId;
const getJson=response=>response.json();
const bodyIs=(r,status)=>{assert.equal(r.statusCode,status,r.body);return r.json()};
function sessionFrom(res){
  const all=[].concat(res.headers['set-cookie']||[]);
  const cookies=all.map(v=>v.split(';')[0]).join('; ');
  const csrf=all.map(v=>v.split(';')[0]).find(v=>v.startsWith('osmanx_industry_csrf='))||'';
  return {cookies,csrf:csrf.split('=').slice(1).join('=')};
}
const request=(method,url,auth,body,headers={})=>app.inject({
  method,url:PREFIX+url,headers:{...(auth?{cookie:auth.cookies,'x-csrf-token':auth.csrf}:{}),...headers},
  ...(body!==undefined?{payload:body}:{})
});
const sha=data=>createHash('sha256').update(JSON.stringify(data)).digest('hex');
async function login(t,email){
  const r=await request('POST','/auth/login',null,{tenantSlug:t.slug,email,password:secret});
  bodyIs(r,200);
  return sessionFrom(r);
}
async function newAccount(email){
  const x=await admin.query('INSERT INTO industry.accounts(email,password_hash) VALUES($1,$2) RETURNING id',
    [email,await hashPassword(secret)]);
  return x.rows[0].id;
}
before(async()=>{
  for(const t of tenants){
    t.id=(await admin.query('INSERT INTO industry.tenants(slug,name,vertical) VALUES($1,$2,$3) RETURNING id',
      [t.slug,'Guest Pilot '+t.slug,t.vertical])).rows[0].id;
    t.owner=await newAccount(t.email);
    await admin.query("INSERT INTO industry.memberships(tenant_id,account_id,role) VALUES($1,$2,'owner')",[t.id,t.owner]);
  }
  for(const worker of employees){
    worker.account=await newAccount(worker.email);
    await admin.query('INSERT INTO industry.memberships(tenant_id,account_id,role) VALUES($1,$2,$3)',
      [tenants[worker.tenant].id,worker.account,worker.role]);
  }
  app=await buildApp(db);
  owner=await login(tenants[0],tenants[0].email);
  other=await login(tenants[1],tenants[1].email);
  manager=await login(tenants[0],employees[0].email);
  viewer=await login(tenants[0],employees[1].email);
  operator=await login(tenants[0],employees[2].email);
});
after(async()=>{
  if(app)await app.close();
  await db.end();await admin.end();
});

test('R4 block 1: tenant tables use FORCE RLS; app role cannot see another company',async()=>{
  for(const table of ['guest_requests','guest_pilots','guest_observations','guest_reviews']){
    const q=await admin.query(
      'SELECT relrowsecurity,relforcerowsecurity FROM pg_class WHERE oid=$1::regclass',['industry.'+table]);
    assert.equal(q.rows[0].relrowsecurity,true);
    assert.equal(q.rows[0].relforcerowsecurity,true);
  }
  assert.equal((await db.query('SELECT * FROM industry.guest_pilots')).rowCount,0);
  assert.equal((await request('GET',G+'/requests',null)).statusCode,401);
  assert.equal((await request('GET',G+'/pilots',null)).statusCode,401);
  const withoutCsrf=await app.inject({
    method:'POST',url:PREFIX+G+'/requests',
    headers:{cookie:owner.cookies,'idempotency-key':'without-csrf-2026'},
    payload:{title:'Не создавать без CSRF',source:'field'}
  });
  assert.equal(withoutCsrf.statusCode,403);
});

test('R4 block 2: lead intake, idempotent replay, conflict and role permissions',async()=>{
  const payload={title:'Пилот повторных визитов',source:'field'};
  const headers={'idempotency-key':'guest-lead-001-'+stamp};
  const created=bodyIs(await request('POST',G+'/requests',owner,payload,headers),201);
  requestId=created.item.id;
  assert.match(requestId,/^[a-f0-9-]{36}$/);
  const repeated=bodyIs(await request('POST',G+'/requests',owner,payload,headers),200);
  assert.equal(repeated.duplicate,true);
  assert.equal(repeated.item.id,requestId);
  assert.equal((await request('POST',G+'/requests',owner,{...payload,title:'Другое предложение'},headers)).statusCode,409);
  assert.equal((await request('POST',G+'/requests',viewer,payload,{'idempotency-key':'view-lead-001'})).statusCode,403);
  assert.equal((await request('POST',G+'/requests',owner,{...payload,phone:'000'},headers)).statusCode,400);
  assert.equal((await request('POST',G+'/requests',owner,payload)).statusCode,400);
  assert.equal(getJson(await request('GET',G+'/requests',owner)).items.length,1);
  assert.equal(getJson(await request('GET',G+'/requests',other)).items.length,0);
  assert.equal((await request('PATCH',G+'/requests/'+requestId,other,{state:'qualified'})).statusCode,404);
  assert.equal((await request('PATCH',G+'/requests/'+requestId,operator,{state:'qualified'})).statusCode,403);
  const update=bodyIs(await request('PATCH',G+'/requests/'+requestId,owner,{state:'qualified'}),200);
  assert.equal(update.item.state,'qualified');
  assert.equal((await request('PATCH',G+'/requests/'+requestId,owner,{state:'qualified'})).statusCode,409);
});

test('R4 block 3: convert qualified request and create tenant-isolated draft pilot',async()=>{
  assert.equal((await request('POST',G+'/pilots',viewer,{title:'Нельзя',plan})).statusCode,403);
  assert.equal((await request('POST',G+'/pilots',owner,{title:'Недопустимый план',plan:{...plan,email:'leak@example.test'}})).statusCode,400);
  assert.equal((await request('POST',G+'/pilots',owner,{title:'Недопустимая цель',plan:{...plan,liftPp:0}})).statusCode,400);
  assert.equal((await request('POST',G+'/pilots',other,{title:'Чужая заявка',plan,requestId,protocol})).statusCode,404);
  const created=bodyIs(await request('POST',G+'/pilots',owner,{title:'Guest pilot R4 — пилот кофейни',plan,requestId,protocol}),201);
  pilotId=created.item.id;currentVersion=created.item.version;
  assert.equal(created.item.phase,'draft');
  assert.ok(created.item.targetPerGroup>200);
  assert.equal(getJson(await request('GET',G+'/requests',owner)).items[0].state,'converted');
  assert.equal((await request('POST',G+'/pilots',owner,{title:'Повтор',plan,requestId,protocol})).statusCode,409);
  assert.equal((await request('GET',G+'/pilots/'+pilotId,other)).statusCode,404);
  assert.equal(getJson(await request('GET',G+'/pilots',other)).items.length,0);
  const direct=await withTenant(db,tenants[1].id,async conn=>
    conn.query('SELECT id FROM industry.guest_pilots WHERE tenant_id=$1',[tenants[0].id]));
  assert.equal(direct.rowCount,0);
  assert.equal((await request('POST',G+'/pilots/'+pilotId+'/start',owner,{expectedVersion:currentVersion})).statusCode,409);
});

test('R4 block 3: readiness, strict allowlist and optimistic version transitions',async()=>{
  const missing={...checks,contactConsent:false};
  const incomplete=bodyIs(await request('PATCH',G+'/pilots/'+pilotId+'/readiness',manager,{
    expectedVersion:currentVersion,readiness:missing
  }),200);
  assert.equal(incomplete.ready,false);currentVersion=incomplete.item.version;
  assert.equal((await request('POST',G+'/pilots/'+pilotId+'/start',owner,{expectedVersion:currentVersion})).statusCode,409);
  assert.equal((await request('PATCH',G+'/pilots/'+pilotId+'/readiness',viewer,{
    expectedVersion:currentVersion,readiness:checks
  })).statusCode,403);
  assert.equal((await request('PATCH',G+'/pilots/'+pilotId+'/readiness',manager,{
    expectedVersion:currentVersion-1,readiness:checks
  })).statusCode,409);
  assert.equal((await request('PATCH',G+'/pilots/'+pilotId+'/readiness',manager,{
    expectedVersion:currentVersion,readiness:{...checks,customerName:'Private'}
  })).statusCode,400);
  const good=bodyIs(await request('PATCH',G+'/pilots/'+pilotId+'/readiness',manager,{
    expectedVersion:currentVersion,readiness:checks
  }),200);
  assert.equal(good.ready,true);currentVersion=good.item.version;
  const started=bodyIs(await request('POST',G+'/pilots/'+pilotId+'/start',owner,{expectedVersion:currentVersion}),200);
  assert.equal(started.item.phase,'running');currentVersion=started.item.version;
  assert.equal((await request('PATCH',G+'/pilots/'+pilotId+'/readiness',owner,{
    expectedVersion:currentVersion,readiness:checks
  })).statusCode,409);
});

test('R4 block 4: validate, add, replay, correct without altering old evidence',async()=>{
  assert.equal((await request('POST',G+'/pilots/'+pilotId+'/observations',viewer,{
    expectedVersion:currentVersion,observation:period1},{'idempotency-key':'viewer-not-allowed'})).statusCode,403);
  assert.equal((await request('POST',G+'/pilots/'+pilotId+'/observations',owner,{
    expectedVersion:currentVersion,observation:{...period1,phone:'123'}
  },{'idempotency-key':'bad-period-001'})).statusCode,400);
  assert.equal((await request('POST',G+'/pilots/'+pilotId+'/observations',owner,{
    expectedVersion:currentVersion,observation:{...period1,offerReturn:401}
  },{'idempotency-key':'bad-period-002'})).statusCode,400);
  const payload={expectedVersion:currentVersion,observation:period1};
  const idempotent={'idempotency-key':'obs-period-1-'+stamp};
  const first=bodyIs(await request('POST',G+'/pilots/'+pilotId+'/observations',operator,payload,idempotent),201);
  firstObsId=first.observationId;currentVersion=first.version;
  const duplicate=bodyIs(await request('POST',G+'/pilots/'+pilotId+'/observations',operator,payload,idempotent),200);
  assert.equal(duplicate.duplicate,true);assert.equal(duplicate.observationId,firstObsId);
  assert.equal((await request('POST',G+'/pilots/'+pilotId+'/observations',operator,{
    expectedVersion:currentVersion,observation:{...period1,controlReturn:81}
  },idempotent)).statusCode,409);
  assert.equal((await request('POST',G+'/pilots/'+pilotId+'/observations',operator,{
    expectedVersion:currentVersion,observation:period1
  },{'idempotency-key':'obs-duplicate-date-'+stamp})).statusCode,409);
  const voided=bodyIs(await request('POST',G+'/pilots/'+pilotId+'/observations/'+firstObsId+'/void',manager,{
    expectedVersion:currentVersion
  }),200);
  currentVersion=voided.version;assert.equal(voided.voided,true);
  assert.equal((await request('POST',G+'/pilots/'+pilotId+'/observations/'+firstObsId+'/void',manager,{
    expectedVersion:currentVersion
  })).statusCode,404);
  const reenter=bodyIs(await request('POST',G+'/pilots/'+pilotId+'/observations',owner,{
    expectedVersion:currentVersion,observation:period1
  },{'idempotency-key':'obs-period-1-replacement-'+stamp}),201);
  currentVersion=reenter.version;
  assert.notEqual(reenter.observationId,firstObsId);
  const second=bodyIs(await request('POST',G+'/pilots/'+pilotId+'/observations',owner,{
    expectedVersion:currentVersion,observation:period2
  },{'idempotency-key':'obs-period-2-'+stamp}),201);
  secondObsId=second.observationId;currentVersion=second.version;
  const detail=bodyIs(await request('GET',G+'/pilots/'+pilotId,owner),200);
  assert.equal(detail.observations.length,2,'Voided observations must not contribute to totals');
  assert.equal((await request('GET',G+'/pilots/'+pilotId,other)).statusCode,404);
  const summary=bodyIs(await request('GET',G+'/pilots/'+pilotId+'/report',viewer),200);
  assert.equal(summary.analysis.aggregate.control,800);
  assert.equal(summary.analysis.aggregate.offerReturn,240);
  assert.equal(summary.analysis.enough,true);
  assert.equal(summary.analysis.associationOnly,true);
  assert.equal(summary.item.phase,'running');
});

test('R4 block 5: submit evidence, two-person review, rejection and resubmission',async()=>{
  assert.equal((await request('POST',G+'/pilots/'+pilotId+'/submit',viewer,{
    expectedVersion:currentVersion
  })).statusCode,403);
  const submitted=bodyIs(await request('POST',G+'/pilots/'+pilotId+'/submit',owner,{
    expectedVersion:currentVersion
  }),200);
  currentVersion=submitted.item.version;evidenceDigest=submitted.evidenceDigest;
  assert.match(evidenceDigest,/^[a-f0-9]{64}$/);
  assert.equal(submitted.item.phase,'in_review');
  assert.equal((await request('POST',G+'/pilots/'+pilotId+'/observations',operator,{
    expectedVersion:currentVersion,observation:{...period2,date:'2026-11-16'}
  },{'idempotency-key':'after-submission-'+stamp})).statusCode,409);
  assert.equal((await request('POST',G+'/pilots/'+pilotId+'/review',owner,{
    expectedVersion:currentVersion,decision:'accept_for_discussion',evidenceDigest
  })).statusCode,403);
  assert.equal((await request('POST',G+'/pilots/'+pilotId+'/review',manager,{
    expectedVersion:currentVersion,decision:'accept_for_discussion',evidenceDigest:sha('wrong')
  })).statusCode,409);
  const returned=bodyIs(await request('POST',G+'/pilots/'+pilotId+'/review',manager,{
    expectedVersion:currentVersion,decision:'request_revision',evidenceDigest
  }),200);
  assert.equal(returned.item.phase,'returned');currentVersion=returned.item.version;
  assert.equal((await request('POST',G+'/pilots/'+pilotId+'/submit',owner,{
    expectedVersion:currentVersion
  })).statusCode,409);
  const resumed=bodyIs(await request('POST',G+'/pilots/'+pilotId+'/resume',owner,{
    expectedVersion:currentVersion
  }),200);
  assert.equal(resumed.item.phase,'running');currentVersion=resumed.item.version;
  const resubmitted=bodyIs(await request('POST',G+'/pilots/'+pilotId+'/submit',owner,{
    expectedVersion:currentVersion
  }),200);
  currentVersion=resubmitted.item.version;
  assert.equal(resubmitted.evidenceDigest,evidenceDigest,'No aggregate inputs changed');
  const accepted=bodyIs(await request('POST',G+'/pilots/'+pilotId+'/review',manager,{
    expectedVersion:currentVersion,decision:'accept_for_discussion',evidenceDigest
  }),200);
  assert.equal(accepted.item.phase,'reviewed');
  assert.match(accepted.disclaimer,/не доказывает/);
  currentVersion=accepted.item.version;
  assert.equal((await request('POST',G+'/pilots/'+pilotId+'/review',manager,{
    expectedVersion:currentVersion,decision:'accept_for_discussion',evidenceDigest
  })).statusCode,409);
  const detail=bodyIs(await request('GET',G+'/pilots/'+pilotId,owner),200);
  assert.deepEqual(detail.reviews.map(x=>x.decision).sort(),['accept_for_discussion','request_revision']);
  assert.equal(detail.observations.length,2);
});

test('R4 block 5: report and CSV never claim payment; audit, outbox and tenant isolation',async()=>{
  const report=bodyIs(await request('GET',G+'/pilots/'+pilotId+'/report',owner),200);
  assert.equal(report.item.phase,'reviewed');
  assert.equal(report.evidenceDigest,evidenceDigest);
  assert.equal(report.analysis.aggregate.control,800);
  assert.equal(report.analysis.aggregate.offer,800);
  assert.equal(report.analysis.financial.costs,33200);
  assert.equal(report.analysis.associationOnly,true);
  assert.match(report.report,/НЕТ ГАРАНТИРОВАННОЙ ПРИБЫЛИ/);
  const csv=await request('GET',G+'/pilots/'+pilotId+'/report.csv',viewer);
  assert.equal(csv.statusCode,200,csv.body);
  assert.match(csv.headers['content-type'],/text\/csv/);
  assert.match(csv.body,/Итого/);
  assert.doesNotMatch(csv.body,/guest-a-|guest-manager|@example\.test/);
  assert.equal((await request('GET',G+'/pilots/'+pilotId+'/report.csv',other)).statusCode,404);
  const audit=bodyIs(await request('GET','/audit',owner),200);
  for(const event of ['guest.request.created','guest.pilot.created','guest.observation.added','guest.observation.voided','guest.pilot.submitted','guest.pilot.reviewed']){
    assert.ok(audit.items.some(x=>x.action===event),event);
  }
  const outbox=await withTenant(db,tenants[0].id,async conn=>
    conn.query("SELECT kind,payload FROM industry.outbox WHERE tenant_id=$1 AND kind LIKE 'guest.%'",[tenants[0].id]));
  assert.ok(outbox.rowCount>=10);
  assert.ok(outbox.rows.every(x=>!JSON.stringify(x.payload).includes('@example.test')));
  const foreign=await withTenant(db,tenants[1].id,async conn=>
    conn.query('SELECT id FROM industry.guest_observations WHERE tenant_id=$1',[tenants[0].id]));
  assert.equal(foreign.rowCount,0);
});

test('R4 concurrency: duplicate observation key is single durable record',async()=>{
  const created=bodyIs(await request('POST',G+'/pilots',owner,{
    title:'Конкурентный пилот',plan,protocol
  }),201).item;
  const ready=bodyIs(await request('PATCH',G+'/pilots/'+created.id+'/readiness',owner,{
    expectedVersion:created.version,readiness:checks
  }),200).item;
  const started=bodyIs(await request('POST',G+'/pilots/'+created.id+'/start',owner,{
    expectedVersion:ready.version
  }),200).item;
  const key='concurrent-write-'+stamp;
  const [a,b]=await Promise.all([
    request('POST',G+'/pilots/'+created.id+'/observations',owner,{
      expectedVersion:started.version,observation:period1
    },{'idempotency-key':key}),
    request('POST',G+'/pilots/'+created.id+'/observations',owner,{
      expectedVersion:started.version,observation:period1
    },{'idempotency-key':key})
  ]);
  assert.deepEqual([a.statusCode,b.statusCode].sort(),[200,201]);
  assert.equal(getJson(a).observationId,getJson(b).observationId);
  const observations=getJson(await request('GET',G+'/pilots/'+created.id,owner)).observations;
  assert.equal(observations.length,1);
});
