// Guest R8 integration: 3 tenants, real PostgreSQL RLS, immutable protocol and quotas.
import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import {createHash,randomUUID} from 'node:crypto';
import {hashPassword} from '../src/password.mjs';
import {makePool,withTenant} from '../src/database.mjs';
import {buildApp} from '../src/app.mjs';

const db=makePool(process.env.DATABASE_URL);
const admin=new pg.Pool({connectionString:process.env.MIGRATION_DB_URL});
const P='/api/industry/v1',G='/guest',tag=randomUUID().slice(0,8);
const pass='R8-Independent-Strong-2026!@';
const tenants=[0,1,2].map(n=>({slug:'r8-tenant-'+n+'-'+tag,email:'r8-owner-'+n+'-'+tag+'@example.test'}));
const protocol={
  startDate:'2026-11-01',endDate:'2026-11-16',outcomeWindowDays:1,
  allocation:'random',source:'pos',primaryMetric:'repeat_visit'
};
const plan={baselinePct:20,liftPp:10,margin:250,discount:10,fixed:100,fee:25000};
const readiness=Object.fromEntries(['repeatDefinition','sameWindow','independentGroups',
  'marginVerified','contactConsent','ownerAgreed'].map(x=>[x,true]));
const validRow={date:'2026-11-09',control:900,controlReturn:180,offer:900,offerReturn:270};
const request=(method,path,who,payload,headers={})=>app.inject({
  method,url:P+path,headers:{
    ...(who?{cookie:who.cookie,'x-csrf-token':who.csrf}:{}),...headers
  },...(payload===undefined?{}:{payload})
});
const expect=(response,status)=>{assert.equal(response.statusCode,status,response.body);return response.json();};
let app,owner,reviewer,other,quotaOwner;
function parseCookies(res){
  const set=[].concat(res.headers['set-cookie']||[]);
  const pairs=set.map(s=>s.split(';')[0]);
  const csrf=pairs.find(v=>v.startsWith('osmanx_industry_csrf='))||'';
  return {cookie:pairs.join('; '),csrf:csrf.slice(csrf.indexOf('=')+1)};
}
async function login(slug,email){
  return parseCookies(expectResponse(await request('POST','/auth/login',null,{tenantSlug:slug,email,password:pass})));
}
function expectResponse(r){assert.equal(r.statusCode,200,r.body);return r}
async function newAccount(email){
  const r=await admin.query('INSERT INTO industry.accounts(email,password_hash) VALUES($1,$2) RETURNING id',
    [email,await hashPassword(pass)]);
  return r.rows[0].id;
}
before(async()=>{
  for(const t of tenants){
    t.id=(await admin.query("INSERT INTO industry.tenants(slug,name,vertical) VALUES($1,$2,'cafe') RETURNING id",
      [t.slug,'R8 synthetic '+t.slug])).rows[0].id;
    t.account=await newAccount(t.email);
    await admin.query("INSERT INTO industry.memberships(tenant_id,account_id,role) VALUES($1,$2,'owner')",
      [t.id,t.account]);
  }
  const email='r8-manager-'+tag+'@example.test';
  const managerId=await newAccount(email);
  await admin.query("INSERT INTO industry.memberships(tenant_id,account_id,role) VALUES($1,$2,'manager')",
    [tenants[0].id,managerId]);
  app=await buildApp(db);
  owner=await login(tenants[0].slug,tenants[0].email);
  reviewer=await login(tenants[0].slug,email);
  other=await login(tenants[1].slug,tenants[1].email);
  quotaOwner=await login(tenants[2].slug,tenants[2].email);
});
after(async()=>{if(app)await app.close();await db.end();await admin.end();});

test('R8 block 1: protocol mandatory, exactly validated, immutable at PostgreSQL',async()=>{
  assert.equal((await request('POST',G+'/pilots',owner,{title:'No protocol',plan})).statusCode,400);
  assert.equal((await request('POST',G+'/pilots',owner,{title:'Unknown assignment',plan,
    protocol:{...protocol,allocation:'unknown'}})).statusCode,400);
  assert.equal((await request('POST',G+'/pilots',owner,{title:'Unknown data source',plan,
    protocol:{...protocol,source:'personally_identifiable'}})).statusCode,400);
  assert.equal((await request('POST',G+'/pilots',owner,{title:'Unexpected hidden fields',plan,
    protocol:{...protocol,phone:'1234567890'}})).statusCode,400);
  assert.equal((await request('POST',G+'/pilots',owner,{title:'Email victim@example.org',plan,protocol})).statusCode,400);
  assert.equal((await request('POST',G+'/requests',owner,{
    title:'Call +7 999 123 45 67',source:'field'
  },{'idempotency-key':'r8-pii-refuse-'+tag})).statusCode,400);
  const created=expect(await request('POST',G+'/pilots',owner,{
    title:'R8 frozen protocol synthetic pilot',plan,protocol
  }),201).item;
  assert.equal(created.protocol.source,'pos');
  assert.equal(created.protocol.primaryMetric,'repeat_visit');
  assert.equal(created.prospectivelyRegistered,false,'Historical protocol must not pretend preregistration');
  assert.ok(created.protocolRegisteredAt);
  const checked=await admin.query('SELECT protocol,protocol_registered_at FROM industry.guest_pilots WHERE id=$1',[created.id]);
  assert.deepEqual(checked.rows[0].protocol,protocol);
  await assert.rejects(
    admin.query("UPDATE industry.guest_pilots SET protocol=jsonb_set(protocol,'{source}','\"manual\"'::jsonb) WHERE id=$1",[created.id]),
    e=>e.code==='23514'
  );
  const saved=await request('GET',G+'/pilots/'+created.id,owner);
  assert.equal(expect(saved,200).item.protocol.source,'pos');
  assert.equal((await request('GET',G+'/pilots/'+created.id,other)).statusCode,404);
});

test('R8 block 2: temporal bounds, fixed outcome window and evidence v2',async()=>{
  let pilot=expect(await request('POST',G+'/pilots',owner,{
    title:'R8 evidence v2 synthetic experiment',plan,protocol
  }),201).item;
  pilot=expect(await request('PATCH',G+'/pilots/'+pilot.id+'/readiness',owner,{
    expectedVersion:pilot.version,readiness
  }),200).item;
  pilot=expect(await request('POST',G+'/pilots/'+pilot.id+'/start',owner,{
    expectedVersion:pilot.version
  }),200).item;
  const attempt=(observation,key)=>request('POST',G+'/pilots/'+pilot.id+'/observations',owner,{
    expectedVersion:pilot.version,observation
  },{'idempotency-key':key+'-'+tag});
  assert.equal((await attempt({...validRow,date:'2026-10-31'},'r8-before')).statusCode,409);
  assert.equal((await attempt({...validRow,date:'2026-11-17'},'r8-after')).statusCode,409);
  const observed=expect(await attempt(validRow,'r8-accepted'),201);pilot.version=observed.version;
  const submitted=expect(await request('POST',G+'/pilots/'+pilot.id+'/submit',owner,{
    expectedVersion:pilot.version
  }),200);
  assert.equal(submitted.item.phase,'in_review');
  const review=expect(await request('POST',G+'/pilots/'+pilot.id+'/review',reviewer,{
    expectedVersion:submitted.item.version,decision:'accept_for_discussion',
    evidenceDigest:submitted.evidenceDigest
  }),200);
  const evidence=expect(await request('GET',G+'/pilots/'+pilot.id+'/evidence.json',owner),200);
  assert.equal(evidence.evidence.schema,'osmanx.guest.evidence.v2');
  assert.deepEqual(evidence.evidence.protocol,protocol);
  assert.ok(evidence.evidence.protocolRegisteredAt);
  assert.equal(evidence.sha256,createHash('sha256').update(JSON.stringify(evidence.evidence)).digest('hex'));
  assert.equal(evidence.sha256,submitted.evidenceDigest);
  assert.match(expect(await request('GET',G+'/pilots/'+pilot.id+'/report',owner),200).report,/РЕТРОСПЕКТИВНЫЙ РИСК/);
  const archive=expect(await request('POST',G+'/pilots/'+pilot.id+'/archive',owner,{
    expectedVersion:review.item.version,reason:'Сценарный пилот архивирован после проверки'
  }),200);
  assert.equal(archive.sha256,evidence.sha256);
  const futureStart=new Date(Date.now()+86400000).toISOString().slice(0,10);
  const futureEnd=new Date(Date.now()+3*86400000).toISOString().slice(0,10);
  const futureProtocol={...protocol,startDate:futureStart,endDate:futureEnd};
  let futurePilot=expect(await request('POST',G+'/pilots',owner,{
    title:'R8 future synthetic experiment',plan,protocol:futureProtocol
  }),201).item;
  futurePilot=expect(await request('PATCH',G+'/pilots/'+futurePilot.id+'/readiness',owner,{
    expectedVersion:futurePilot.version,readiness
  }),200).item;
  futurePilot=expect(await request('POST',G+'/pilots/'+futurePilot.id+'/start',owner,{
    expectedVersion:futurePilot.version
  }),200).item;
  assert.equal((await request('POST',G+'/pilots/'+futurePilot.id+'/observations',owner,{
    expectedVersion:futurePilot.version,observation:{...validRow,date:futureStart}
  },{'idempotency-key':'r8-future-'+tag})).statusCode,409);
  assert.equal((await request('POST',G+'/pilots/'+futurePilot.id+'/submit',owner,{
    expectedVersion:futurePilot.version
  })).statusCode,409,'Future outcome window cannot be finalized');
});

test('R8 block 3: quotas remain tenant scoped, concurrent writers serialize',async()=>{
  await admin.query('INSERT INTO industry.guest_quotas(tenant_id,annual_request_limit,active_pilot_limit) VALUES($1,1,1)',
    [tenants[2].id]);
  const headers=i=>({'idempotency-key':'r8-quota-'+i+'-'+tag});
  const [a,b]=await Promise.all([
    request('POST',G+'/requests',quotaOwner,{title:'First quota request',source:'site'},headers('one')),
    request('POST',G+'/requests',quotaOwner,{title:'Second quota request',source:'field'},headers('two'))
  ]);
  assert.deepEqual([a.statusCode,b.statusCode].sort(),[201,429]);
  const requests=expect(await request('GET',G+'/requests',quotaOwner),200);
  assert.equal(requests.items.length,1);
  const one=expect(await request('POST',G+'/pilots',quotaOwner,{
    title:'First active quota pilot',plan,protocol
  }),201).item;
  assert.equal((await request('POST',G+'/pilots',quotaOwner,{
    title:'Second active quota pilot',plan,protocol
  })).statusCode,429);
  const overview=expect(await request('GET',G+'/overview',quotaOwner),200);
  assert.equal(overview.quotas.requests.used,1);
  assert.equal(overview.quotas.requests.limit,1);
  assert.equal(overview.quotas.activePilots.used,1);
  assert.equal(overview.quotas.activePilots.limit,1);
  assert.equal(overview.pilots.draft,1);
  assert.ok(one.protocol);
  assert.equal((await request('GET',G+'/overview',null)).statusCode,401);
  // A different tenant's commercial counts must remain isolated.
  const foreignOverview=expect(await request('GET',G+'/overview',other),200);
  assert.equal(foreignOverview.quotas.requests.used,0);
  assert.equal(foreignOverview.pilots.draft,0);
  assert.doesNotMatch(JSON.stringify(overview),/@example\.test|First quota request/);
});

test('R8 block 4: owner-only bounded 90-day redaction preserves audit, IDs and tenant isolation',async()=>{
  const lead=expect(await request('POST',G+'/requests',owner,{
    title:'Old non-personal declined inquiry',source:'field'
  },{'idempotency-key':'r8-retention-'+tag}),201).item;
  expect(await request('PATCH',G+'/requests/'+lead.id,owner,{state:'declined'}),200);
  await admin.query("UPDATE industry.guest_requests SET updated_at=now()-interval '100 days' WHERE id=$1",[lead.id]);
  assert.equal((await request('POST',G+'/requests/retention',reviewer,{confirm:true})).statusCode,403);
  assert.equal((await request('POST',G+'/requests/retention',owner,{confirm:false})).statusCode,400);
  const cleaned=expect(await request('POST',G+'/requests/retention',owner,{confirm:true}),200);
  assert.equal(cleaned.redacted,1);
  assert.equal(cleaned.policy,'declined-unlinked-older-than-90-days');
  const row=(await admin.query('SELECT title,state,redacted_at FROM industry.guest_requests WHERE id=$1',[lead.id])).rows[0];
  assert.equal(row.state,'declined');assert.ok(row.redacted_at);
  assert.equal(row.title,'Данные удалены по сроку хранения');
  assert.equal(expect(await request('POST',G+'/requests/retention',owner,{confirm:true}),200).redacted,0);
  const audit=expect(await request('GET','/audit',owner),200);
  assert.ok(audit.items.some(x=>x.action==='guest.request.redacted'));
  assert.equal(expect(await request('POST',G+'/requests/retention',other,{confirm:true}),200).redacted,0);
  const cross=await withTenant(db,tenants[1].id,async conn=>
    conn.query('SELECT id FROM industry.guest_requests WHERE tenant_id=$1',[tenants[0].id]));
  assert.equal(cross.rowCount,0);
});
