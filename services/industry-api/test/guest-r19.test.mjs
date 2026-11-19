import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile,writeFile,chmod} from 'node:fs/promises';
import {syntheticR19} from './r19-synthetic-fixture.mjs';
import {
  collectionOperation,loadR19Scope,verifyR19Scope,r19Configured,
  inspectR19Scope,protocolDigest,scopeMessage
} from '../src/guest-r19-scope.mjs';
import {signR19Scope,stopR19} from '../scripts/r19-operator.mjs';
import {loadR18Anchor} from '../src/guest-r18-anchor.mjs';

const isoDay=date=>date.toISOString().slice(0,10);
async function fixture(t){
  const now=new Date();
  const ids=[randomUUID(),randomUUID()],pilotId=randomUUID();
  const row={
    id:pilotId,
    protocol:{
      startDate:isoDay(new Date(now.getTime()+86400000)),
      endDate:isoDay(new Date(now.getTime()+5*86400000)),
      outcomeWindowDays:7,allocation:'random',source:'pos',
      primaryMetric:'repeat_visit'
    },
    protocol_registered_at:new Date(now.getTime()-3600000)
  };
  const fx=await syntheticR19(ids,pilotId,row,{now});
  t.after(async()=>fx.cleanup());
  return {fx,ids,pilotId,row,now};
}
const keys=fx=>({
  operator:fx.operator.publicKey.export({type:'spki',format:'pem'}),
  externalCustodian:fx.r18.custodian.publicKey.export({type:'spki',format:'pem'})
});
const report=async(fx,now)=>verifyR19Scope(fx.signed,keys(fx),
  await loadR18Anchor(fx.env,null,now),{
    releaseCommit:fx.env.GUEST_RELEASE_COMMIT,
    now,minSequence:Number(fx.env.GUEST_R19_MIN_SEQUENCE),
    externalActor:'external-auditor'
  });
test('R19 signed one-pilot scope includes immutable registered protocol and 3 distinct legal evidence fingerprints',async t=>{
  const {fx,ids,pilotId,row,now}=await fixture(t);
  assert.equal(r19Configured(fx.env),true);
  assert.equal(r19Configured({GUEST_R18_ANCHOR_FILE:'/secure/a'}),false);
  const loaded=await loadR19Scope(fx.env,null,now);
  assert.equal(loaded.valid,true);
  assert.equal(loaded.tenantId,ids[0]);
  assert.equal(loaded.pilotId,pilotId);
  assert.equal(loaded.maxDailyWrites,3);
  assert.equal(loaded.record.protocolDigest,protocolDigest(row));
  assert.equal(loaded.record.policy.retentionDays,30);
  assert.equal(loaded.record.policy.purpose,'repeat_visit_aggregate_only');
  assert.equal(new Set([
    loaded.record.policy.contractEvidenceSha,
    loaded.record.policy.privacyEvidenceSha,
    loaded.record.policy.consentEvidenceSha
  ]).size,3);
  assert.equal((await inspectR19Scope(ids[1],fx.env,null,now)).valid,false);
  assert.equal((await inspectR19Scope(ids[0],fx.env,null,now)).valid,true);
  assert.equal((await report(fx,now)).valid,true);
  assert.notEqual(protocolDigest({...row,protocol:{...row.protocol,source:'manual'}}),
    loaded.record.protocolDigest);
});
test('R19 fails closed for altered scope, key reuse, shortened evidence, replay and expiry',async t=>{
  const {fx,now}=await fixture(t);
  const anchor=await loadR18Anchor(fx.env,null,now);
  const opts={releaseCommit:fx.env.GUEST_RELEASE_COMMIT,
    now,minSequence:Number(fx.env.GUEST_R19_MIN_SEQUENCE),
    externalActor:'external-auditor'};
  const bad=(record,k=keys(fx),o=opts)=>
    verifyR19Scope(record,k,anchor,o).valid===false;
  assert.equal(bad({...fx.signed,pilotId:randomUUID()}),true);
  assert.equal(bad({...fx.signed,journalSequence:anchor.sequence-1}),true);
  assert.equal(bad({...fx.signed,actorId:'external-auditor'}),true);
  assert.equal(bad({...fx.signed,signature:fx.signed.signature.slice(0,-4)+'AAAA'}),true);
  assert.equal(bad({...fx.signed,policy:{
    ...fx.signed.policy,consentEvidenceSha:'0'.repeat(64)
  }}),true);
  assert.equal(bad({...fx.signed,policy:{
    ...fx.signed.policy,maxDailyWrites:999
  }}),true);
  assert.equal(bad(fx.signed,{...keys(fx),operator:keys(fx).externalCustodian}),true);
  assert.equal(bad(fx.signed,keys(fx),{...opts,minSequence:anchor.sequence+1}),true);
  assert.equal(bad(fx.signed,keys(fx),{...opts,
    now:new Date(now.getTime()+3*86400000)}),true);
  const partial={...fx.env};
  delete partial.GUEST_R19_OPERATOR_PUBLIC_KEY;
  await assert.rejects(loadR19Scope(partial,null,now));
  const disabled={...fx.env,GUEST_R19_ROLLOUT_ENABLED:'false'};
  await assert.rejects(loadR19Scope(disabled,null,now));
  const wrongRelease={...fx.env,GUEST_RELEASE_COMMIT:'b'.repeat(40)};
  await assert.rejects(loadR19Scope(wrongRelease,null,now));
  const text=await readFile(fx.file,'utf8');
  await writeFile(fx.file,JSON.stringify({...fx.signed,pilotId:randomUUID()}),{mode:0o600});
  await assert.rejects(loadR19Scope(fx.env,null,now));
  await writeFile(fx.file,text,{mode:0o600});
  await chmod(fx.file,0o644);
  await assert.rejects(loadR19Scope(fx.env,null,now));
});
test('R19 one-way STOP is independent from API and requires human acknowledgement',async t=>{
  const {fx,now}=await fixture(t);
  await assert.rejects(stopR19(fx.env,{ack:'wrong',reasonCode:'consent_withdrawn'}));
  const stopped=await stopR19(fx.env,{
    ack:'CONFIRM_R19_PERMANENT_STOP',reasonCode:'consent_withdrawn'
  });
  assert.equal(stopped.stopped,true);
  assert.equal(stopped.alreadyStopped,false);
  assert.equal((await stopR19(fx.env,{
    ack:'CONFIRM_R19_PERMANENT_STOP',reasonCode:'client_request'
  })).alreadyStopped,true);
  const file=JSON.parse(await readFile(fx.stop,'utf8'));
  assert.equal(file.resumableByApi,false);
  assert.equal(file.reasonCode,'consent_withdrawn');
  await assert.rejects(loadR19Scope(fx.env,null,now));
  assert.equal((await inspectR19Scope(fx.r18.r17.fx.registry.tenants[0].tenantId,
    fx.env,null,now)).valid,false);
});
test('R19 a revoked underlying R18 checkpoint invalidates an otherwise valid pilot signature',async t=>{
  const {fx,ids,now}=await fixture(t);
  const original=fx.signed;
  await fx.r18.revoke(ids[0]);
  await assert.rejects(loadR19Scope(fx.env,null,now));
  assert.deepEqual(fx.signed,original);
});
test('R19 signed collection scope cannot be bypassed by unsafe route or preview URL',()=>{
  const id=randomUUID(),base='/api/industry/v1/guest/pilots/'+id+'/';
  for(const suffix of ['start','observations','observations/import']){
    const c=collectionOperation(base+suffix,'POST');
    assert.equal(c.pilotId,id);
    assert.equal(c.kind,suffix);
  }
  assert.equal(collectionOperation(base+'observations/import/preview','POST'),null);
  assert.equal(collectionOperation(base+'safety/hold','POST'),null);
  assert.equal(collectionOperation(base+'observations/x/void','POST'),null);
  assert.equal(collectionOperation(base+'observations','GET'),null);
  assert.equal(collectionOperation('/api/industry/v1/guest/requests','POST'),null);
  assert.equal(collectionOperation(base+'observations/extra','POST'),null);
  assert.equal(collectionOperation(base+'observations/../start','POST'),null);
});
test('R19 independent signer refuses incorrect keys and incomplete unsigned plans',async t=>{
  const {fx,now}=await fixture(t);
  const {signature,...unsigned}=fx.signed;
  const options={env:fx.env,now,
    anchor:await loadR18Anchor(fx.env,null,now),
    externalPublicPem:keys(fx).externalCustodian,
    externalActor:'external-auditor'};
  assert.equal(scopeMessage(unsigned),scopeMessage(fx.signed));
  const signed=signR19Scope(unsigned,
    fx.operator.privateKey.export({type:'pkcs8',format:'pem'}),options);
  assert.equal((await report(fx,now)).valid,true);
  assert.deepEqual(signed,fx.signed);
  assert.throws(()=>signR19Scope({...unsigned,extra:true},
    fx.operator.privateKey.export({type:'pkcs8',format:'pem'}),options));
  assert.throws(()=>signR19Scope(unsigned,keys(fx).operator,options));
  assert.throws(()=>signR19Scope({...unsigned,actorId:'external-auditor'},
    fx.operator.privateKey.export({type:'pkcs8',format:'pem'}),options));
});
