import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {
  parseR25Tally,summarizeR25Operational,R25_CODES,
  R25_PROFILE_SCHEMA
} from '../src/guest-r25-signals.mjs';
import {deriveR25Hypotheses} from '../src/guest-r25-hypotheses.mjs';
import {draftR25Experiment} from '../src/guest-r25-experiment.mjs';
import {makeR25Brief,verifyR25Brief,r25BriefCsv}
  from '../src/guest-r25-brief.mjs';
import {collectionOperation} from '../src/guest-r19-scope.mjs';
const now=new Date('2026-11-19T14:00:00.000Z');
const protocol={startDate:'2026-11-01',endDate:'2026-11-10',
  outcomeWindowDays:14,allocation:'random',source:'pos',
  primaryMetric:'repeat_visit'};
const args={protocol,now};
function row(date,shift,wait,source='staff_estimate'){
  const sampled=20;
  return {date,shift,source,sampled,
    counts:{wait,stockout:3,ordering:2,price:2,service:1,
      unknown:sampled-wait-8}};
}
function fixture(){
  const rows=[
    row('2026-11-01','morning',2),
    row('2026-11-03','afternoon',4),
    row('2026-11-05','morning',7),
    row('2026-11-07','evening',8)
  ];
  const profile=summarizeR25Operational(rows,args);
  const board=deriveR25Hypotheses(profile);
  const pilot={id:randomUUID(),version:3,phase:'reviewed',
    protocol,target_per_group:60};
  const r24={
    schema:'osmanx.guest.r24.manager-brief.v1',
    pilotId:pilot.id,version:pilot.version,
    evidenceDigest:'a'.repeat(64),
    observedPeriods:4,quality:{analysisStatus:'REVIEW_ONLY'},
    statistics:{controlRatePct:26,offerRatePct:34,differencePp:8,
      interval95Pp:[-2,18]}
  };
  return {rows,profile,board,pilot,r24};
}
test('R25 strict anonymous codes prevent identity, free-text, future, duplicate or impossible counts',()=>{
  const valid=parseR25Tally(row('2026-11-05','morning',3),args);
  assert.deepEqual(Object.keys(valid.counts),R25_CODES);
  for(const malformed of [
    {...valid,fullName:'Guest'},
    {...valid,counts:{...valid.counts,service:99}},
    {...valid,sampled:9},
    {...valid,date:'2026-11-31'},
    {...valid,date:'2026-12-01'},
    {...valid,shift:'night'},
    {...valid,source:'user_text'},
    {...valid,counts:{...valid.counts,contact:'user@example.test'}}
  ])assert.throws(()=>parseR25Tally(malformed,args),RangeError);
  assert.throws(()=>summarizeR25Operational([
    row('2026-11-05','morning',3),row('2026-11-05','morning',4)
  ],args),/duplicate/i);
});
test('R25 4-day early/late time comparison keeps shift proportions and unknowns explicit',()=>{
  const {profile}=fixture();
  assert.equal(profile.schema,R25_PROFILE_SCHEMA);
  assert.equal(profile.recordedDays,4);
  assert.equal(profile.recordedShifts,4);
  assert.equal(profile.totalSampled,80);
  assert.equal(profile.periodComparison.comparable,true);
  assert.equal(profile.categoryShares.wait.observed,21);
  assert.equal(profile.categoryShares.wait.sharePct,26.25);
  assert.equal(profile.periodComparison.changes.wait.earlyPct,15);
  assert.equal(profile.periodComparison.changes.wait.latePct,37.5);
  assert.equal(profile.periodComparison.changes.wait.changePp,22.5);
  assert.equal(profile.customerReportedReasonsVerified,false);
  assert.equal(profile.causalExplanationProven,false);
  assert.ok(profile.warningCodes.includes('STAFF_ESTIMATE_NOT_GUEST_REPORTED'));
});
test('R25 hypotheses prioritize observed categories but demand a new independent test',()=>{
  const {profile,board}=fixture();
  assert.equal(board.schema,'osmanx.guest.r25.hypothesis-board.v1');
  assert.equal(board.leadingHypothesis,'wait');
  assert.ok(board.prioritized.includes('wait'));
  assert.equal(board.hypotheses[0].confidence,'LOW');
  assert.equal(board.observedMotivesEstablished,false);
  assert.equal(board.causalExplanationProven,false);
  assert.equal(board.automaticActionCreated,false);
  assert.ok(board.hypotheses[0].proofBeforeTesting.includes(
    'independent_source_validation'));
  const missing=deriveR25Hypotheses(summarizeR25Operational([],args));
  assert.equal(missing.leadingHypothesis,null);
  assert.equal(missing.prioritized.length,0);
});
test('R25 new registered test is strictly a review-only draft with adequate guardrails',()=>{
  const f=fixture();
  const plan=draftR25Experiment({
    pilot:f.pilot,profile:f.profile,board:f.board,
    r24:f.r24,now
  });
  assert.equal(plan.schema,'osmanx.guest.r25.next-test-draft.v1');
  assert.equal(plan.eligibleForHumanDesignReview,true);
  assert.equal(plan.protocolDraft.primaryOutcome,'repeat_visit');
  assert.equal(plan.protocolDraft.preRegisterBeforeAnyCollection,true);
  assert.equal(plan.protocolDraft.preliminarySamplePerGroup,60);
  assert.equal(plan.protocolDraft.sampleSizeNotPowerValidated,true);
  assert.equal(plan.automaticExperimentStart,false);
  assert.equal(plan.writesEnabled,false);
  assert.equal(plan.customerGo,false);
  assert.ok(plan.protocolDraft.exposureStart>protocol.endDate);
  const stopped=draftR25Experiment({
    pilot:f.pilot,profile:f.profile,board:f.board,
    r24:f.r24,stopActive:true,now
  });
  assert.equal(stopped.protocolDraft,null);
  assert.ok(stopped.blockers.includes('EMERGENCY_HOLD_REQUIRES_REVIEW'));
  const running=draftR25Experiment({
    pilot:{...f.pilot,phase:'running'},profile:f.profile,board:f.board,
    r24:f.r24,now
  });
  assert.ok(running.blockers.includes('EXISTING_PILOT_NOT_FINALIZED'));
});
test('R25 report and aggregate CSV are deterministic, linked to R24 proof and tamper-evident',()=>{
  const f=fixture();
  const opts={pilot:f.pilot,rows:f.rows,r24:f.r24,now};
  const one=makeR25Brief(opts),two=makeR25Brief(opts);
  assert.deepEqual(one,two);
  assert.match(one.sha256,/^[a-f0-9]{64}$/);
  assert.equal(one.recordingAvailable,false);
  assert.equal(one.individualGuestsLinked,false);
  assert.equal(one.causalExplanationProven,false);
  assert.equal(one.customerGo,false);
  assert.equal(verifyR25Brief(one,{
    pilotId:f.pilot.id,r24EvidenceSha:'a'.repeat(64)
  }).valid,true);
  assert.equal(verifyR25Brief({...one,customerGo:true}).valid,false);
  assert.equal(verifyR25Brief({...one,
    profile:{...one.profile,totalSampled:999}}).valid,false);
  assert.equal(verifyR25Brief({...one,guestEmail:'private@example.test'}).valid,false);
  const csv=r25BriefCsv(one);
  assert.ok(csv.startsWith('\uFEFF'));
  assert.ok(csv.includes('wait'));
  assert.ok(csv.includes('SHA-256'));
  assert.equal(csv.includes('private@example.test'),false);
  assert.throws(()=>r25BriefCsv({...one,sha256:'0'.repeat(64)}));
});
test('R25 signed R19 operation parser accepts only POST, exact one-pilot path',()=>{
  const pilot=randomUUID(),path=
    '/api/industry/v1/guest/pilots/'+pilot+'/operational-signals';
  assert.deepEqual(collectionOperation(path,'POST'),{
    pilotId:pilot,kind:'operational-signals'
  });
  assert.equal(collectionOperation(path,'GET'),null);
  assert.equal(collectionOperation(path+'/extra','POST'),null);
  assert.equal(collectionOperation(path.replace(pilot,randomUUID())+'/wrong','POST'),null);
});
