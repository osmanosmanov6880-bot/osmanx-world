// R16 actual Fastify + PostgreSQL acceptance: two companies, independent permits,
// hot revocation, STOP markers, existing tenant RLS and authenticated status.
import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {hashPassword} from '../src/password.mjs';
import {makePool} from '../src/database.mjs';
import {buildApp} from '../src/app.mjs';
import {syntheticR16Registry} from './r16-synthetic-fixture.mjs';
import {emergencyStop} from '../src/guest-r16-registry.mjs';

const P='/api/industry/v1',ORIGIN='https://osmanx.world';
const id=randomUUID().slice(0,8);
const password='R16-Synthetic-Strong-Pass-2026!';
const orgs=[
  {slug:'r16-cafe-'+id,email:'r16-cafe-'+id+'@example.test'},
  {slug:'r16-clinic-'+id,email:'r16-clinic-'+id+'@example.test'}
];
const preserve=Object.fromEntries([
 'NODE_ENV','ALLOWED_ORIGIN','GUEST_WRITES_ENABLED','GUEST_RELEASE_COMMIT',
 'GUEST_R16_REGISTRY_FILE','GUEST_R16_OWNER_PUBLIC_KEY',
 'GUEST_R16_MANAGER_PUBLIC_KEY','GUEST_R16_MIN_REVISION'
].map(key=>[key,process.env[key]]));
const admin=new pg.Pool({connectionString:process.env.MIGRATION_DB_URL});
const db=makePool();
let app,base,fixture,accounts=[];
function expect(r,status){assert.equal(r.status,status,JSON.stringify(r.json));return r.json;}
function tokens(result){
  const parts=result.headers.getSetCookie().map(x=>x.split(';')[0]);
  assert.ok(parts.some(x=>x.startsWith('__Host-osmanx_industry_sid=')));
  const csrf=parts.find(x=>x.startsWith('__Host-osmanx_industry_csrf='));
  assert.ok(csrf);
  return {cookie:parts.join('; '),csrf:csrf.split('=')[1]};
}
async function call(method,path,account,payload,extra={}){
  const r=await fetch(base+P+path,{
    method,cache:'no-store',redirect:'error',
    headers:{Accept:'application/json',
      ...(payload===undefined?{}:{'Content-Type':'application/json'}),
      ...(method==='GET'?{}:{Origin:ORIGIN}),
      ...(account?{Cookie:account.cookie,'X-CSRF-Token':account.csrf}:{}),...extra},
    ...(payload===undefined?{}:{body:JSON.stringify(payload)})
  });
  return {status:r.status,json:await r.json(),headers:r.headers};
}
before(async()=>{
  const migration=new URL(process.env.MIGRATION_DB_URL||'');
  const runtime=new URL(process.env.DATABASE_URL||'');
  if(process.env.NODE_ENV!=='test'||migration.hostname!=='127.0.0.1'||
    runtime.hostname!=='127.0.0.1'||migration.pathname!=='/industry_ci'||
    runtime.pathname!=='/industry_ci')
    throw Error('R16 HTTP tests require isolated loopback PostgreSQL industry_ci');
  for(const org of orgs){
    org.tenantId=(await admin.query(
      "INSERT INTO industry.tenants(slug,name,vertical) VALUES($1,$2,'cafe') RETURNING id",
      [org.slug,org.slug])).rows[0].id;
    const user=await admin.query(
      'INSERT INTO industry.accounts(email,password_hash) VALUES($1,$2) RETURNING id',
      [org.email,await hashPassword(password)]);
    org.accountId=user.rows[0].id;
    await admin.query("INSERT INTO industry.memberships(tenant_id,account_id,role) VALUES($1,$2,'owner')",
      [org.tenantId,org.accountId]);
  }
  fixture=await syntheticR16Registry(orgs.map(x=>x.tenantId));
  Object.assign(process.env,fixture.env,{ALLOWED_ORIGIN:ORIGIN});
  app=await buildApp(db);
  await app.listen({host:'127.0.0.1',port:0});
  base='http://127.0.0.1:'+app.server.address().port;
  for(const org of orgs){
    org.auth=tokens(expect(await call('POST','/auth/login',null,{
      tenantSlug:org.slug,email:org.email,password
    }),200));
  }
});
after(async()=>{
  if(app)await app.close();
  await db.end();await admin.end();
  if(fixture)await fixture.cleanup();
  for(const [key,value] of Object.entries(preserve)){
    if(value===undefined)delete process.env[key];
    else process.env[key]=value;
  }
});
test('R16 2-tenant live HTTP: independent access, signed revoke and immediate STOP',async()=>{
  const ready=expect(await call('GET','/health/ready'),200);
  assert.equal(ready.forcedRls,true);
  for(const org of orgs){
    const status=expect(await call('GET','/guest/admission/self',org.auth),200);
    assert.equal(status.permitValid,true);
    assert.equal(status.mode,'multi');
    assert.equal(status.registryRevision,1);
  }
  assert.equal((await call('GET','/guest/admission/self')).status,401);
  const leadA=expect(await call('POST','/guest/requests',orgs[0].auth,{
    title:'R16 isolated cafe request',source:'field'
  },{'Idempotency-Key':'r16-cafe-'+id}),201).item;
  const leadB=expect(await call('POST','/guest/requests',orgs[1].auth,{
    title:'R16 isolated clinic request',source:'field'
  },{'Idempotency-Key':'r16-clinic-'+id}),201).item;
  assert.ok(leadA.id&&leadB.id);
  assert.equal((await call('PATCH','/guest/requests/'+leadA.id,orgs[1].auth,
    {state:'qualified'})).status,404);
  const ownB=expect(await call('GET','/guest/requests',orgs[1].auth),200);
  assert.equal(ownB.items.length,1);
  assert.equal(ownB.items[0].id,leadB.id);
  const idA=orgs[0].tenantId;
  await fixture.update({revoked:[{
    tenantId:idA,reasonCode:'security_incident',
    revokedAt:new Date(Date.now()-1000).toISOString()
  }]});
  const revoked=expect(await call('GET','/guest/admission/self',orgs[0].auth),200);
  assert.equal(revoked.permitValid,false);
  assert.equal(revoked.reason,'revoked');
  assert.equal((await call('POST','/guest/requests',orgs[0].auth,
    {title:'Denied after revocation',source:'field'},
    {'Idempotency-Key':'r16-denied-'+id})).status,503);
  assert.equal((await call('POST','/guest/requests',orgs[1].auth,
    {title:'Still allowed clinic',source:'field'},
    {'Idempotency-Key':'r16-allowed-'+id})).status,201);
  await emergencyStop(fixture.env.GUEST_R16_REGISTRY_FILE,{
    tenantId:orgs[1].tenantId,ack:'CONFIRM_R16_STOP_NO_RESUME'
  });
  const stopped=expect(await call('GET','/guest/admission/self',orgs[1].auth),200);
  assert.equal(stopped.permitValid,false);
  assert.equal(stopped.reason,'tenant_emergency_stop');
  assert.equal((await call('POST','/guest/requests',orgs[1].auth,
    {title:'Denied after instant stop',source:'field'},
    {'Idempotency-Key':'r16-stop-'+id})).status,503);
  // Read access to own historic records remains available for investigation.
  const historical=expect(await call('GET','/guest/requests',orgs[0].auth),200);
  assert.ok(historical.items.some(x=>x.id===leadA.id));
});
