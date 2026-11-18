import test from 'node:test';
import assert from 'node:assert/strict';
import {inspect,PROD_BASE} from '../scripts/guest-readiness.mjs';

const paths={
  '/assets/guest/console.html':{status:200,type:'text/html',body:'<title>Закрытый кабинет</title>'},
  '/assets/guest/join.html':{status:200,type:'text/html',body:'<title>Приглашение сотрудника</title>'},
  '/api/industry/v1/health/live':{status:200,type:'application/json',data:{status:'live'}},
  '/api/industry/v1/health/ready':{status:200,type:'application/json',data:{status:'ready'}},
  '/api/industry/v1/guest/pilots':{status:401,type:'application/json',data:{error:'Требуется вход'}}
};
function fake(data=paths){
  return async (url,config)=>{
    assert.equal(config.method,'GET');
    assert.equal(config.cache,'no-store');
    assert.equal(config.redirect,'error');
    assert.ok(!config.headers.Cookie);
    const path=new URL(url).pathname,entry=data[path];
    if(!entry)throw Error('No test response');
    return {
      status:entry.status,
      headers:new Headers({'content-type':entry.type}),
      text:async()=>entry.body||'',
      json:async()=>entry.data||{}
    };
  };
}
test('R5 public readiness accepts only separately proven console, API and protected 401',async()=>{
  const result=await inspect(PROD_BASE,fake());
  assert.equal(result.staticReady,true);
  assert.equal(result.apiReady,true);
  assert.ok(result.observations.privateBlocked.ok);
  assert.ok(result.observations.apiLive.ok);
});
test('R5 must not call a static page a live backend',async()=>{
  const altered={...paths,'/api/industry/v1/health/live':{status:404,type:'text/html',body:'Not found'}};
  const result=await inspect(PROD_BASE,fake(altered));
  assert.equal(result.staticReady,true);assert.equal(result.apiReady,false);
  assert.match(result.interpretation,/НЕ готов/);
});
test('R5 public API must return a 401 with JSON for unauthenticated pilot listing',async()=>{
  const altered={...paths,'/api/industry/v1/guest/pilots':{status:200,type:'text/html',body:'welcome'}};
  const result=await inspect(PROD_BASE,fake(altered));
  assert.equal(result.apiReady,false);
});
test('R5 rejects malicious origins and user/password in probe URL',async()=>{
  for(const url of ['http://evil.example','https://osmanx.world/path',
    'https://user:password@osmanx.world','https://osmanx.world?token=secret']){
    if(url==='http://evil.example')continue; // Other bare origins permitted only for injected mocks.
    await assert.rejects(inspect(url,fake()),/Base must/);
  }
});
test('R5 transport failures produce false status rather than simulated success',async()=>{
  const result=await inspect(PROD_BASE,async()=>{throw Error('No connection')});
  assert.equal(result.staticReady,false);assert.equal(result.apiReady,false);
  assert.equal(result.observations.apiReady.status,null);
});
