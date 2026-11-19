import test from 'node:test';
import assert from 'node:assert/strict';
import {classifyPortListeners,collectHostSnapshot,
  evaluateHostPosture,HOST_SCHEMA} from '../scripts/r21-host-posture.mjs';

test('R21 local listener classifier distinguishes isolated canary and leaked PostgreSQL',()=>{
  const ok=classifyPortListeners(
    'LISTEN 0 4096 127.0.0.1:3150 0.0.0.0:*\n'+
    'LISTEN 0 200 127.0.0.1:5432 0.0.0.0:*\n');
  assert.deepEqual(ok,{canary:'loopback',postgres:'loopback'});
  assert.equal(classifyPortListeners(
    'LISTEN 0 4096 0.0.0.0:3150 0.0.0.0:*\n').canary,'public');
  assert.equal(classifyPortListeners(
    'LISTEN 0 4096 0.0.0.0:5432 0.0.0.0:*\n').postgres,'public');
  assert.equal(classifyPortListeners('unavailable').postgres,'absent');
});
test('R21 locally gathered host evidence never trusts environment booleans or unreviewed private paths',async()=>{
  const env={NODE_ENV:'production',ALLOWED_ORIGIN:'https://osmanx.world',
    GUEST_WRITES_ENABLED:'false',GUEST_R19_ROLLOUT_ENABLED:'true'};
  for(const name of ['GUEST_R16_REGISTRY_FILE','GUEST_R17_JOURNAL_FILE',
    'GUEST_R17_OWNER_WITNESS_FILE','GUEST_R17_MANAGER_WITNESS_FILE',
    'GUEST_R18_ANCHOR_FILE','GUEST_R19_SCOPE_FILE','GUEST_R19_STOP_FILE',
    'GUEST_R17_OWNER_PUBLIC_KEY','GUEST_R17_MANAGER_PUBLIC_KEY',
    'GUEST_R18_CUSTODIAN_PUBLIC_KEY','GUEST_R19_OPERATOR_PUBLIC_KEY'])
    env[name]='/private/r21/'+name+'.json';
  const calls=[];
  const snapshot=await collectHostSnapshot({
    env,ssReader:()=>
      'LISTEN 0 100 127.0.0.1:3150 0.0.0.0:*\n'+
      'LISTEN 0 100 127.0.0.1:5432 0.0.0.0:*\n',
    pathInspector:async(path,opt)=>{calls.push([path,opt]);return true;}
  });
  assert.equal(snapshot.gatheredOnHost,true);
  assert.equal(snapshot.pathsOutsideCheckout,true);
  assert.equal(snapshot.privateFilesSafe,true);
  assert.equal(snapshot.publicKeysSafe,true);
  assert.equal(snapshot.writesEnabled,false);
  assert.equal(snapshot.independentOperatorConfirmed,false);
  assert.equal(calls.length,11);
  const report=evaluateHostPosture(snapshot);
  assert.equal(report.safeIsolatedRehearsal,false);
  assert.equal(report.productionActivationPermitted,false);
  assert.equal(report.customerGo,false);
  assert.ok(report.blockers.includes('host_operatorWitnessPresent'));
});
test('R21 blocks public DB, bad mode, running write flag, unknown canary and wrong origin',()=>{
  const clean={
    os:'linux',nodeMajor:22,allowedOriginIsExact:true,
    writesEnabled:false,custodyConfigured:true,
    pathsOutsideCheckout:true,privateFilesSafe:true,
    publicKeysSafe:true,canaryListener:'loopback',postgresExposed:false,
    independentOperatorConfirmed:true,gatheredOnHost:true
  };
  const success=evaluateHostPosture(clean);
  assert.equal(success.schema,HOST_SCHEMA);
  assert.equal(success.safeIsolatedRehearsal,true);
  assert.equal(success.customerGo,false);
  for(const [key,value] of [
    ['writesEnabled',true],['postgresExposed',true],
    ['privateFilesSafe',false],['canaryListener','unknown'],
    ['allowedOriginIsExact',false]
  ]){
    const result=evaluateHostPosture({...clean,[key]:value});
    assert.equal(result.safeIsolatedRehearsal,false,key);
  }
});
