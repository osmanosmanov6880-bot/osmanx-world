import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {
  buildR27SyntheticCase,runR27FirstClientRehearsal
} from '../src/guest-r27-rehearsal.mjs';
import {makeR27Handoff} from '../src/guest-r27-handoff.mjs';
import {evaluateR28ManualGate} from '../src/guest-r28-stage-gate.mjs';
import {makeR28OperatorPacket} from '../src/guest-r28-operator-packet.mjs';
import {
  makeR29StagingHandoff,verifyR29StagingHandoff,
  r29HandoffCsv,R29_TASKS,R29_PREFLIGHT_SCHEMA
} from '../src/guest-r29-preflight.mjs';
const now=new Date('2026-11-19T12:00:00.000Z');
function fixture(id='normal'){
  const x=buildR27SyntheticCase(id);
  const r27=makeR27Handoff({
    r24:x.r24,r25:x.r25,r26:x.r26,audit:x.decision,
    rehearsal:runR27FirstClientRehearsal(),now
  });
  const gate=evaluateR28ManualGate({handoff:r27,now});
  const r28=makeR28OperatorPacket({handoff:r27,gate,now});
  return {r27,r28};
}
test('R29 safe 10-minute report preserves mandatory real-world blockers',()=>{
  const {r28}=fixture(),p=makeR29StagingHandoff({r28,now});
  assert.equal(p.schema,R29_PREFLIGHT_SCHEMA);
  assert.equal(p.pilotId,r28.pilotId);
  assert.equal(p.r28HandoffSha,r28.sha256);
  assert.equal(p.requiredSourcePrs,15);
  assert.equal(p.reviewedSourcePrs,0);
  assert.equal(p.firstUnmergedPr,47);
  assert.equal(Date.parse(p.expiresAt)-Date.parse(p.issuedAt),600000);
  assert.equal(p.steps.length,5);
  assert.deepEqual(p.steps.map(x=>x.code),R29_TASKS.map(x=>x.code));
  assert.equal(p.completeLocalPreparationForReview,false);
  assert.equal(p.productionAuthorized,false);
  assert.equal(p.actualProductionChecked,false);
  assert.equal(p.customerGo,false);
  assert.equal(p.automaticMergeAllowed,false);
  assert.ok(p.blockers.includes('R29_FINAL_MAIN_MERGED_TREE_CI_MISSING'));
  assert.ok(p.blockers.includes('R29_REAL_VPS_AND_OFFSITE_DR_NOT_VERIFIED'));
  assert.equal(verifyR29StagingHandoff(p,{now,pilotId:p.pilotId,
    version:p.version,r28HandoffSha:r28.sha256}).valid,true);
  const csv=r29HandoffCsv(p,{now});
  assert.ok(csv.startsWith('\uFEFF'));
  assert.ok(csv.includes('R29'));
  assert.ok(!csv.includes('someone@example.test'));
});
test('R29 reject tampered report, changed handoff, missing manual steps and forged production consent',()=>{
  const {r28}=fixture(),p=makeR29StagingHandoff({r28,now});
  for(const wrong of [
    {...p,sha256:'a'.repeat(64)},
    {...p,customerGo:true},
    {...p,productionAuthorized:true},
    {...p,automaticMergeAllowed:true},
    {...p,blockers:[]},
    {...p,steps:p.steps.slice(1)},
    {...p,firstUnmergedPr:99},
    {...p,checks:{...p.checks,finalMergedMainCiPassed:true}},
    {...p,customerEmail:'hello@example.test'}
  ])assert.equal(verifyR29StagingHandoff(wrong,{now}).valid,false);
  assert.equal(verifyR29StagingHandoff(p,{
    now,pilotId:randomUUID()}).valid,false);
  assert.equal(verifyR29StagingHandoff(p,{
    now,r28HandoffSha:'f'.repeat(64)}).valid,false);
  assert.equal(verifyR29StagingHandoff(p,{
    now:new Date(now.getTime()+600000)}).valid,false);
  assert.throws(()=>r29HandoffCsv(p,{
    now:new Date(now.getTime()+601000)}));
});
test('R29 STOP remains STOP independent of external source tests',()=>{
  const {r28}=fixture('emergency_stop');
  const p=makeR29StagingHandoff({r28,now});
  assert.equal(p.stage,'STOP');
  assert.equal(p.customerGo,false);
  assert.equal(p.productionAuthorized,false);
  assert.ok(p.blockers.includes('R29_EMERGENCY_STOP_ACTIVE'));
});
test('R29 rejects spoofed chain/merge/rollback inputs before creating human report',()=>{
  const {r28}=fixture();
  assert.throws(()=>makeR29StagingHandoff({
    r28,chain:{schema:'bogus',sourcePrCount:15},now
  }));
  assert.throws(()=>makeR29StagingHandoff({
    r28,virtualMerge:{schema:'bogus',mainRefUnchanged:true},now
  }));
  assert.throws(()=>makeR29StagingHandoff({
    r28,rollback:{schema:'bogus',productionDatabaseTouched:false},now
  }));
});
