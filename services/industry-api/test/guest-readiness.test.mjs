import test from 'node:test';
import assert from 'node:assert/strict';
import {inspect,PROD_BASE,CHECKS,EXPECTED_SCHEMA,assertProbeOrigin} from '../scripts/guest-readiness.mjs';

const pilot='00000000-0000-4000-8000-000000000000';
const paths={
  '/assets/guest/console.html':{status:200,type:'text/html',body:'<title>Guest Intelligence / R13 / Защищённый кабинет</title>'},
  '/assets/guest/join.html':{status:200,type:'text/html',body:'<title>Приглашение сотрудника</title>'},
  '/api/industry/v1/health/live':{status:200,type:'application/json',data:{status:'live'}},
  '/api/industry/v1/health/ready':{status:200,type:'application/json',data:{
    status:'ready',schemaVersion:EXPECTED_SCHEMA,database:'ok',forcedRls:true,
    leastPrivilege:true,guestWritesEnabled:false
  }},
  '/api/industry/v1/guest/pilots':{status:401,type:'application/json',data:{error:'Требуется вход'}},
  ...Object.fromEntries(['evidence.json','diagnostics','actions','observations/imports'].map(path=>
    ['/api/industry/v1/guest/pilots/'+pilot+'/'+path,
      {status:401,type:'application/json',data:{error:'Требуется вход'}}]))
};
function fake(data=paths){
  return async (url,config)=>{
    assert.equal(config.method,'GET');
    assert.equal(config.cache,'no-store');
    assert.equal(config.redirect,'error');
    assert.equal(config.headers.Cookie,undefined);
    assert.equal(config.headers.Authorization,undefined);
    const path=new URL(url).pathname,entry=data[path];
    if(!entry)throw Error('No test response');
    return {status:entry.status,headers:new Headers({'content-type':entry.type}),
      text:async()=>entry.body||'',json:async()=>entry.data||{}};
  };
}
test('R10 require all anonymous read-only checks and R9 schema',async()=>{
  const r=await inspect(PROD_BASE,fake());
  assert.equal(r.schema,'osmanx.guest.r10.readiness.v1');
  assert.equal(r.staticReady,true);
  assert.equal(r.apiReady,true);
  assert.equal(Object.keys(r.observations).length,CHECKS.length);
  assert.ok(r.observations.diagnosticsProtected.ok);
  assert.ok(r.observations.importsProtected.ok);
});
test('R10 R9 static marker is required (R8 page is stale)',async()=>{
  const altered={...paths,'/assets/guest/console.html':{status:200,type:'text/html',body:'Закрытый кабинет R8'}};
  const r=await inspect(PROD_BASE,fake(altered));
  assert.equal(r.staticReady,false);
  assert.equal(r.apiReady,true);
});
test('R10 old R8 API or missing forced RLS must NEVER be reported ready',async()=>{
  const endpoint='/api/industry/v1/health/ready',origin=paths[endpoint];
  for(const change of [
    {schemaVersion:'007_guest_protocol_governance.sql'},
    {forcedRls:false},{leastPrivilege:false},{guestWritesEnabled:null},
    {database:'unavailable'}
  ]){
    const altered={...paths,[endpoint]:{...origin,data:{...origin.data,...change}}};
    const r=await inspect(PROD_BASE,fake(altered));
    assert.equal(r.staticReady,true);
    assert.equal(r.apiReady,false,JSON.stringify(change));
  }
});
test('R10 missing protected API route or accidentally publicly readable data fails closed',async()=>{
  for(const key of ['pilotsProtected','evidenceProtected','diagnosticsProtected','actionsProtected','importsProtected']){
    const path=CHECKS.find(x=>x.key===key).path;
    const modified={...paths,[path]:{status:200,type:'application/json',data:{items:[]}}};
    assert.equal((await inspect(PROD_BASE,fake(modified))).apiReady,false,key);
  }
});
test('R10 no API means static-only (no false customer readiness)',async()=>{
  const altered={...paths,'/api/industry/v1/health/live':{status:404,type:'text/html',body:'Not Found'}};
  const r=await inspect(PROD_BASE,fake(altered));
  assert.equal(r.staticReady,true);assert.equal(r.apiReady,false);
  assert.match(r.interpretation,/НЕ подтверждён/);
});
test('R10 exact origin allowlist blocks redirects/credentials/SSRF-hosts',async()=>{
  assert.equal(assertProbeOrigin(PROD_BASE),PROD_BASE);
  assert.equal(assertProbeOrigin('http://127.0.0.1:3150'),'http://127.0.0.1:3150');
  for(const origin of [
    'http://evil.example','https://www.osmanx.world','https://osmanx.world:443',
    'https://user:password@osmanx.world','https://osmanx.world/path',
    'https://osmanx.world?token=secret','http://localhost:3150',
    'http://127.0.0.2:3150','http://169.254.169.254','file:///etc/passwd'
  ])await assert.rejects(inspect(origin,fake()),/Base must/);
});
test('R10 transport errors never pretend success',async()=>{
  const r=await inspect(PROD_BASE,async()=>{throw Error('No connection')});
  assert.equal(r.staticReady,false);assert.equal(r.apiReady,false);
  assert.equal(r.observations.apiReady.status,null);
});
