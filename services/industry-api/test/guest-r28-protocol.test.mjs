import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,generateKeyPairSync,sign} from 'node:crypto';
import {
  R28_EVIDENCE_SCHEMA,ROLES,r28SigningBytes,
  verifyR28IndependentReceipts,hashR28EvidenceBytes
} from '../src/guest-r28-attestations.mjs';
import {
  makeR27Handoff
} from '../src/guest-r27-handoff.mjs';
import {buildR27SyntheticCase,
  runR27FirstClientRehearsal} from '../src/guest-r27-rehearsal.mjs';
import {evaluateR28ManualGate,R28_STEP_CODES}
  from '../src/guest-r28-stage-gate.mjs';
import {
  makeR28OperatorPacket,verifyR28OperatorPacket,
  r28OperatorCsv
} from '../src/guest-r28-operator-packet.mjs';
const now=new Date('2026-11-19T12:00:00.000Z');
function handoffFor(id='normal'){
  const x=buildR27SyntheticCase(id);
  return makeR27Handoff({r24:x.r24,r25:x.r25,r26:x.r26,
    audit:x.decision,rehearsal:runR27FirstClientRehearsal(),now});
}
function signatures(){
  const identity={tenantId:randomUUID(),pilotId:randomUUID(),
    releaseSha:'a'.repeat(40),r27HandoffSha:'b'.repeat(64),
    expiresAt:new Date(now.getTime()+15*60000).toISOString()};
  const keys={},receipts=[];
  for(const [i,role] of ROLES.entries()){
    const pair=generateKeyPairSync('ed25519');keys[role]=pair.publicKey;
    const item={role,decision:'reviewed',evidenceSha:String(i+1).repeat(64),
      observedAt:now.toISOString()};
    const signature=sign(null,r28SigningBytes(item,identity),pair.privateKey);
    receipts.push({...item,signature:signature.toString('base64')});
  }
  return {identity,publicKeys:keys,packet:{
    schema:R28_EVIDENCE_SCHEMA,receipts
  }};
}
test('R28 independent Ed25519 signatures bind 4 different roles, releases, pilot and evidence SHA',()=>{
  const v=signatures();
  const accepted=verifyR28IndependentReceipts({...v,now});
  assert.equal(accepted.cryptographicReceiptsVerified,true,
    JSON.stringify(accepted.blockers));
  assert.equal(accepted.permissionToDeploy,false);
  assert.equal(accepted.offsiteCustodyProven,false);
  assert.equal(accepted.legalBasisConfirmed,false);
  assert.equal(Object.keys(accepted.checks).length,4);
  assert.match(hashR28EvidenceBytes(Buffer.from('synthetic aggregate')),
    /^[a-f0-9]{64}$/);
});
test('R28 cryptographic verifier rejects forged evidence, copied signer, wrong release, stale or future receipts',()=>{
  const a=signatures();
  const changed={...a,packet:{schema:R28_EVIDENCE_SCHEMA,
    receipts:a.packet.receipts.map((x,i)=>i===1?
      {...x,evidenceSha:'f'.repeat(64)}:x)}};
  assert.equal(verifyR28IndependentReceipts({...changed,now})
    .cryptographicReceiptsVerified,false);
  const duplicated={...a,publicKeys:{
    ...a.publicKeys,recovery:a.publicKeys.host}};
  assert.equal(verifyR28IndependentReceipts({...duplicated,now})
    .cryptographicReceiptsVerified,false);
  assert.equal(verifyR28IndependentReceipts({
    ...a,identity:{...a.identity,releaseSha:'e'.repeat(40)},now
  }).cryptographicReceiptsVerified,false);
  assert.equal(verifyR28IndependentReceipts({
    ...a,now:new Date(now.getTime()+16*60000)
  }).cryptographicReceiptsVerified,false);
  const rejected={...a,packet:{...a.packet,
    receipts:a.packet.receipts.map((x,i)=>i===2?
      {...x,decision:'rejected'}:x)}};
  assert.equal(verifyR28IndependentReceipts({...rejected,now})
    .cryptographicReceiptsVerified,false);
  const replay={...a,packet:{...a.packet,
    receipts:[...a.packet.receipts.slice(0,3),
      a.packet.receipts[0]]}};
  assert.equal(verifyR28IndependentReceipts({...replay,now})
    .cryptographicReceiptsVerified,false);
});
test('R28 with no external evidence remains review-only even after seven synthetic successes',()=>{
  const handoff=handoffFor();
  const stage=evaluateR28ManualGate({handoff,now});
  assert.equal(stage.schema,'osmanx.guest.r28.manual-cutover-gate.v1');
  assert.equal(stage.stage,'SOURCE_CHAIN_UNVERIFIED');
  assert.equal(stage.checks.internalSyntheticScenariosPassed,true);
  assert.equal(stage.checkedSourcePrs,0);
  assert.equal(stage.steps.length,7);
  assert.deepEqual(stage.steps.map(x=>x.code),R28_STEP_CODES);
  assert.ok(stage.steps.every(x=>x.executed===false));
  assert.ok(stage.blockers.includes('R28_MAIN_MERGED_TREE_CI_NOT_RUN'));
  assert.ok(stage.blockers.includes('R28_LAWFUL_BASIS_NOT_VERIFIED'));
  assert.equal(stage.automaticMergeAllowed,false);
  assert.equal(stage.productionAuthorized,false);
});
test('R28 external receipt and source evidence only advance a review stage, never activate production',()=>{
  const h=handoffFor();
  const chain={schema:'osmanx.guest.r28.fourteen-source-integration.v1',
    sourcePrCount:14,automaticMergeAllowed:false,deployAllowed:false,
    productionAuthorized:false,sourceHeadSha:'a'.repeat(40),
    verifiedStagedSource:true,allMerged:false,postMergeMainTested:false};
  const receipts={schema:'osmanx.guest.r28.offline-verification.v1',
    cryptographicReceiptsVerified:true,permissionToDeploy:false,
    customerGo:false};
  const stage=evaluateR28ManualGate({handoff:h,chain,receipts,now});
  assert.equal(stage.stage,'MANUAL_MERGE_PENDING');
  assert.equal(stage.externalReceiptSignaturesVerified,true);
  assert.equal(stage.productionAuthorized,false);
  assert.ok(stage.blockers.includes('R28_MANUAL_MERGES_OUTSTANDING'));
  const stopped=evaluateR28ManualGate({
    handoff:handoffFor('emergency_stop'),now});
  assert.equal(stopped.stage,'STOP');
  assert.equal(stopped.customerGo,false);
  assert.throws(()=>evaluateR28ManualGate({
    handoff:h,chain:{...chain,automaticMergeAllowed:true},now
  }));
});
test('R28 expiring operator packet has distinct 15-min TTL, fixed seven tasks, SHA and no client secrets',()=>{
  const h=handoffFor(),gate=evaluateR28ManualGate({handoff:h,now});
  const packet=makeR28OperatorPacket({handoff:h,gate,now});
  assert.equal(packet.schema,'osmanx.guest.r28.manual-operator-packet.v1');
  assert.equal(Date.parse(packet.expiresAt)-Date.parse(packet.issuedAt),15*60000);
  assert.equal(packet.verifiedSourcePrs,0);
  assert.equal(packet.automaticMergeAllowed,false);
  assert.equal(packet.productionAuthorized,false);
  assert.equal(packet.actualProductionInspected,false);
  assert.equal(verifyR28OperatorPacket(packet,{now,
    pilotId:h.pilotId,version:h.version,r27HandoffSha:h.sha256}).valid,true);
  const content=r28OperatorCsv(packet,{now});
  assert.ok(content.startsWith('\uFEFF'));
  assert.ok(content.includes('SHA-256'));
  assert.ok(!content.includes('private@example.test'));
  assert.equal(verifyR28OperatorPacket(packet,{
    now:new Date(now.getTime()+15*60000)}).valid,false);
});
test('R28 operator handoff rejects tampering, missing stop/permission blockers and false GO',()=>{
  const h=handoffFor(),g=evaluateR28ManualGate({handoff:h,now});
  const p=makeR28OperatorPacket({handoff:h,gate:g,now});
  for(const bad of [
    {...p,productionAuthorized:true},
    {...p,blockers:[]},
    {...p,customerGo:true},
    {...p,operatorSteps:p.operatorSteps.slice(1)},
    {...p,source:{privateEmail:'person@example.test'}},
    {...p,sha256:'f'.repeat(64)}
  ])assert.equal(verifyR28OperatorPacket(bad,{now}).valid,false);
  assert.equal(verifyR28OperatorPacket(p,{
    now,pilotId:randomUUID()}).valid,false);
  assert.throws(()=>r28OperatorCsv({...p,productionAuthorized:true},{now}));
  assert.throws(()=>makeR28OperatorPacket({
    handoff:h,gate:{...g,customerGo:true},now}));
});
