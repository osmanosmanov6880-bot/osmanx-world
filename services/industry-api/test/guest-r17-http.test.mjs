// Real PostgreSQL 16 + Fastify production-mode R17 integration. Only synthetic
// tenant data inside industry_ci on loopback; never connects to a public server.
import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {makePool,withTenant} from '../src/database.mjs';
import {hashPassword} from '../src/password.mjs';
import {buildApp} from '../src/app.mjs';
import {syntheticR17} from './r17-synthetic-fixture.mjs';
import {loadR17Witness} from '../src/guest-r17-witness.mjs';
import {assertR17Fence} from '../src/guest-r17-fence.mjs';
import {emergencyStop} from '../src/guest-r16-registry.mjs';

const API='/api/industry/v1',ORIGIN='https://osmanx.world';
const tag=randomUUID().slice(0,8);
const password='R17-Synthetic-Owner-Strong-2026!';
const organizations=[
 {slug:'r17-first-'+tag,email:'r17-first-'+tag+'@example.test'},
 {slug:'r17-second-'+tag,email:'r17-second-'+tag+'@example.test'}
];
const ENV=['NODE_ENV','ALLOWED_ORIGIN','GUEST_WRITES_ENABLED','GUEST_RELEASE_COMMIT',
 'GUEST_R16_REGISTRY_FILE','GUEST_R16_OWNER_PUBLIC_KEY',
 'GUEST_R16_MANAGER_PUBLIC_KEY','GUEST_R16_MIN_REVISION',
 'GUEST_R17_JOURNAL_FILE','GUEST_R17_OWNER_WITNESS_FILE',
 'GUEST_R17_MANAGER_WITNESS_FILE','GUEST_R17_OWNER_PUBLIC_KEY',
 'GUEST_R17_MANAGER_PUBLIC_KEY','GUEST_R17_MIN_SEQUENCE',
 'GUEST_R17_MIN_REVISION'];
const prior=Object.fromEntries(ENV.map(k=>[k,process.env[k]]));
const admin=new pg.Pool({connectionString:process.env.MIGRATION_DB_URL});
const pool=makePool();
let fixture,app,base,firstWitness;
async function call(method,path,auth,body,extra={}){
  const r=await fetch(base+API+path,{
    method,cache:'no-store',redirect:'error',
    headers:{Accept:'application/json',
      ...(body===undefined?{}:{'Content-Type':'application/json'}),
      ...(method==='GET'?{}:{Origin:ORIGIN}),
      ...(auth?{Cookie:auth.cookie,'X-CSRF-Token':auth.csrf}:{}),...extra},
    ...(body===undefined?{}:{body:JSON.stringify(body)})
  });
  return {status:r.status,json:await r.json(),headers:r.headers};
}
function success(result,status){
  assert.equal(result.status,status,JSON.stringify(result.json));
  return result.json;
}
function cookies(resp){
  const pairs=resp.headers.getSetCookie().map(x=>x.split(';')[0]);
  assert.ok(pairs.some(x=>x.startsWith('__Host-osmanx_industry_sid=')));
  const csrf=pairs.find(x=>x.startsWith('__Host-osmanx_industry_csrf='));
  assert.ok(csrf);
  return {cookie:pairs.join('; '),csrf:csrf.slice(csrf.indexOf('=')+1)};
}
async function fence(){
  const r=await admin.query('SELECT max_revision,max_sequence,checkpoint_sha FROM industry.guest_registry_checkpoint_fence WHERE id=1');
  return {revision:Number(r.rows[0].max_revision),
    sequence:Number(r.rows[0].max_sequence),sha:r.rows[0].checkpoint_sha};
}
before(async()=>{
  const migration=new URL(process.env.MIGRATION_DB_URL||'');
  const runtime=new URL(process.env.DATABASE_URL||'');
  if(process.env.NODE_ENV!=='test'||migration.hostname!=='127.0.0.1'||
     runtime.hostname!=='127.0.0.1'||migration.pathname!=='/industry_ci'||
     runtime.pathname!=='/industry_ci')
    throw Error('R17 HTTP test is restricted to local synthetic industry_ci');
  for(const org of organizations){
    org.tenantId=(await admin.query(
      "INSERT INTO industry.tenants(slug,name,vertical) VALUES($1,$2,'cafe') RETURNING id",
      [org.slug,org.slug])).rows[0].id;
    org.accountId=(await admin.query(
      'INSERT INTO industry.accounts(email,password_hash) VALUES($1,$2) RETURNING id',
      [org.email,await hashPassword(password)])).rows[0].id;
    await admin.query(
      "INSERT INTO industry.memberships(tenant_id,account_id,role) VALUES($1,$2,'owner')",
      [org.tenantId,org.accountId]);
  }
  fixture=await syntheticR17(organizations.map(x=>x.tenantId));
  Object.assign(process.env,fixture.env,{ALLOWED_ORIGIN:ORIGIN});
  firstWitness=await loadR17Witness(fixture.env,fixture.now);
  app=await buildApp(pool);
  await app.listen({host:'127.0.0.1',port:0});
  base='http://127.0.0.1:'+app.server.address().port;
  for(const org of organizations){
    const login=await call('POST','/auth/login',null,{
      tenantSlug:org.slug,email:org.email,password
    });
    success(login,200);
    org.auth=cookies(login);
  }
});
after(async()=>{
  if(app)await app.close();
  await pool.end();await admin.end();
  if(fixture)await fixture.cleanup();
  for(const [k,v] of Object.entries(prior)){
    if(v===undefined)delete process.env[k];else process.env[k]=v;
  }
});
test('R17 PostgreSQL canary: two independent tenants, durable fence, revocation and immediate stop',async()=>{
  const baseline=await fence();
  assert.equal(baseline.sequence,0);
  const ready=success(await call('GET','/health/ready'),200);
  assert.equal(ready.forcedRls,true);
  for(const org of organizations){
    const self=success(await call('GET','/guest/admission/self',org.auth),200);
    assert.equal(self.permitValid,true,JSON.stringify(self));
    assert.equal(self.witnessVerified,true);
    assert.equal(self.witnessFenceReady,true);
    assert.equal(self.witnessSequence,3);
  }
  assert.equal((await call('GET','/guest/admission/self')).status,401);
  const invalid=await call('POST','/guest/requests',organizations[0].auth,
    {title:'x',source:'field'},{'Idempotency-Key':'r17-invalid-'+tag});
  assert.equal(invalid.status,400);
  assert.equal((await fence()).sequence,0,'Failed mutation must roll back R17 fence');
  for(const [i,org] of organizations.entries()){
    const row=success(await call('POST','/guest/requests',org.auth,{
      title:'R17 synthetic company '+(i+1),source:'field'
    },{'Idempotency-Key':'r17-good-'+tag+'-'+i}),201).item;
    org.requestId=row.id;
  }
  assert.deepEqual([Number((await fence()).revision),Number((await fence()).sequence)],[1,3]);
  const next=await fixture.revoke(organizations[0].tenantId,'security_incident');
  assert.deepEqual(next,{revision:2,sequence:5});
  const blocked=await call('POST','/guest/requests',organizations[0].auth,
    {title:'Blocked after R17 revocation',source:'field'},
    {'Idempotency-Key':'r17-revoked-'+tag});
  assert.equal(blocked.status,503);
  const allowed=await call('POST','/guest/requests',organizations[1].auth,
    {title:'Allowed second company',source:'field'},
    {'Idempotency-Key':'r17-after-'+tag});
  success(allowed,201);
  assert.deepEqual([Number((await fence()).revision),Number((await fence()).sequence)],[2,5]);
  // Fresh SQL transaction simulates new runtime accessing the same persistent DB.
  await assert.rejects(withTenant(pool,organizations[1].tenantId,
    db=>assertR17Fence(db,firstWitness)),/R17:/);
  const forbidden=await admin.query(
    'UPDATE industry.guest_registry_checkpoint_fence SET max_sequence=1 WHERE id=1'
  ).then(()=>null,error=>error);
  assert.equal(forbidden?.code,'23514');
  const grants=(await admin.query(
    "SELECT has_table_privilege('industry_app','industry.guest_registry_checkpoint_fence','DELETE') AS del,"+
    "has_table_privilege('industry_app','industry.guest_registry_checkpoint_fence','INSERT') AS ins"
  )).rows[0];
  assert.equal(grants.del,false);
  assert.equal(grants.ins,false);
  const force=(await admin.query(
    "SELECT relrowsecurity,relforcerowsecurity FROM pg_class WHERE oid='industry.guest_registry_checkpoint_fence'::regclass"
  )).rows[0];
  assert.equal(force.relrowsecurity,true);
  assert.equal(force.relforcerowsecurity,true);
  await emergencyStop(fixture.env.GUEST_R16_REGISTRY_FILE,{
    ack:'CONFIRM_R16_STOP_NO_RESUME'
  });
  assert.equal((await call('POST','/guest/requests',organizations[1].auth,
    {title:'Blocked after global STOP',source:'field'},
    {'Idempotency-Key':'r17-stop-'+tag})).status,503);
  const historical=success(await call('GET','/guest/requests',organizations[0].auth),200);
  assert.ok(historical.items.some(x=>x.id===organizations[0].requestId));
});
