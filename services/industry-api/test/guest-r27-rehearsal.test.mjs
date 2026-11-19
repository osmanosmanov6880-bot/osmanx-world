import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {auditR27Decision} from '../src/guest-r27-decision-audit.mjs';
import {
  R27_REHEARSAL_SCHEMA,buildR27SyntheticCase,
  runR27FirstClientRehearsal
} from '../src/guest-r27-rehearsal.mjs';
import {
  R27_HANDOFF_SCHEMA,makeR27Handoff,
  verifyR27Handoff,r27HandoffCsv
} from '../src/guest-r27-handoff.mjs';
const now=new Date('2026-11-19T12:00:00.000Z');
const first=()=>buildR27SyntheticCase('normal');
const handoff=()=>{
  const {r24,r25,r26,decision}=first();
  const rehearsal=runR27FirstClientRehearsal();
  return makeR27Handoff({
    r24,r25,r26,audit:decision,rehearsal,now
  });
};
test('R27 seven real R24→R25→R26→R27 pure synthetic paths are deterministic and fail-closed',()=>{
  const one=runR27FirstClientRehearsal(),two=runR27FirstClientRehearsal();
  assert.deepEqual(one,two);
  assert.equal(one.schema,R27_REHEARSAL_SCHEMA);
  assert.equal(one.totalCases,7);
  assert.equal(one.passedCases,7,JSON.stringify(one.cases));
  assert.equal(one.allPassed,true);
  assert.equal(one.realCustomerDataUsed,false);
  assert.equal(one.persistedRecords,0);
  assert.equal(one.runtimeExternalCalls,0);
  assert.equal(one.productionAuthorized,false);
  assert.equal(one.customerGo,false);
  assert.ok(one.cases.every(c=>c.passed&&c.customerGo===false&&
    c.sourceRecordsSynthetic===true));
  assert.match(one.sha256,/^[a-f0-9]{64}$/);
  assert.throws(()=>buildR27SyntheticCase('real_clients'));
});
test('R27 decision integrity checks cross-layer hashes, changing version and STOP consistency',()=>{
  const x=first();
  assert.equal(x.decision.state,'EXTERNAL_REVIEW_REQUIRED');
  assert.equal(x.decision.evidenceReviewInternallyComplete,true);
  assert.equal(x.decision.checks.samePilot,true);
  assert.equal(x.decision.checks.sameVersion,true);
  assert.equal(x.decision.checks.sameR24,true);
  assert.equal(x.decision.checks.sameR25,true);
  assert.equal(x.decision.causalEffectProven,false);
  assert.equal(x.decision.customerGo,false);
  assert.ok(x.decision.blockers.includes('R27_EXTERNAL_SOURCE_AUDIT_REQUIRED'));
  assert.throws(()=>auditR27Decision({
    r24:{...x.r24,version:x.r24.version+1},
    r25:x.r25,r26:x.r26
  }));
  assert.throws(()=>auditR27Decision({
    r24:x.r24,r25:{...x.r25,tallySourceSha:'0'.repeat(64)},
    r26:x.r26
  }));
  assert.throws(()=>auditR27Decision({
    r24:x.r24,r25:x.r25,
    r26:{...x.r26,productionAuthorized:true}
  }));
});
test('R27 precisely distinguishes STOP, stale approvals, counting-method drift and adverse returns',()=>{
  const stop=buildR27SyntheticCase('emergency_stop');
  assert.equal(stop.decision.state,'SAFETY_HOLD');
  assert.equal(stop.decision.nextAction.code,'SAFETY_STOP');
  const absent=buildR27SyntheticCase('no_operational_signals');
  assert.equal(absent.decision.state,'SOURCE_REVIEW_PENDING');
  assert.equal(absent.decision.checks.sufficientShiftCount,false);
  const rejected=buildR27SyntheticCase('rejected_internal_review');
  assert.equal(rejected.r26.review.internalDeclarationsComplete,false);
  assert.equal(rejected.decision.state,'SOURCE_REVIEW_PENDING');
  const mix=buildR27SyntheticCase('source_mix_shift');
  assert.equal(mix.decision.state,'SHIFT_BIAS_REVIEW');
  assert.ok(mix.r26.bias.warnings.includes('SOURCE_COMPOSITION_CHANGED'));
  const stale=buildR27SyntheticCase('stale_version_reviews');
  assert.equal(stale.decision.state,'SOURCE_REVIEW_PENDING');
  assert.equal(stale.r26.review.historicalReviewCount,2);
  const loss=buildR27SyntheticCase('negative_observed_difference');
  assert.ok(loss.r24.statistics.differencePp<0);
  assert.equal(loss.r24.scenario.state,'SCENARIO_ONLY');
  assert.equal(loss.decision.actualROIValidated,false);
  for(const x of [stop,absent,rejected,mix,stale,loss]){
    assert.equal(x.decision.customerGo,false);
    assert.equal(x.decision.newPilotStarted,false);
  }
});
test('R27 30-minute packet binds five SHA snapshots without PII or fake authorization',()=>{
  const packet=handoff();
  assert.equal(packet.schema,R27_HANDOFF_SCHEMA);
  assert.match(packet.sha256,/^[a-f0-9]{64}$/);
  assert.equal(packet.decision.technicalReviewMayProceed,true);
  assert.equal(packet.rehearsal.passedCases,7);
  assert.equal(packet.authorizedOperatorSignature,false);
  assert.equal(packet.customerGo,false);
  assert.equal(packet.productionAuthorized,false);
  assert.equal(packet.reportContainsPersonalData,false);
  assert.equal(packet.blockers.includes('R27_HUMAN_MERGE_AND_CHANGE_TICKET_REQUIRED'),true);
  assert.equal(verifyR27Handoff(packet,{
    now,pilotId:packet.pilotId,version:packet.version,
    source:{r25SourceSha:packet.source.r25SourceSha}
  }).valid,true);
  const csv=r27HandoffCsv(packet,{now});
  assert.ok(csv.startsWith('\uFEFF'));
  assert.ok(csv.includes('R27'));
  assert.equal(csv.includes('customer@example.test'),false);
});
test('R27 rejects tampering, wrong pilot, expired packet, copied approval, missing outside block',()=>{
  const p=handoff();
  for(const corrupted of [
    {...p,customerGo:true},
    {...p,productionAuthorized:true},
    {...p,authorizedOperatorSignature:true},
    {...p,source:{...p.source,r24BriefSha:'0'.repeat(64)}},
    {...p,rehearsal:{...p.rehearsal,passedCases:0}},
    {...p,blockers:[]},
    {...p,privateEmail:'customer@example.test'},
    {...p,sha256:'0'.repeat(64)}
  ])assert.equal(verifyR27Handoff(corrupted,{now}).valid,false);
  assert.equal(verifyR27Handoff(p,{
    now,pilotId:randomUUID()
  }).valid,false);
  assert.equal(verifyR27Handoff(p,{
    now,source:{r26BriefSha:'e'.repeat(64)}
  }).valid,false);
  assert.equal(verifyR27Handoff(p,{
    now:new Date(now.getTime()+30*60000)
  }).valid,false);
  assert.equal(verifyR27Handoff(p,{
    now:new Date(now.getTime()-1000)
  }).valid,false);
  assert.throws(()=>r27HandoffCsv(p,{
    now:new Date(now.getTime()+31*60000)
  }));
});
test('R27 packet requires unaltered rehearsal and cannot be manufactured from invalid R26',()=>{
  const x=first(),run=runR27FirstClientRehearsal();
  const params={r24:x.r24,r25:x.r25,r26:x.r26,
    audit:x.decision,rehearsal:run,now};
  assert.throws(()=>makeR27Handoff({
    ...params,rehearsal:{...run,passedCases:0}
  }));
  assert.throws(()=>makeR27Handoff({
    ...params,r26:{...x.r26,customerGo:true}
  }));
  assert.throws(()=>makeR27Handoff({
    ...params,audit:{...x.decision,blockers:['customer@example.test']}
  }));
});
