import test from 'node:test';
import assert from 'node:assert/strict';
import {LOCAL,PUBLIC,PROBES} from '../scripts/r14-monitor.mjs';
import {CANARY_SCHEMA,assessR23Canary,inspectR23Canary}
  from '../scripts/r23-http-canary.mjs';
function report(origin,broken=null){
  const observations=Object.fromEntries(PROBES.map(p=>[
    p.id,{ok:p.id!==broken,status:p.status}
  ]));
  return {schema:'osmanx.guest.r14.monitor.v1',target:origin,
    status:broken?'degraded':'healthy',ready:true,
    guestWritesExpected:false,observations};
}
test('R23 requires loopback/public HTTPS privacy, ready checks, status parity, disabled writes',()=>{
  const result=assessR23Canary(report(LOCAL),report(PUBLIC));
  assert.equal(result.schema,CANARY_SCHEMA);
  assert.equal(result.probeCount,10);
  assert.equal(result.technicalCanaryReady,true);
  assert.equal(result.customerGo,false);
  assert.equal(result.productionAuthorized,false);
  assert.equal(result.changedProduction,false);
});
test('R23 rejects wrong public host, one unauthorized data leak, active writes and failed ready check',()=>{
  const x=report(LOCAL),y=report(PUBLIC);
  y.target='https://evil.example';
  assert.equal(assessR23Canary(x,y).technicalCanaryReady,false);
  y.target=PUBLIC;y.observations.pilotsPrivate.status=200;
  assert.ok(assessR23Canary(x,y).blockers.includes(
    'r23_canary_allUnauthorizedRoutesPrivate'));
  y.observations.pilotsPrivate.status=401;
  y.guestWritesExpected=true;
  assert.equal(assessR23Canary(x,y).technicalCanaryReady,false);
  y.guestWritesExpected=false;y.ready=false;
  assert.equal(assessR23Canary(x,y).technicalCanaryReady,false);
});
test('R23 executes exactly ten anonymous fixed GET requests with no redirects or auth',async()=>{
  const visited=[];
  const fetcher=async(url,opts)=>{
    visited.push({url,opts});
    const p=PROBES.find(x=>url.endsWith(x.path));
    assert.ok(p, 'Unexpected endpoint');
    const isLocal=url.startsWith(LOCAL),isPublic=url.startsWith(PUBLIC);
    assert.ok(isLocal||isPublic);
    return {status:p.status,
      headers:{get:k=>k==='content-type'?'application/json':null},
      json:async()=>p.id==='live'?{status:'live'}:
        p.id==='ready'?{status:'ready',database:'ok',
          schemaVersion:'011_guest_pilot_safety.sql',
          leastPrivilege:true,forcedRls:true,guestWritesEnabled:false}:
          {error:'authentication required'}
    };
  };
  const result=await inspectR23Canary({fetcher});
  assert.equal(result.technicalCanaryReady,true,JSON.stringify(result.blockers));
  assert.equal(visited.length,10);
  assert.ok(visited.every(x=>x.opts.method==='GET'&&
    x.opts.redirect==='error'&&x.opts.cache==='no-store'&&
    !Object.keys(x.opts.headers).some(k=>/cookie|authorization/i.test(k))));
  assert.equal(visited.filter(x=>x.url.startsWith(LOCAL)).length,5);
  assert.equal(visited.filter(x=>x.url.startsWith(PUBLIC)).length,5);
});
test('R23 fails closed on redirects or HTTP failures without exporting response content',async()=>{
  const fetcher=async()=>({status:302,headers:{get:()=>null},
    json:async()=>({error:'Bearer PRIVATE_KEY'})});
  const out=await inspectR23Canary({fetcher});
  assert.equal(out.technicalCanaryReady,false);
  assert.equal(JSON.stringify(out).includes('PRIVATE_KEY'),false);
  assert.equal(out.customerGo,false);
});
