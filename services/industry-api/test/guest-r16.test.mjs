import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile,writeFile,chmod} from 'node:fs/promises';
import {join} from 'node:path';
import {syntheticR16Registry} from './r16-synthetic-fixture.mjs';
import {
  evaluateRegistry,loadR16Registry,inspectR16Tenant,assertR16Tenant,
  emergencyStop,r16Configured
} from '../src/guest-r16-registry.mjs';
import {reviewRegistry,reviewWithCanary} from '../scripts/r16-operator.mjs';
import {PROBES,LOCAL} from '../scripts/r14-monitor.mjs';

async function setup(t,count=2){
  const ids=Array.from({length:count},()=>randomUUID());
  const fixture=await syntheticR16Registry(ids);
  t.after(async()=>fixture.cleanup());
  return {ids,fixture};
}
const platformKeys=fx=>({
  owner:fx.operators.owner.publicKey.export({type:'spki',format:'pem'}),
  manager:fx.operators.manager.publicKey.export({type:'spki',format:'pem'})
});
test('R16 signed index validates exact release, two human keys, canonical order, expiry, revision floor',async t=>{
  const {fixture:fx}=await setup(t);
  const good=evaluateRegistry(fx.registry,platformKeys(fx),fx.env.GUEST_RELEASE_COMMIT,1,fx.now);
  assert.equal(good.valid,true,good.blockers.join(','));
  assert.equal(good.tenantCount,2);
  assert.equal((await loadR16Registry(fx.env,fx.now)).revision,1);
  assert.equal(evaluateRegistry({...fx.registry,revision:2},
    platformKeys(fx),fx.env.GUEST_RELEASE_COMMIT,1,fx.now).valid,false);
  assert.equal(evaluateRegistry(fx.registry,platformKeys(fx),
    'b'.repeat(40),1,fx.now).valid,false);
  assert.equal(evaluateRegistry(fx.registry,platformKeys(fx),
    fx.env.GUEST_RELEASE_COMMIT,2,fx.now).valid,false);
  assert.equal(evaluateRegistry(fx.registry,{
    owner:platformKeys(fx).owner,manager:platformKeys(fx).owner
  },fx.env.GUEST_RELEASE_COMMIT,1,fx.now).valid,false);
  assert.equal(evaluateRegistry({...fx.registry,tenants:[...fx.registry.tenants].reverse()},
    platformKeys(fx),fx.env.GUEST_RELEASE_COMMIT,1,fx.now).valid,false);
  assert.equal(evaluateRegistry(fx.registry,platformKeys(fx),
    fx.env.GUEST_RELEASE_COMMIT,1,new Date(fx.now.getTime()+3*3600000)).valid,false);
  assert.equal(r16Configured(fx.env),true);
  assert.equal(r16Configured({GUEST_RELEASE_COMMIT:'a'.repeat(40)}),false);
});
test('R16 isolates signed admission for two tenants; no unknown tenant can inherit either permit',async t=>{
  const {ids,fixture:fx}=await setup(t);
  for(const id of ids){
    const status=await inspectR16Tenant(id,fx.env,fx.now);
    assert.equal(status.permitValid,true,JSON.stringify(status));
    assert.equal(status.registryRevision,1);
    assert.equal((await assertR16Tenant(id,fx.env,fx.now)).permitValid,true);
  }
  const unknown=await inspectR16Tenant(randomUUID(),fx.env,fx.now);
  assert.equal(unknown.permitValid,false);
  assert.equal(unknown.reason,'not_enrolled');
  await assert.rejects(assertR16Tenant(randomUUID(),fx.env,fx.now),/R16:/);
  const broken={...fx.env,GUEST_R16_MIN_REVISION:'2'};
  assert.equal((await inspectR16Tenant(ids[0],broken,fx.now)).permitValid,false);
  const partial={...fx.env};
  delete partial.GUEST_R16_MANAGER_PUBLIC_KEY;
  assert.equal((await inspectR16Tenant(ids[0],partial,fx.now)).permitValid,false);
  // A valid permit for B cannot replace the permit for A.
  const pathA=join(fx.root,'tenants',ids[0],'permit.json');
  const pathB=join(fx.root,'tenants',ids[1],'permit.json');
  const original=await readFile(pathA,'utf8');
  await writeFile(pathA,await readFile(pathB,'utf8'),{mode:0o600});
  assert.equal((await inspectR16Tenant(ids[0],fx.env,fx.now)).permitValid,false);
  assert.equal((await inspectR16Tenant(ids[1],fx.env,fx.now)).permitValid,true);
  await writeFile(pathA,original,{mode:0o600});
  await chmod(pathA,0o644);
  assert.equal((await inspectR16Tenant(ids[0],fx.env,fx.now)).permitValid,false);
});
test('R16 signed revocation takes effect while process lives; older signed revisions cannot roll back',async t=>{
  const {ids,fixture:fx}=await setup(t);
  const before=fx.registry;
  await loadR16Registry(fx.env,fx.now); // establish signed revision floor in-process
  await fx.update({revoked:[{
    tenantId:ids[0],reasonCode:'security_incident',
    revokedAt:new Date(fx.now.getTime()-1000).toISOString()
  }]});
  assert.equal((await inspectR16Tenant(ids[0],fx.env,fx.now)).reason,'revoked');
  assert.equal((await inspectR16Tenant(ids[1],fx.env,fx.now)).permitValid,true);
  await fx.publish(before); // signed replay: valid old signatures, invalid revision
  assert.equal((await inspectR16Tenant(ids[0],fx.env,fx.now)).reason,'registry_unavailable');
  assert.equal((await inspectR16Tenant(ids[1],fx.env,fx.now)).permitValid,false);
});
test('R16 emergency single-tenant and global STOP is atomic, acknowledged and never auto-cleared',async t=>{
  const {ids,fixture:fx}=await setup(t);
  await assert.rejects(emergencyStop(fx.env.GUEST_R16_REGISTRY_FILE,{tenantId:ids[0]}));
  const single=await emergencyStop(fx.env.GUEST_R16_REGISTRY_FILE,{
    tenantId:ids[0],ack:'CONFIRM_R16_STOP_NO_RESUME'
  });
  assert.equal(single.stopped,true);
  assert.equal(single.alreadyStopped,false);
  assert.equal((await emergencyStop(fx.env.GUEST_R16_REGISTRY_FILE,{
    tenantId:ids[0],ack:'CONFIRM_R16_STOP_NO_RESUME'
  })).alreadyStopped,true);
  assert.equal((await inspectR16Tenant(ids[0],fx.env,fx.now)).reason,'tenant_emergency_stop');
  assert.equal((await inspectR16Tenant(ids[1],fx.env,fx.now)).permitValid,true);
  await emergencyStop(fx.env.GUEST_R16_REGISTRY_FILE,{
    ack:'CONFIRM_R16_STOP_NO_RESUME'
  });
  assert.equal((await inspectR16Tenant(ids[1],fx.env,fx.now)).reason,'global_emergency_stop');
  await assert.rejects(assertR16Tenant(ids[1],fx.env,fx.now),/остановлена/);
});
test('R16 operator review is scoped, synthetic and exposes no credentials or guest data',async t=>{
  const {ids,fixture:fx}=await setup(t);
  const readOnly=await reviewRegistry(fx.env,fx.now);
  assert.equal(readOnly.tenantCount,2);
  assert.equal(readOnly.validTenantCount,2);
  assert.equal(readOnly.customerGo,false);
  assert.equal(readOnly.writesChanged,false);
  const output=JSON.stringify(readOnly);
  assert.ok(ids.every(id=>output.includes(id)));
  assert.doesNotMatch(output,/PRIVATE KEY|BEGIN PUBLIC KEY|password|evidenceDigest/);
  const observed=[];
  const fetcher=async(url,init)=>{
    observed.push({url,method:init.method,redirect:init.redirect});
    const probe=PROBES.find(item=>url.endsWith(item.path));
    assert.ok(probe);
    return {
      status:probe.status,
      headers:{get:key=>key==='content-type'?'application/json':null},
      json:async()=>probe.id==='live'?{status:'live'}:
        probe.id==='ready'?{status:'ready',database:'ok',
          schemaVersion:'011_guest_pilot_safety.sql',leastPrivilege:true,
          forcedRls:true,guestWritesEnabled:false}:
        {error:'authentication required'}
    };
  };
  const report=await reviewWithCanary(fx.env,fx.now,fetcher);
  assert.equal(report.canaryStatus,'healthy');
  assert.equal(report.customerGo,false);
  assert.equal(observed.length,PROBES.length);
  assert.ok(observed.every(x=>x.method==='GET'&&x.redirect==='error'&&x.url.startsWith(LOCAL)));
});
