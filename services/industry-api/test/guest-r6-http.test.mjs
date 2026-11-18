// R6 actual HTTP socket acceptance against ephemeral PostgreSQL; never production.
import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import pg from 'pg';
import {hashPassword} from '../src/password.mjs';
import {buildApp} from '../src/app.mjs';
import {makePool} from '../src/database.mjs';

const P='/api/industry/v1',tag=randomUUID().slice(0,8);
const admin=new pg.Pool({connectionString:process.env.MIGRATION_DB_URL});
const db=makePool(process.env.DATABASE_URL);
const org='http-r6-'+tag,email='owner-r6-'+tag+'@example.test';
const reviewerEmail='reviewer-r6-'+tag+'@example.test';
const pass='R6-Synthetic-Testing-Password-2026!',reviewPass='R6-Second-Account-Password-2026!';
let app,base,owner,reviewer;
function session(r){
  const fields=r.headers.getSetCookie().map(x=>x.split(';')[0]);
  return {cookie:fields.join('; '),csrf:(fields.find(x=>x.startsWith('osmanx_industry_csrf='))||'').split('=').slice(1).join('=')};
}
async function http(method,path,auth,body,headers={}){
  const res=await fetch(base+P+path,{method,redirect:'error',headers:{
    Accept:'application/json',...(body===undefined?{}:{'Content-Type':'application/json'}),
    ...(auth?{Cookie:auth.cookie,'X-CSRF-Token':auth.csrf}:{}),...headers
  },...(body===undefined?{}:{body:JSON.stringify(body)})});
  return {code:res.status,data:await res.json(),raw:res};
}
function code(r,status){assert.equal(r.code,status,JSON.stringify(r.data));return r.data;}
async function login(name,pwd){
  const r=await fetch(base+P+'/auth/login',{
    method:'POST',headers:{'Content-Type':'application/json',Origin:'http://localhost'},
    body:JSON.stringify({tenantSlug:org,email:name,password:pwd})
  });
  assert.equal(r.status,200);
  const auth=session(r);assert.ok(auth.csrf.length>30);return auth;
}
before(async()=>{
  if(process.env.NODE_ENV==='production')throw Error('Never run synthetic HTTP test on production');
  const tenant=(await admin.query("INSERT INTO industry.tenants(slug,name,vertical) VALUES($1,'HTTP synthetic','cafe') RETURNING id",[org])).rows[0].id;
  const account=(await admin.query('INSERT INTO industry.accounts(email,password_hash) VALUES($1,$2) RETURNING id',
    [email,await hashPassword(pass)])).rows[0].id;
  await admin.query("INSERT INTO industry.memberships(tenant_id,account_id,role) VALUES($1,$2,'owner')",[tenant,account]);
  app=await buildApp(db);await app.listen({host:'127.0.0.1',port:0});
  base='http://127.0.0.1:'+app.server.address().port;
  owner=await login(email,pass);
});
after(async()=>{if(app)await app.close();await db.end();await admin.end();});
test('R6 real HTTP: cookies, invitation, two-person proof, archival and CSRF',async()=>{
  code(await http('GET','/health/live'),200);
  code(await http('GET','/health/ready'),200);
  code(await http('GET','/guest/pilots'),401);
  code(await http('POST','/guest/requests',owner,{title:'Bad origin',source:'field'},
    {Origin:'https://origin-test.invalid','Idempotency-Key':'r6-wrong-origin'}),403);
  const invite=code(await http('POST','/staff/invitations',owner,
    {email:reviewerEmail,role:'manager'}),201);
  assert.match(invite.token,/^[a-f0-9]{64}$/);
  code(await http('POST','/staff/invitations/accept',null,
    {token:invite.token,password:reviewPass}),200);
  code(await http('POST','/staff/invitations/accept',null,
    {token:invite.token,password:reviewPass}),404);
  reviewer=await login(reviewerEmail,reviewPass);
  const reviewerId=code(await http('GET','/auth/me',reviewer),200).account.id;
  const lead=code(await http('POST','/guest/requests',owner,{title:'Synthetic HTTP test lead',source:'field'},
    {'Idempotency-Key':'r6-lead-'+tag}),201).item;
  code(await http('PATCH','/guest/requests/'+lead.id,reviewer,{state:'qualified'}),200);
  const plan={baselinePct:20,liftPp:10,margin:300,discount:5,fixed:1000,fee:25000};
  const protocol={startDate:'2026-11-01',endDate:'2026-11-16',outcomeWindowDays:1,allocation:'random',source:'pos',primaryMetric:'repeat_visit'};
  let pilot=code(await http('POST','/guest/pilots',owner,
    {title:'Synthetic HTTP pilot',plan,requestId:lead.id,protocol}),201).item;
  const checks=Object.fromEntries(['repeatDefinition','sameWindow','independentGroups',
    'marginVerified','contactConsent','ownerAgreed'].map(k=>[k,true]));
  pilot=code(await http('PATCH','/guest/pilots/'+pilot.id+'/readiness',owner,
    {expectedVersion:pilot.version,readiness:checks}),200).item;
  pilot=code(await http('POST','/guest/pilots/'+pilot.id+'/start',owner,
    {expectedVersion:pilot.version}),200).item;
  const row=code(await http('POST','/guest/pilots/'+pilot.id+'/observations',owner,{
    expectedVersion:pilot.version,observation:{date:'2026-11-09',
      control:700,controlReturn:140,offer:700,offerReturn:210}
  },{'Idempotency-Key':'r6-period-'+tag}),201);
  const submitted=code(await http('POST','/guest/pilots/'+pilot.id+'/submit',owner,
    {expectedVersion:row.version}),200);
  code(await http('POST','/guest/pilots/'+pilot.id+'/review',owner,{
    expectedVersion:submitted.item.version,decision:'accept_for_discussion',
    evidenceDigest:submitted.evidenceDigest
  }),403);
  const review=code(await http('POST','/guest/pilots/'+pilot.id+'/review',reviewer,{
    expectedVersion:submitted.item.version,decision:'accept_for_discussion',
    evidenceDigest:submitted.evidenceDigest
  }),200);
  const evidence=code(await http('GET','/guest/pilots/'+pilot.id+'/evidence.json',reviewer),200);
  assert.equal(evidence.review.actor_id,reviewerId);
  assert.equal(evidence.sha256,createHash('sha256').update(JSON.stringify(evidence.evidence)).digest('hex'));
  const archive=code(await http('POST','/guest/pilots/'+pilot.id+'/archive',owner,{
    expectedVersion:review.item.version,reason:'Real HTTP scenario completed safely'
  }),200);
  assert.equal(archive.item.phase,'archived');
  assert.equal(archive.sha256,evidence.sha256);
  code(await http('DELETE','/staff/'+reviewerId,owner),200);
  code(await http('GET','/auth/me',reviewer),401);
  code(await http('GET','/guest/pilots/'+pilot.id+'/evidence.json',owner),200);
});
