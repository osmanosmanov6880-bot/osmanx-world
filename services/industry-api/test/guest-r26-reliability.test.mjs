import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {makeR25Brief} from '../src/guest-r25-brief.mjs';
import {assessR26SignalReliability} from '../src/guest-r26-bias.mjs';
import {parseR26ReviewRequest,evaluateR26ReviewGate}
  from '../src/guest-r26-review.mjs';
import {chooseR26Decision} from '../src/guest-r26-decision.mjs';
import {makeR26Brief,verifyR26Brief,r26BriefCsv}
  from '../src/guest-r26-brief.mjs';
const now=new Date('2026-11-20T12:00:00.000Z');
const protocol={startDate:'2026-11-01',endDate:'2026-11-12',
  outcomeWindowDays:7,allocation:'random',
  source:'pos',primaryMetric:'repeat_visit'};
const sha=c=>c.repeat(64);
function sample(date,shift,wait,source='staff_estimate'){
  return {date,shift,source,sampled:20,
    counts:{wait,stockout:3,ordering:2,price:2,service:1,
      unknown:12-wait}};
}
function setup(){
  const pilot={id:randomUUID(),version:4,phase:'reviewed',
    target_per_group:50,protocol};
  const rows=[
    sample('2026-11-01','morning',5),
    sample('2026-11-02','morning',6),
    sample('2026-11-06','evening',8,'anonymous_counter'),
    sample('2026-11-07','evening',7,'anonymous_counter')
  ];
  const r24={
    schema:'osmanx.guest.r24.manager-brief.v1',pilotId:pilot.id,
    version:pilot.version,evidenceDigest:sha('a'),
    observedPeriods:4,quality:{analysisStatus:'REVIEW_ONLY'},
    statistics:{controlRatePct:24,offerRatePct:35,
      differencePp:11,interval95Pp:[-1,23]}
  };
  const r25=makeR25Brief({pilot,rows,r24,now});
  const review=(role,index,method='independent_aggregate_recount')=>({
    pilotVersion:pilot.version,sourceSha:r25.tallySourceSha,
    r24EvidenceSha:r25.r24EvidenceSha,
    tallyRows:rows.length,actorId:randomUUID(),role,method,
    verdict:'reconciled',evidenceSha:sha(index===1?'b':'c')
  });
  return {pilot,rows,r25,r24,review};
}
test('R26 only accepts strictly structured private SHA declarations, never text or source self-reference',()=>{
  const base={expectedVersion:4,sourceSha:sha('a'),
    r24EvidenceSha:sha('b'),evidenceSha:sha('c'),
    method:'staff_shift_crosscheck',verdict:'reconciled'};
  assert.equal(parseR26ReviewRequest(base).sourceSha,sha('a'));
  for(const wrong of [
    {...base,clientEmail:'test@example.com'},
    {...base,evidenceSha:sha('a')},
    {...base,sourceSha:'0'},
    {...base,verdict:'approved_for_production'},
    {...base,method:'phone_calls'},
    {...base,expectedVersion:0}
  ])assert.throws(()=>parseR26ReviewRequest(wrong));
});
test('R26 reports major source/shift drift, but never invents real customer motives',()=>{
  const f=setup(),bias=assessR26SignalReliability({
    rows:f.rows,profile:f.r25.profile,protocol,now});
  assert.equal(bias.schema,'osmanx.guest.r26.source-bias.v1');
  assert.equal(bias.totalSampled,80);
  assert.equal(bias.sourceMix.staffPct,50);
  assert.equal(bias.sourceMix.counterPct,50);
  assert.equal(bias.earlyLateShiftDriftPct,100);
  assert.ok(bias.warnings.includes('SHIFT_COMPOSITION_CHANGED'));
  assert.ok(bias.warnings.includes('SOURCE_COMPOSITION_CHANGED'));
  assert.equal(bias.representativeSamplingProven,false);
  assert.equal(bias.individualMotiveInferred,false);
  assert.equal(bias.causalExplanationProven,false);
  assert.throws(()=>assessR26SignalReliability({
    rows:[...f.rows,...f.rows.slice(0,1)],profile:f.r25.profile,protocol,now
  }));
});
test('R26 rejects one signature-like declaration and allows only different owner and manager with distinct documents',()=>{
  const f=setup(),owner=f.review('owner',1),manager=f.review('manager',2);
  const opts={pilotId:f.pilot.id,pilotVersion:f.pilot.version,
    sourceSha:f.r25.tallySourceSha,r24EvidenceSha:f.r25.r24EvidenceSha,
    tallyRows:f.rows.length};
  const pending=evaluateR26ReviewGate({...opts,reviews:[owner]});
  assert.equal(pending.internalDeclarationsComplete,false);
  assert.ok(pending.blockers.includes('MANAGER_REVIEW_MISSING_OR_DUPLICATE'));
  const complete=evaluateR26ReviewGate({
    ...opts,reviews:[owner,manager]});
  assert.equal(complete.internalDeclarationsComplete,true);
  assert.equal(complete.reviewedPrimaryEvidenceExternally,false);
  assert.equal(complete.reviewerCryptographicSignatures,false);
  assert.equal(complete.customerGo,false);
  const sameActor=evaluateR26ReviewGate({
    ...opts,reviews:[owner,{...manager,actorId:owner.actorId}]});
  assert.ok(sameActor.blockers.includes('REVIEW_ACTORS_NOT_SEPARATE'));
  const sameDoc=evaluateR26ReviewGate({
    ...opts,reviews:[owner,{...manager,evidenceSha:owner.evidenceSha}]});
  assert.ok(sameDoc.blockers.includes('REVIEW_WORKPAPERS_NOT_DISTINCT'));
  const rejected=evaluateR26ReviewGate({
    ...opts,reviews:[owner,{...manager,verdict:'rejected'}]});
  assert.ok(rejected.blockers.includes('INTERNAL_REVIEW_REJECTED'));
  const stale=evaluateR26ReviewGate({
    ...opts,pilotVersion:5,reviews:[owner,manager]});
  assert.equal(stale.currentReviewCount,0);
  assert.equal(stale.historicalReviewCount,2);
  const held=evaluateR26ReviewGate({
    ...opts,reviews:[owner,manager],stopActive:true});
  assert.equal(held.internalDeclarationsComplete,false);
});
test('R26 decides STOP > no signals > incomplete reviews > shift bias > external audit',()=>{
  const f=setup();
  const bias=assessR26SignalReliability({
    rows:f.rows,profile:f.r25.profile,protocol,now});
  const review=evaluateR26ReviewGate({
    pilotId:f.pilot.id,pilotVersion:f.pilot.version,
    sourceSha:f.r25.tallySourceSha,r24EvidenceSha:f.r25.r24EvidenceSha,
    tallyRows:f.rows.length,reviews:[]});
  const waiting=chooseR26Decision({r25:f.r25,review,bias});
  assert.equal(waiting.firstAction.code,'SOURCE_AUDIT');
  assert.equal(waiting.customerGo,false);
  const held=chooseR26Decision({r25:f.r25,review,bias,stopActive:true});
  assert.equal(held.firstAction.code,'SAFETY_STOP');
  const complete=evaluateR26ReviewGate({
    pilotId:f.pilot.id,pilotVersion:f.pilot.version,
    sourceSha:f.r25.tallySourceSha,r24EvidenceSha:f.r25.r24EvidenceSha,
    tallyRows:f.rows.length,
    reviews:[f.review('owner',1),f.review('manager',2)]});
  const drift=chooseR26Decision({r25:f.r25,review:complete,bias});
  assert.equal(drift.firstAction.code,'SHIFT_REBALANCE');
  assert.equal(drift.experimentStarted,false);
  assert.equal(drift.actionAutomaticallyAssigned,false);
});
test('R26 memo never exposes actor IDs, tamper and customer GO are rejected; CSV remains anonymous',()=>{
  const f=setup(),owner=f.review('owner',1),manager=f.review('manager',2);
  const args={pilot:f.pilot,r25:f.r25,rows:f.rows,
    reviews:[owner,manager],reviewEnabled:true,now};
  const memo=makeR26Brief(args);
  assert.equal(memo.schema,'osmanx.guest.r26.source-reliability-brief.v1');
  assert.equal(memo.review.internalDeclarationsComplete,true);
  assert.equal(memo.externalAuditCompleted,false);
  assert.equal(memo.customerGo,false);
  assert.equal(memo.productionAuthorized,false);
  assert.equal(verifyR26Brief(memo,{
    pilotId:f.pilot.id,r25SourceSha:f.r25.tallySourceSha
  }).valid,true);
  for(const secret of [owner.actorId,manager.actorId,owner.evidenceSha,
    manager.evidenceSha])
    assert.equal(JSON.stringify(memo).includes(secret),false);
  assert.equal(verifyR26Brief({...memo,customerGo:true}).valid,false);
  assert.equal(verifyR26Brief({...memo,
    sourceSampled:999}).valid,false);
  assert.equal(verifyR26Brief({...memo,email:'test@example.com'}).valid,false);
  const csv=r26BriefCsv(memo);
  assert.ok(csv.startsWith('\uFEFF'));
  assert.ok(csv.includes('SHA-256'));
  assert.equal(csv.includes('test@example.com'),false);
  const blocked=makeR26Brief({...args,stopActive:true});
  assert.equal(blocked.reviewEnabled,false);
  assert.equal(blocked.decision.firstAction.code,'SAFETY_STOP');
  assert.equal(verifyR26Brief(blocked).valid,true);
});
