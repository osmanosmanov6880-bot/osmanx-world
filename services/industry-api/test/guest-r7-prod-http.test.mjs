// R7 real loopback HTTP in actual PRODUCTION configuration, synthetic PostgreSQL only.
// Checks secure cookies, fail-closed writes, true independent tenants and reviewers.
import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import pg from 'pg';
import {hashPassword} from '../src/password.mjs';
import {makePool} from '../src/database.mjs';
import {buildApp} from '../src/app.mjs';

const P='/api/industry/v1',prefix=randomUUID().slice(0,8);
const URL_ORIGIN='https://osmanx.world';
const ownerPass='R7-Owner-Synthetic-Strong-2026!';
const reviewerPass='R7-Reviewer-Synthetic-Strong-2026!';
const tenants=[
  {slug:'r7-stage-a-'+prefix,email:'r7-owner-a-'+prefix+'@example.test'},
  {slug:'r7-stage-b-'+prefix,email:'r7-owner-b-'+prefix+'@example.test'}
];
const managerEmail='r7-reviewer-'+prefix+'@example.test';
const previous={node:process.env.NODE_ENV,origin:process.env.ALLOWED_ORIGIN,
  flag:process.env.GUEST_WRITES_ENABLED};
const admin=new pg.Pool({connectionString:process.env.MIGRATION_DB_URL});
const db=makePool(process.env.DATABASE_URL);
let app,base,authA,authB,manager;
async function call(method,path,auth,body,headers={}){
  const response=await fetch(base+P+path,{
    method,redirect:'error',headers:{
      Accept:'application/json',
      ...(body===undefined?{}:{'Content-Type':'application/json'}),
      ...(method==='GET'?{}:{Origin:URL_ORIGIN}),
      ...(auth?{Cookie:auth.cookie,'X-CSRF-Token':auth.csrf}:{}),
      ...headers
    },
    ...(body===undefined?{}:{body:JSON.stringify(body)})
  });
  return {status:response.status,headers:response.headers,json:await response.json()};
}
function must(result,status){
  assert.equal(result.status,status,JSON.stringify(result.json));
  return result.json;
}
async function login(org,email,password){
  const response=await call('POST','/auth/login',null,{tenantSlug:org.slug,email,password});
  must(response,200);
  const fields=response.headers.getSetCookie();
  assert.ok(fields.length>=2,'Session and CSRF cookies must exist');
  assert.ok(fields.some(v=>v.startsWith('__Host-osmanx_industry_sid=')&&
    v.includes('HttpOnly')&&v.includes('Secure')&&v.includes('SameSite=Strict')),
    'Production SID must be Secure, HttpOnly, Host prefix, Strict');
  const pairs=fields.map(v=>v.split(';')[0]);
  const token=pairs.find(v=>v.startsWith('__Host-osmanx_industry_csrf='));
  assert.ok(token);
  return {cookie:pairs.join('; '),csrf:token.slice(token.indexOf('=')+1)};
}
before(async()=>{
  if(process.env.NODE_ENV!=='test'||!process.env.MIGRATION_DB_URL?.includes('industry_ci'))
    throw Error('R7 production-mode test requires isolated industry_ci service database');
  for(const org of tenants){
    org.id=(await admin.query(
      "INSERT INTO industry.tenants(slug,name,vertical) VALUES($1,$2,'cafe') RETURNING id",
      [org.slug,'R7 synthetic '+org.slug])).rows[0].id;
    const acc=await admin.query('INSERT INTO industry.accounts(email,password_hash) VALUES($1,$2) RETURNING id',
      [org.email,await hashPassword(ownerPass)]);
    org.accountId=acc.rows[0].id;
    await admin.query("INSERT INTO industry.memberships(tenant_id,account_id,role) VALUES($1,$2,'owner')",
      [org.id,org.accountId]);
  }
  process.env.NODE_ENV='production';process.env.ALLOWED_ORIGIN=URL_ORIGIN;
  process.env.GUEST_WRITES_ENABLED='false';
  app=await buildApp(db);
  await app.listen({host:'127.0.0.1',port:0});
  base='http://127.0.0.1:'+app.server.address().port;
  authA=await login(tenants[0],tenants[0].email,ownerPass);
  authB=await login(tenants[1],tenants[1].email,ownerPass);
});
after(async()=>{
  if(app)await app.close();
  await db.end();await admin.end();
  for(const [k,value] of [['NODE_ENV',previous.node],['ALLOWED_ORIGIN',previous.origin],
    ['GUEST_WRITES_ENABLED',previous.flag]])
    if(value===undefined)delete process.env[k];else process.env[k]=value;
});
test('R7 production-mode HTTP: 503 write gate, RLS, origin, auth and independent archive',async()=>{
  const initial=must(await call('GET','/health/ready'),200);
  assert.equal(initial.guestWritesEnabled,false);
  assert.equal(initial.forcedRls,true);
  const intake={title:'R7 synthetic secure company pilot',source:'field'};
  must(await call('POST','/guest/requests',authA,intake,{'Idempotency-Key':'r7-disabled-'+prefix}),503);
  must(await call('GET','/guest/requests',authA),200);
  // Operator switch is not sufficient to bypass existing tenant/cookie/CSRF controls.
  process.env.GUEST_WRITES_ENABLED='true';
  must(await call('POST','/guest/requests',null,intake),401);
  must(await call('POST','/guest/requests',authA,intake,
    {Origin:'https://other-origin.invalid','Idempotency-Key':'r7-wrong-origin-'+prefix}),403);
  must(await call('POST','/guest/requests',null,intake,
    {Cookie:authA.cookie,'Idempotency-Key':'r7-no-csrf-'+prefix}),403);
  const lead=must(await call('POST','/guest/requests',authA,intake,
    {'Idempotency-Key':'r7-lead-'+prefix}),201).item;
  const duplicate=must(await call('POST','/guest/requests',authA,intake,
    {'Idempotency-Key':'r7-lead-'+prefix}),200);
  assert.equal(duplicate.duplicate,true);
  assert.equal(duplicate.item.id,lead.id);
  assert.equal(must(await call('GET','/guest/requests',authB),200).items.length,0);
  must(await call('PATCH','/guest/requests/'+lead.id,authB,{state:'qualified'}),404);
  const invited=must(await call('POST','/staff/invitations',authA,
    {email:managerEmail,role:'manager'}),201);
  must(await call('POST','/staff/invitations/accept',null,{
    token:invited.token,password:reviewerPass
  }),200);
  manager=await login(tenants[0],managerEmail,reviewerPass);
  const managerInfo=must(await call('GET','/auth/me',manager),200);
  assert.notEqual(managerInfo.account.id,tenants[0].accountId);
  must(await call('PATCH','/guest/requests/'+lead.id,manager,{state:'qualified'}),200);
  const plan={baselinePct:20,liftPp:10,margin:250,discount:5,fixed:500,fee:25000};
  const protocol={startDate:'2026-11-01',endDate:'2026-11-16',outcomeWindowDays:1,allocation:'random',source:'pos',primaryMetric:'repeat_visit'};
  let pilot=must(await call('POST','/guest/pilots',authA,{
    title:'R7 production-mode HTTP acceptance',plan,requestId:lead.id,protocol
  }),201).item;
  must(await call('GET','/guest/pilots/'+pilot.id,authB),404);
  const readiness=Object.fromEntries(['repeatDefinition','sameWindow',
    'independentGroups','marginVerified','contactConsent','ownerAgreed'].map(x=>[x,true]));
  pilot=must(await call('PATCH','/guest/pilots/'+pilot.id+'/readiness',manager,{
    expectedVersion:pilot.version,readiness
  }),200).item;
  pilot=must(await call('POST','/guest/pilots/'+pilot.id+'/start',authA,{
    expectedVersion:pilot.version
  }),200).item;
  const recorded=must(await call('POST','/guest/pilots/'+pilot.id+'/observations',authA,{
    expectedVersion:pilot.version,
    observation:{date:'2026-11-09',control:900,controlReturn:180,offer:900,offerReturn:270}
  },{'Idempotency-Key':'r7-observation-'+prefix}),201);
  const submitted=must(await call('POST','/guest/pilots/'+pilot.id+'/submit',authA,{
    expectedVersion:recorded.version
  }),200);
  must(await call('POST','/guest/pilots/'+pilot.id+'/review',authA,{
    expectedVersion:submitted.item.version,decision:'accept_for_discussion',
    evidenceDigest:submitted.evidenceDigest
  }),403);
  const accepted=must(await call('POST','/guest/pilots/'+pilot.id+'/review',manager,{
    expectedVersion:submitted.item.version,decision:'accept_for_discussion',
    evidenceDigest:submitted.evidenceDigest
  }),200);
  const evidence=must(await call('GET','/guest/pilots/'+pilot.id+'/evidence.json',manager),200);
  assert.equal(evidence.sha256,createHash('sha256').update(JSON.stringify(evidence.evidence)).digest('hex'));
  assert.equal(evidence.review.actor_id,managerInfo.account.id);
  const sealed=must(await call('POST','/guest/pilots/'+pilot.id+'/archive',authA,{
    expectedVersion:accepted.item.version,reason:'R7 staged operation verified'
  }),200);
  assert.equal(sealed.item.phase,'archived');
  assert.equal(sealed.sha256,evidence.sha256);
  must(await call('GET','/guest/pilots/'+pilot.id,authB),404);
  const status=must(await call('GET','/health/ready'),200);
  assert.equal(status.guestWritesEnabled,true);
});
