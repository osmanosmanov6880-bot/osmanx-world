import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {mkdtemp,writeFile,chmod,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {parseEnv,validateEnvironment,inspectFile} from '../scripts/preflight.mjs';
import {buildApp} from '../src/app.mjs';

function valid(){
  return {
    POSTGRES_ADMIN_PASSWORD:randomBytes(32).toString('hex'),
    INDUSTRY_APP_PASSWORD:randomBytes(32).toString('hex'),
    INDUSTRY_WORKER_PASSWORD:randomBytes(32).toString('hex'),
    WEBHOOK_HMAC_KEY:randomBytes(32).toString('hex'),
    AGE_RECIPIENT_1:'age1'+'a'.repeat(58),
    AGE_RECIPIENT_2:'age1'+'b'.repeat(58),
    BOOTSTRAP_PASSWORD:'8&Ch6!nY1?Lp2#Rz5*',
    BOOTSTRAP_EMAIL:'pilot-owner@osmanx.world',
    BOOTSTRAP_TENANT_SLUG:'sample-cafe-01',
    BOOTSTRAP_TENANT_NAME:'Sample Cafe',
    BOOTSTRAP_VERTICAL:'cafe',
    GUEST_WRITES_ENABLED:'false'
  };
}
test('R6 preflight accepts independent secrets and stays fail closed',()=>{
  const result=validateEnvironment(valid());
  assert.equal(result.ok,true,result.errors.join('\n'));
  assert.equal(result.checks.operatorExplicitlyEnabled,false);
});
test('R6 preflight refuses reused credentials, placeholders, unsafe backup keys and default write-on',()=>{
  const v=valid();
  v.INDUSTRY_APP_PASSWORD=v.POSTGRES_ADMIN_PASSWORD;
  v.AGE_RECIPIENT_2=v.AGE_RECIPIENT_1;
  v.GUEST_WRITES_ENABLED='true';
  v.BOOTSTRAP_EMAIL='owner@example.com';
  const report=validateEnvironment(v);
  assert.equal(report.ok,false);
  assert.ok(report.errors.some(e=>e.includes('independent')));
  assert.ok(report.errors.some(e=>e.includes('write')||e.includes('Guest')));
  assert.ok(report.errors.some(e=>e.includes('BOOTSTRAP_EMAIL')));
  assert.equal(validateEnvironment({...valid(),GUEST_WRITES_ENABLED:'true'},{allowWrites:true}).ok,true);
});
test('R6 parser rejects duplicate fields, interpolation and malformed syntax',()=>{
  assert.throws(()=>parseEnv('POSTGRES_ADMIN_PASSWORD=a\nPOSTGRES_ADMIN_PASSWORD=b'),/Duplicate/);
  assert.throws(()=>parseEnv('POSTGRES_ADMIN_PASSWORD=$'+'{SOME_VAR}'),/Unsafe/);
  assert.throws(()=>parseEnv('export STRIPE_SECRET_KEY=foo'),/Malformed/);
  const parsed=parseEnv('GUEST_WRITES_ENABLED=false\n# ignored\nBOOTSTRAP_TENANT_NAME=My Shop\n');
  assert.equal(parsed.BOOTSTRAP_TENANT_NAME,'My Shop');
});
test('R6 file preflight rejects world-readable operator secrets without showing values',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'r6-preflight-'));
  const path=join(dir,'.env');
  const env=valid();
  try{
    await writeFile(path,Object.entries(env).map(([k,v])=>k+'='+v).join('\n')+'\n',{mode:0o600});
    assert.equal((await inspectFile(path)).ok,true);
    await chmod(path,0o644);
    await assert.rejects(inspectFile(path),/chmod 600/);
  }finally{await rm(dir,{recursive:true,force:true})}
});
test('R6 production mutation gate: live/GET allowed, POST disabled until explicit switch',async()=>{
  const prior={node:process.env.NODE_ENV,origin:process.env.ALLOWED_ORIGIN,
    flag:process.env.GUEST_WRITES_ENABLED};
  process.env.NODE_ENV='production';
  process.env.ALLOWED_ORIGIN='https://osmanx.world';
  delete process.env.GUEST_WRITES_ENABLED;
  const fakePool={query:async()=>({rowCount:0,rows:[]})};
  let app;
  try{
    app=await buildApp(fakePool);
    const alive=await app.inject({method:'GET',url:'/api/industry/v1/health/live'});
    assert.equal(alive.statusCode,200);
    const ready=await app.inject({method:'GET',url:'/api/industry/v1/health/ready'});
    assert.equal(ready.statusCode,200);
    assert.equal(ready.json().guestWritesEnabled,false);
    const denied=await app.inject({method:'POST',url:'/api/industry/v1/guest/requests',
      payload:{title:'Blocked preproduction lead',source:'field'}});
    assert.equal(denied.statusCode,503,denied.body);
    const protectedGet=await app.inject({method:'GET',url:'/api/industry/v1/guest/pilots'});
    assert.equal(protectedGet.statusCode,401);
    process.env.GUEST_WRITES_ENABLED='true';
    const gated=await app.inject({method:'POST',url:'/api/industry/v1/guest/requests',
      payload:{title:'No auth lead',source:'field'}});
    assert.equal(gated.statusCode,401,'Writes enabled never bypass login');
    const enabled=await app.inject({method:'GET',url:'/api/industry/v1/health/ready'});
    assert.equal(enabled.json().guestWritesEnabled,true);
  }finally{
    if(app)await app.close();
    for(const [key,value] of [['NODE_ENV',prior.node],['ALLOWED_ORIGIN',prior.origin],
      ['GUEST_WRITES_ENABLED',prior.flag]]){
      if(value===undefined)delete process.env[key];else process.env[key]=value;
    }
  }
});
