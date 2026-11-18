import test from 'node:test';
import assert from 'node:assert/strict';
import {inspectStage,STAGE_ORIGIN,R10_SCHEMA,CHECKS} from '../scripts/r10-stage-gate.mjs';

const data={
  live:{status:'live'},
  ready:{status:'ready',schemaVersion:R10_SCHEMA,database:'ok',
    forcedRls:true,leastPrivilege:true,guestWritesEnabled:false}
};
function fake(alter={}){
  const calls=[];
  const fetcher=async(url,options)=>{
    assert.equal(new URL(url).origin,STAGE_ORIGIN);
    assert.equal(options.method,'GET');
    assert.equal(options.redirect,'error');
    assert.equal(options.cache,'no-store');
    assert.equal(options.headers.Authorization,undefined);
    assert.equal(options.headers.Cookie,undefined);
    calls.push(url);
    const item=CHECKS.find(c=>url.endsWith(c.url));
    assert.ok(item,'Unapproved endpoint '+url);
    const status=alter[item.key]?.status??item.status;
    const json=alter[item.key]?.json??data[item.key]??{error:'Требуется вход'};
    return {status,headers:new Headers({'content-type':alter[item.key]?.type??'application/json'}),
      json:async()=>json};
  };
  return {fetcher,calls};
}
test('R10 stage gate independently probes every route with bounded GET only',async()=>{
  const mock=fake();
  const result=await inspectStage(STAGE_ORIGIN,mock.fetcher);
  assert.equal(result.schema,'osmanx.guest.r10.staging.gate.v1');
  assert.equal(result.technicalStageReady,true);
  assert.equal(result.readyForCustomerData,false);
  assert.equal(mock.calls.length,CHECKS.length);
  assert.ok(result.observations.privateDiagnostics.ok);
  assert.ok(result.observations.privateImports.ok);
});
test('R10 refuses stale migration, writes enabled, missing least privilege and RLS',async()=>{
  for(const issue of [
    {schemaVersion:'007_guest_protocol_governance.sql'},
    {guestWritesEnabled:true},{guestWritesEnabled:null},
    {forcedRls:false},{leastPrivilege:false},{database:'down'}
  ]){
    const r=await inspectStage(STAGE_ORIGIN,fake({ready:{json:{...data.ready,...issue}}}).fetcher);
    assert.equal(r.technicalStageReady,false,JSON.stringify(issue));
    assert.equal(r.readyForCustomerData,false);
  }
});
test('R10 refuses a protected route that is missing, redirects or publicly readable',async()=>{
  for(const key of ['privatePilots','privateEvidence','privateDiagnostics','privateActions','privateImports']){
    const r=await inspectStage(STAGE_ORIGIN,
      fake({[key]:{status:200,json:{item:{public:true}}}}).fetcher);
    assert.equal(r.technicalStageReady,false,key);
  }
});
test('R10 stage gate rejects remote targets and unexpected transport failure',async()=>{
  for(const bad of ['http://localhost:3149','http://127.0.0.1:3047',
    'https://osmanx.world','http://169.254.169.254:3149','file:///etc/passwd'])
    await assert.rejects(inspectStage(bad,fake().fetcher),/restricted/);
  const report=await inspectStage(STAGE_ORIGIN,async()=>{throw Error('connection refused')});
  assert.equal(report.technicalStageReady,false);
  assert.equal(report.readyForCustomerData,false);
  assert.equal(report.observations.ready.status,null);
});
