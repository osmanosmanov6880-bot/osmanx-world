// R10: actual loopback HTTP (not Fastify.inject), production cookie and CSRF behavior.
// Uses synthetic industry_ci PostgreSQL and two independent human-like sessions.
import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import pg from 'pg';
import {hashPassword} from '../src/password.mjs';
import {makePool} from '../src/database.mjs';
import {buildApp} from '../src/app.mjs';
import {syntheticPermit} from './r15-synthetic-fixture.mjs';

const P='/api/industry/v1',ORIGIN='https://osmanx.world',tag=randomUUID().slice(0,8);
const password='Synthetic-Owner-R10-Strong-Pass-2026!';
const managerPassword='Synthetic-Manager-R10-Strong-Pass-2026!';
const own={slug:'r10-owner-'+tag,email:'r10-owner-'+tag+'@example.test'};
const foreign={slug:'r10-foreign-'+tag,email:'r10-foreign-'+tag+'@example.test'};
const invited='r10-manager-'+tag+'@example.test';
const prior={node:process.env.NODE_ENV,origin:process.env.ALLOWED_ORIGIN,
  writes:process.env.GUEST_WRITES_ENABLED};
const db=makePool(process.env.DATABASE_URL),admin=new pg.Pool({connectionString:process.env.MIGRATION_DB_URL});
let app,base,owner,outsider,manager,managerId,permitFixture;
const plan={baselinePct:20,liftPp:10,margin:350,discount:12,fixed:1000,fee:25000};
const protocol={startDate:'2026-11-01',endDate:'2026-11-16',
  outcomeWindowDays:1,allocation:'random',source:'pos',primaryMetric:'repeat_visit'};
const checks=Object.fromEntries(['repeatDefinition','sameWindow','independentGroups',
  'marginVerified','contactConsent','ownerAgreed'].map(k=>[k,true]));
const csv='date,control,controlReturn,offer,offerReturn\n'+
  '2026-11-08,900,180,900,270\n2026-11-09,900,180,900,270\n';
async function call(method,path,session,body,headers={}){
  const r=await fetch(base+P+path,{method,redirect:'error',cache:'no-store',
    headers:{Accept:'application/json',...(body===undefined?{}:{'Content-Type':'application/json'}),
      ...(method==='GET'?{}:{Origin:ORIGIN}),
      ...(session?{Cookie:session.cookie,'X-CSRF-Token':session.csrf}:{}),
      ...headers},
    ...(body===undefined?{}:{body:JSON.stringify(body)})
  });
  const contentType=r.headers.get('content-type')||'';
  assert.match(contentType,/application\/json/,method+' '+path);
  return {status:r.status,headers:r.headers,json:await r.json()};
}
function ok(r,status){assert.equal(r.status,status,JSON.stringify(r.json));return r.json}
function cookies(r){
  const set=r.headers.getSetCookie();
  assert.ok(set.length>=2);
  assert.ok(set.some(s=>s.startsWith('__Host-osmanx_industry_sid=')&&
    s.includes('Secure')&&s.includes('HttpOnly')&&s.includes('SameSite=Strict')),
    'Production SID must be Secure, HttpOnly, SameSite Strict, host-bound');
  const p=set.map(x=>x.split(';')[0]);
  const c=p.find(x=>x.startsWith('__Host-osmanx_industry_csrf='));
  assert.ok(c);
  return {cookie:p.join('; '),csrf:c.slice(c.indexOf('=')+1)};
}
async function login(org,email,password){
  return cookies(okResponse(await call('POST','/auth/login',null,
    {tenantSlug:org.slug,email,password})));
}
function okResponse(r){ok(r,200);return r}
before(async()=>{
  const u=new URL(process.env.MIGRATION_DB_URL||'');
  const runtime=new URL(process.env.DATABASE_URL||'');
  if(process.env.NODE_ENV!=='test'||u.hostname!=='127.0.0.1'||
     runtime.hostname!=='127.0.0.1'||u.pathname!=='/industry_ci'||
     runtime.pathname!=='/industry_ci')
    throw Error('R10 real HTTP acceptance is restricted to isolated industry_ci on loopback');
  for(const entity of [own,foreign]){
    entity.id=(await admin.query(
      "INSERT INTO industry.tenants(slug,name,vertical) VALUES($1,$2,'cafe') RETURNING id",
      [entity.slug,'R10 synthetic '+entity.slug])).rows[0].id;
    entity.owner=(await admin.query('INSERT INTO industry.accounts(email,password_hash) VALUES($1,$2) RETURNING id',
      [entity.email,await hashPassword(password)])).rows[0].id;
    await admin.query("INSERT INTO industry.memberships(tenant_id,account_id,role) VALUES($1,$2,'owner')",
      [entity.id,entity.owner]);
  }
  permitFixture=await syntheticPermit(own.id);
  process.env.NODE_ENV='production';
  process.env.ALLOWED_ORIGIN=ORIGIN;
  process.env.GUEST_WRITES_ENABLED='false';
  app=await buildApp(db);
  await app.listen({host:'127.0.0.1',port:0});
  base='http://127.0.0.1:'+app.server.address().port;
  owner=await login(own,own.email,password);
  outsider=await login(foreign,foreign.email,password);
});
after(async()=>{
  if(app)await app.close();
  await db.end();await admin.end();
  if(permitFixture)await permitFixture.cleanup();
  for(const [k,v] of [['NODE_ENV',prior.node],['ALLOWED_ORIGIN',prior.origin],
    ['GUEST_WRITES_ENABLED',prior.writes]]){
    if(v===undefined)delete process.env[k];else process.env[k]=v;
  }
});
test('R10 production-like HTTP: independent users, protected evidence and audited R9 actions through final archive',async()=>{
  const beforeReady=ok(await call('GET','/health/ready'),200);
  assert.equal(beforeReady.schemaVersion,'011_guest_pilot_safety.sql');
  assert.equal(beforeReady.guestWritesEnabled,false);
  assert.equal(beforeReady.forcedRls,true);
  ok(await call('POST','/guest/requests',owner,
    {title:'R10 synthetic intake',source:'field'},
    {'Idempotency-Key':'r10-disabled-'+tag}),503);

  const tokenEnvelope=ok(await call('POST','/staff/invitations',owner,
    {email:invited,role:'manager'}),201);
  assert.match(tokenEnvelope.token,/^[a-f0-9]{64}$/);
  ok(await call('POST','/staff/invitations/accept',null,
    {token:tokenEnvelope.token,password:managerPassword}),200);
  ok(await call('POST','/staff/invitations/accept',null,
    {token:tokenEnvelope.token,password:managerPassword}),404);
  manager=await login(own,invited,managerPassword);
  managerId=ok(await call('GET','/auth/me',manager),200).account.id;
  assert.notEqual(managerId,own.owner);

  process.env.GUEST_WRITES_ENABLED='true';
  // Even with the operator flag, session + origin + CSRF still apply.
  ok(await call('POST','/guest/requests',null,{title:'No cookie',source:'field'},
    {'Idempotency-Key':'r10-noauth-'+tag}),401);
  ok(await call('POST','/guest/requests',owner,{title:'Wrong origin',source:'field'},
    {Origin:'https://untrusted.invalid','Idempotency-Key':'r10-origin-'+tag}),403);
  ok(await call('POST','/guest/requests',null,{title:'Missing CSRF',source:'field'},
    {Cookie:owner.cookie,'Idempotency-Key':'r10-csrf-'+tag}),403);
  const intake=ok(await call('POST','/guest/requests',owner,
    {title:'R10 two-person guest journey',source:'field'},
    {'Idempotency-Key':'r10-intake-'+tag}),201).item;
  ok(await call('PATCH','/guest/requests/'+intake.id,manager,{state:'qualified'}),200);
  assert.equal(ok(await call('GET','/guest/requests',outsider),200).items.length,0);
  let pilot=ok(await call('POST','/guest/pilots',owner,{
    title:'R10 synthetic staged pilot',requestId:intake.id,plan,protocol
  }),201).item;
  const id=pilot.id;
  ok(await call('GET','/guest/pilots/'+id,outsider),404);

  const empty=ok(await call('GET','/guest/pilots/'+id+'/diagnostics',manager),200);
  assert.equal(empty.diagnostic.disposition,'NO_DATA');
  const task=ok(await call('POST','/guest/pilots/'+id+'/actions',owner,{
    expectedPilotVersion:pilot.version,code:'COLLECT_OBSERVATIONS',
    assigneeId:managerId,dueDate:new Date(Date.now()+7*86400000).toISOString().slice(0,10)
  }),201).item;
  ok(await call('PATCH','/guest/pilots/'+id+'/actions/'+task.id,manager,{
    expectedVersion:task.version,status:'in_progress'
  }),200);

  pilot=ok(await call('PATCH','/guest/pilots/'+id+'/readiness',manager,
    {expectedVersion:pilot.version,readiness:checks}),200).item;
  pilot=ok(await call('POST','/guest/pilots/'+id+'/start',owner,
    {expectedVersion:pilot.version}),200).item;
  const endpoint='/guest/pilots/'+id+'/observations/import';
  const preview=ok(await call('POST',endpoint+'/preview',manager,{
    expectedVersion:pilot.version,csv
  }),200);
  assert.equal(preview.summary.rowCount,2);
  assert.equal(preview.summary.totals.control,1800);
  ok(await call('POST',endpoint,owner,{
    expectedVersion:pilot.version,csv,sha256:'0'.repeat(64)
  },{'Idempotency-Key':'r10-false-sha-'+tag}),409);
  const key={'Idempotency-Key':'r10-batch-'+tag};
  const committed=ok(await call('POST',endpoint,manager,{
    expectedVersion:pilot.version,csv,sha256:preview.sha256
  },key),201);
  assert.equal(committed.rowsImported,2);
  const repeated=ok(await call('POST',endpoint,manager,{
    expectedVersion:pilot.version,csv,sha256:preview.sha256
  },key),200);
  assert.equal(repeated.duplicate,true);
  assert.equal(repeated.importId,committed.importId);
  assert.equal(ok(await call('GET','/guest/pilots/'+id,owner),200).observations.length,2);
  const report=ok(await call('GET','/guest/pilots/'+id+'/diagnostics',manager),200);
  assert.equal(report.diagnostic.sample.control,1800);
  assert.equal(report.diagnostic.sample.enough,true);
  const submission=ok(await call('POST','/guest/pilots/'+id+'/submit',owner,{
    expectedVersion:committed.version
  }),200);
  ok(await call('POST','/guest/pilots/'+id+'/review',owner,{
    expectedVersion:submission.item.version,decision:'accept_for_discussion',
    evidenceDigest:submission.evidenceDigest
  }),403);
  const independent=ok(await call('POST','/guest/pilots/'+id+'/review',manager,{
    expectedVersion:submission.item.version,decision:'accept_for_discussion',
    evidenceDigest:submission.evidenceDigest
  }),200);
  const evidence=ok(await call('GET','/guest/pilots/'+id+'/evidence.json',manager),200);
  assert.equal(evidence.evidence.schema,'osmanx.guest.evidence.v2');
  assert.equal(evidence.sha256,createHash('sha256').update(JSON.stringify(evidence.evidence)).digest('hex'));
  assert.equal(evidence.sha256,submission.evidenceDigest);
  assert.equal(evidence.review.actor_id,managerId);
  const archived=ok(await call('POST','/guest/pilots/'+id+'/archive',owner,{
    expectedVersion:independent.item.version,
    reason:'R10 synthetic independent staged acceptance'
  }),200);
  assert.equal(archived.item.phase,'archived');
  assert.equal(archived.sha256,evidence.sha256);
  ok(await call('DELETE','/staff/'+managerId,owner,{}),200);
  const revoked=await call('GET','/guest/pilots/'+id+'/evidence.json',manager);
  assert.ok([401,403].includes(revoked.status));
  assert.equal(ok(await call('GET','/guest/pilots/'+id,owner),200).item.phase,'archived');
  ok(await call('GET','/guest/pilots/'+id,outsider),404);
  const audit=ok(await call('GET','/audit',owner),200);
  assert.ok(audit.items.some(x=>x.action==='guest.observations.batch_imported'));
  assert.ok(audit.items.some(x=>x.action==='guest.pilot.archived'));
  assert.ok(audit.items.some(x=>x.action==='guest.action.in_progress'));
});
