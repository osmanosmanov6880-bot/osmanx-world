import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile,writeFile,chmod} from 'node:fs/promises';
import {syntheticR17} from './r17-synthetic-fixture.mjs';
import {verifyJournal,verifyWitnesses,loadR17Witness,r17Configured,
  eventDigest,GENESIS} from '../src/guest-r17-witness.mjs';
import {buildWitnessPlan,verifyPlan,signWitnessPlan} from '../scripts/r17-witness-signer.mjs';
import {rehearseFirstCustomer} from '../scripts/r17-onboarding.mjs';
import {PROBES,LOCAL} from '../scripts/r14-monitor.mjs';

async function setup(t){
  const ids=[randomUUID(),randomUUID()];
  const fx=await syntheticR17(ids);
  t.after(async()=>fx.cleanup());
  return {fx,ids};
}
const pub=fx=>Object.fromEntries(['owner','manager'].map(role=>[role,
  fx.keys[role].publicKey.export({type:'spki',format:'pem'})]));
const signed=async fx=>[JSON.parse(await readFile(fx.ownerFile,'utf8')),
  JSON.parse(await readFile(fx.managerFile,'utf8'))];
test('R17 independently signed hash-chain and two witness files cover two tenant admissions',async t=>{
  const {fx,ids}=await setup(t);
  const loaded=await loadR17Witness(fx.env,fx.now);
  assert.equal(loaded.checkpoint.revision,1);
  assert.equal(loaded.checkpoint.sequence,3);
  assert.equal(loaded.sequence,3);
  const journal=verifyJournal(fx.journal,fx.fx.registry,fx.now);
  assert.equal(journal.valid,true,journal.blockers.join(','));
  const [owner,manager]=await signed(fx);
  const report=verifyWitnesses(owner,manager,pub(fx),fx.fx.registry,fx.journal,{
    now:fx.now,minSequence:3,minRevision:1,releaseCommit:fx.env.GUEST_RELEASE_COMMIT
  });
  assert.equal(report.valid,true,report.blockers.join(','));
  assert.equal(r17Configured(fx.env),true);
  assert.equal(r17Configured({GUEST_R16_REGISTRY_FILE:'a'}),false);
  for(const id of ids)assert.ok(fx.journal.entries.some(x=>x.tenantId===id));
});
test('R17 rejects ledger tampering, truncation, unauthorized publication, expired or substituted signers',async t=>{
  const {fx}=await setup(t);
  const [owner,manager]=await signed(fx);
  const tampered={...fx.journal,entries:fx.journal.entries.map((x,i)=>
    i===1?{...x,reasonCode:'operator_request'}:x)};
  assert.equal(verifyJournal(tampered,fx.fx.registry,fx.now).valid,false);
  const truncated={...fx.journal,entries:fx.journal.entries.slice(0,2)};
  assert.equal(verifyJournal(truncated,fx.fx.registry,fx.now).valid,false);
  assert.equal(verifyWitnesses(owner,manager,pub(fx),fx.fx.registry,tampered,{
    now:fx.now,releaseCommit:fx.env.GUEST_RELEASE_COMMIT
  }).valid,false);
  assert.equal(verifyWitnesses({...owner,actorId:'other-owner'},manager,pub(fx),
    fx.fx.registry,fx.journal,{now:fx.now,releaseCommit:fx.env.GUEST_RELEASE_COMMIT}).valid,false);
  assert.equal(verifyWitnesses(owner,manager,{owner:pub(fx).owner,
    manager:pub(fx).owner},fx.fx.registry,fx.journal,{
    now:fx.now,releaseCommit:fx.env.GUEST_RELEASE_COMMIT
  }).valid,false);
  assert.equal(verifyWitnesses(owner,manager,pub(fx),fx.fx.registry,fx.journal,{
    now:new Date(fx.now.getTime()+3*3600000),
    releaseCommit:fx.env.GUEST_RELEASE_COMMIT
  }).valid,false);
  assert.equal(verifyWitnesses(owner,manager,pub(fx),fx.fx.registry,fx.journal,{
    now:fx.now,minSequence:99,releaseCommit:fx.env.GUEST_RELEASE_COMMIT
  }).valid,false);
  assert.equal(verifyWitnesses(owner,manager,pub(fx),fx.fx.registry,fx.journal,{
    now:fx.now,releaseCommit:'b'.repeat(40)
  }).valid,false);
  const broken={...fx.env,GUEST_R17_MANAGER_WITNESS_FILE:fx.ownerFile};
  await assert.rejects(loadR17Witness(broken,fx.now));
});
test('R17 file revocation and signed new revision preserve independent testimony',async t=>{
  const {fx,ids}=await setup(t);
  const old=await loadR17Witness(fx.env,fx.now);
  const next=await fx.revoke(ids[0],'security_incident');
  assert.equal(next.revision,2);
  assert.equal(next.sequence,5);
  const report=await loadR17Witness(fx.env,fx.now);
  assert.equal(report.checkpoint.revision,2);
  assert.equal(report.checkpoint.sequence,5);
  assert.notEqual(report.checkpointDigest,old.checkpointDigest);
  const replay={...fx.env,GUEST_R17_MIN_SEQUENCE:'6'};
  await assert.rejects(loadR17Witness(replay,fx.now));
  const wrongIndex={...fx.fx.registry,revoked:[]};
  assert.equal(verifyJournal(fx.journal,wrongIndex,fx.now).valid,false);
});
test('R17 independent signing station validates plans and refuses wrong or changed data',async t=>{
  const {fx}=await setup(t);
  const plan=fx.plan;
  assert.equal(verifyPlan(plan,fx.fx.registry,fx.journal,fx.now),true);
  const owner=signWitnessPlan(plan,{role:'owner',actorId:'r17-independent-owner',
    privatePem:fx.keys.owner.privateKey.export({type:'pkcs8',format:'pem'})},fx.now);
  assert.equal(owner.schema,'osmanx.guest.r17.witness.v1');
  const [published]=await signed(fx);
  assert.deepEqual(owner,published);
  assert.throws(()=>verifyPlan({...plan,registryDigest:'c'.repeat(64)},
    fx.fx.registry,fx.journal,fx.now));
  assert.throws(()=>signWitnessPlan({...plan,expiresAt:'1900-01-01T00:00:00.000Z'},
    {role:'owner',actorId:'r17-independent-owner',
    privatePem:fx.keys.owner.privateKey.export({type:'pkcs8',format:'pem'})},fx.now));
  assert.throws(()=>signWitnessPlan(plan,{role:'manager',actorId:'invalid',
    privatePem:pub(fx).owner},fx.now));
});
test('R17 first-customer rehearsal never accepts missing DB or enables writes',async t=>{
  const {fx,ids}=await setup(t);
  const calls=[];
  const fetcher=async(url,init)=>{
    calls.push({url,method:init.method,redirect:init.redirect});
    const spec=PROBES.find(x=>url.endsWith(x.path));
    assert.ok(spec);
    return {status:spec.status,headers:{get:k=>k==='content-type'?'application/json':null},
      json:async()=>spec.id==='live'?{status:'live'}:
        spec.id==='ready'?{status:'ready',database:'ok',
          schemaVersion:'011_guest_pilot_safety.sql',leastPrivilege:true,
          forcedRls:true,guestWritesEnabled:false}:{error:'authentication required'}};
  };
  const report=await rehearseFirstCustomer({
    tenantId:ids[0],env:fx.env,now:fx.now,fetcher
  });
  assert.equal(report.signedTenantPermit,true);
  assert.equal(report.independentWitnesses,true);
  assert.equal(report.canaryHealthy,true);
  assert.equal(report.technicalReviewPassed,false);
  assert.equal(report.customerGo,false);
  assert.equal(report.changedProduction,false);
  assert.ok(report.blockers.includes('database_readiness_unavailable'));
  assert.ok(calls.every(x=>x.method==='GET'&&x.redirect==='error'&&x.url.startsWith(LOCAL)));
});
