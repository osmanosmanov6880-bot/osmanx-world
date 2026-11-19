// R18 REAL PostgreSQL 16 + Fastify regression. Exclusively synthetic tenant
// records in the local industry_ci database; no network production actions.
import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile,writeFile} from 'node:fs/promises';
import pg from 'pg';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {hashPassword} from '../src/password.mjs';
import {makePool,withTenant} from '../src/database.mjs';
import {buildApp} from '../src/app.mjs';
import {syntheticR18} from './r18-synthetic-fixture.mjs';
import {loadR17Witness} from '../src/guest-r17-witness.mjs';
import {loadR18Anchor} from '../src/guest-r18-anchor.mjs';
import {assertR18Fence} from '../src/guest-r18-fence.mjs';
import {emergencyStop} from '../src/guest-r16-registry.mjs';

const API='/api/industry/v1',ORIGIN='https://osmanx.world';
const random=randomUUID().slice(0,8);
const password='R18-Synthetic-Test-Owner-2026!';
const orgs=[
 {slug:'r18-coffee-'+random,email:'r18-coffee-'+random+'@example.test'},
 {slug:'r18-dental-'+random,email:'r18-dental-'+random+'@example.test'}
];
const names=['NODE_ENV','ALLOWED_ORIGIN','GUEST_WRITES_ENABLED','GUEST_RELEASE_COMMIT',
 'GUEST_R16_REGISTRY_FILE','GUEST_R16_OWNER_PUBLIC_KEY',
 'GUEST_R16_MANAGER_PUBLIC_KEY','GUEST_R16_MIN_REVISION',
 'GUEST_R17_JOURNAL_FILE','GUEST_R17_OWNER_WITNESS_FILE',
 'GUEST_R17_MANAGER_WITNESS_FILE','GUEST_R17_OWNER_PUBLIC_KEY',
 'GUEST_R17_MANAGER_PUBLIC_KEY','GUEST_R17_MIN_SEQUENCE',
 'GUEST_R17_MIN_REVISION','GUEST_R18_ANCHOR_FILE',
 'GUEST_R18_CUSTODIAN_PUBLIC_KEY','GUEST_R18_MIN_REVISION',
 'GUEST_R18_MIN_SEQUENCE'];
const beforeEnv=Object.fromEntries(names.map(name=>[name,process.env[name]]));
const admin=new pg.Pool({connectionString:process.env.MIGRATION_DB_URL});
let isolatedAdmin,pool,isolatedName,fx,app,url,originalAnchor;
async function request(method,path,auth,data,headers={}){
  const r=await fetch(url+API+path,{
    method,redirect:'error',cache:'no-store',
    headers:{Accept:'application/json',
      ...(data===undefined?{}:{'Content-Type':'application/json'}),
      ...(method==='GET'?{}:{Origin:ORIGIN}),
      ...(auth?{Cookie:auth.cookie,'X-CSRF-Token':auth.csrf}:{}),
      ...headers},
    ...(data===undefined?{}:{body:JSON.stringify(data)})
  });
  return {status:r.status,json:await r.json(),headers:r.headers};
}
function result(r,status){
  assert.equal(r.status,status,JSON.stringify(r.json));
  return r.json;
}
function cookieJar(response){
  const items=response.headers.getSetCookie().map(s=>s.split(';')[0]);
  const csrf=items.find(s=>s.startsWith('__Host-osmanx_industry_csrf='));
  assert.ok(csrf);assert.ok(items.some(s=>s.startsWith('__Host-osmanx_industry_sid=')));
  return {cookie:items.join('; '),csrf:csrf.slice(csrf.indexOf('=')+1)};
}
async function fence(){
  const [row,items]=await Promise.all([
    isolatedAdmin.query('SELECT max_revision,max_sequence,checkpoint_sha,anchor_sha FROM industry.guest_external_anchor_fence WHERE id=1'),
    isolatedAdmin.query('SELECT count(*)::int AS n FROM industry.guest_external_anchor_receipts')
  ]);
  return {...row.rows[0],revision:Number(row.rows[0].max_revision),
    sequence:Number(row.rows[0].max_sequence),history:Number(items.rows[0].n)};
}
before(async()=>{
  const migrate=new URL(process.env.MIGRATION_DB_URL||'');
  const runtime=new URL(process.env.DATABASE_URL||'');
  if(process.env.NODE_ENV!=='test'||migrate.hostname!=='127.0.0.1'||
    runtime.hostname!=='127.0.0.1'||migrate.pathname!=='/industry_ci'||
    runtime.pathname!=='/industry_ci')
    throw Error('R18 HTTP must only use synthetic loopback industry_ci');
  // R17 tests have already advanced the durable fence. R18 must never reset
  // an existing fence; create its OWN disposable database and migrate cleanly.
  isolatedName='industry_r18_'+randomUUID().replaceAll('-','').slice(0,12);
  await admin.query('CREATE DATABASE "'+isolatedName+'"');
  migrate.pathname='/'+isolatedName;
  runtime.pathname='/'+isolatedName;
  isolatedAdmin=new pg.Pool({connectionString:migrate.toString()});
  pool=makePool(runtime.toString());
  execFileSync(process.execPath,['scripts/migrate.mjs'],{
    cwd:fileURLToPath(new URL('../',import.meta.url)),
    env:{...process.env,MIGRATION_DB_URL:migrate.toString()},
    stdio:'pipe'
  });
  for(const org of orgs){
    org.tenantId=(await isolatedAdmin.query(
      "INSERT INTO industry.tenants(slug,name,vertical) VALUES($1,$2,'cafe') RETURNING id",
      [org.slug,org.slug])).rows[0].id;
    const user=await isolatedAdmin.query(
      'INSERT INTO industry.accounts(email,password_hash) VALUES($1,$2) RETURNING id',
      [org.email,await hashPassword(password)]);
    org.accountId=user.rows[0].id;
    await isolatedAdmin.query(
      "INSERT INTO industry.memberships(tenant_id,account_id,role) VALUES($1,$2,'owner')",
      [org.tenantId,org.accountId]);
  }
  fx=await syntheticR18(orgs.map(x=>x.tenantId));
  Object.assign(process.env,fx.env,{ALLOWED_ORIGIN:ORIGIN});
  app=await buildApp(pool);
  await app.listen({host:'127.0.0.1',port:0});
  url='http://127.0.0.1:'+app.server.address().port;
  originalAnchor=await loadR18Anchor(fx.env,await loadR17Witness(fx.env,fx.now),fx.now);
  for(const org of orgs){
    const login=await request('POST','/auth/login',null,
      {tenantSlug:org.slug,email:org.email,password});
    result(login,200);org.auth=cookieJar(login);
  }
});
after(async()=>{
  if(app)await app.close();
  if(pool)await pool.end();
  if(isolatedAdmin)await isolatedAdmin.end();
  if(isolatedName)await admin.query('DROP DATABASE "'+isolatedName+'"');
  await admin.end();
  if(fx)await fx.cleanup();
  for(const [name,v] of Object.entries(beforeEnv))
    if(v===undefined)delete process.env[name];
    else process.env[name]=v;
});
test('R18 two live companies: external anchors, transactional history, fail-closed, revocation, DR floor',async()=>{
  const zero=await fence();
  assert.equal(zero.sequence,0);
  assert.equal(zero.history,0);
  for(const org of orgs){
    const status=result(await request('GET','/guest/admission/self',org.auth),200);
    assert.equal(status.externalAnchorVerified,true);
    assert.equal(status.externalAnchorFenceReady,true);
    assert.equal(status.externalAnchorSequence,3);
  }
  assert.equal((await request('GET','/guest/admission/self')).status,401);
  const bad=await request('POST','/guest/requests',orgs[0].auth,
    {title:'x',source:'field'},{'Idempotency-Key':'r18-bad-'+random});
  assert.equal(bad.status,400);
  assert.equal((await fence()).sequence,0,'Rejected mutation must roll back both checkpoint fences');
  for(const [i,org] of orgs.entries()){
    const lead=result(await request('POST','/guest/requests',org.auth,
      {title:'R18 synthetic order '+i,source:'field'},
      {'Idempotency-Key':'r18-create-'+random+'-'+i}),201).item;
    org.requestId=lead.id;
  }
  const accepted=await fence();
  assert.equal(accepted.sequence,3);
  assert.equal(accepted.revision,1);
  assert.equal(accepted.history,1);
  assert.equal(accepted.anchor_sha,originalAnchor.anchorDigest);
  const oldText=await readFile(fx.anchorFile,'utf8');
  process.env.GUEST_R18_MIN_SEQUENCE='99';
  assert.equal((await request('POST','/guest/requests',orgs[1].auth,
    {title:'Denied due to pinned sequence',source:'field'},
    {'Idempotency-Key':'r18-floor-'+random})).status,503);
  process.env.GUEST_R18_MIN_SEQUENCE='1';
  await fx.revoke(orgs[0].tenantId);
  assert.equal((await request('POST','/guest/requests',orgs[0].auth,
    {title:'Denied revoked company',source:'field'},
    {'Idempotency-Key':'r18-revoked-'+random})).status,503);
  result(await request('POST','/guest/requests',orgs[1].auth,
    {title:'Allowed under new auditor receipt',source:'field'},
    {'Idempotency-Key':'r18-next-'+random}),201);
  const current=await fence();
  assert.equal(current.sequence,5);
  assert.equal(current.revision,2);
  assert.equal(current.history,2);
  await assert.rejects(withTenant(pool,orgs[1].tenantId,
    db=>assertR18Fence(db,originalAnchor)),/R18:/);
  await writeFile(fx.anchorFile,oldText,{mode:0o600});
  assert.equal((await request('POST','/guest/requests',orgs[1].auth,
    {title:'Denied stale signed receipt',source:'field'},
    {'Idempotency-Key':'r18-old-'+random})).status,503);
  await fx.publishAnchor(fx.now);
  const refused=await isolatedAdmin.query(
    'UPDATE industry.guest_external_anchor_fence SET max_sequence=1 WHERE id=1'
  ).then(()=>null,error=>error);
  assert.equal(refused?.code,'23514');
  const role=(await isolatedAdmin.query(
    "SELECT has_table_privilege('industry_app','industry.guest_external_anchor_receipts','UPDATE') AS upd,"+
    "has_table_privilege('industry_app','industry.guest_external_anchor_receipts','DELETE') AS del"
  )).rows[0];
  assert.equal(role.upd,false);assert.equal(role.del,false);
  const metadata=(await isolatedAdmin.query(
    "SELECT relrowsecurity,relforcerowsecurity FROM pg_class WHERE oid='industry.guest_external_anchor_receipts'::regclass"
  )).rows[0];
  assert.equal(metadata.relrowsecurity,true);
  assert.equal(metadata.relforcerowsecurity,true);
  await emergencyStop(fx.env.GUEST_R16_REGISTRY_FILE,{
    ack:'CONFIRM_R16_STOP_NO_RESUME'
  });
  assert.equal((await request('POST','/guest/requests',orgs[1].auth,
    {title:'Denied after global STOP',source:'field'},
    {'Idempotency-Key':'r18-stop-'+random})).status,503);
  const history=result(await request('GET','/guest/requests',orgs[0].auth),200);
  assert.ok(history.items.some(x=>x.id===orgs[0].requestId));
});
