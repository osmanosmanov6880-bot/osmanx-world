import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {inspectR24AggregateQuality} from '../src/guest-r24-quality.mjs';
import {summarizeR24Retention} from '../src/guest-r24-statistics.mjs';
import {modelR24Economics} from '../src/guest-r24-economics.mjs';
import {buildR24Playbook} from '../src/guest-r24-playbook.mjs';
import {createR24Brief,verifyR24Brief,r24BriefCsv}
  from '../src/guest-r24-brief.mjs';

function fixture(){
  const pilot={id:randomUUID(),version:3,phase:'in_review',
    target_per_group:50,
    plan:{baselinePct:20,liftPp:10,margin:250,discount:15,
      fixed:500,fee:300},
    protocol:{startDate:'2026-11-01',endDate:'2026-11-05',
      outcomeWindowDays:7,allocation:'random',source:'pos',
      primaryMetric:'repeat_visit'},
    protocol_registered_at:'2026-10-30T00:00:00.000Z'};
  const observations=[
    {date:'2026-11-01',control:50,controlReturn:15,offer:50,offerReturn:22},
    {date:'2026-11-03',control:50,controlReturn:14,offer:50,offerReturn:25}
  ];
  const now=new Date('2026-11-20T00:00:00.000Z');
  const quality=()=>inspectR24AggregateQuality({pilot,observations,now});
  return {pilot,observations,now,quality};
}
function all(f,stopActive=false){
  const quality=f.quality();
  const statistics=summarizeR24Retention(quality);
  const economics=modelR24Economics({
    plan:f.pilot.plan,quality,statistics
  });
  const playbook=buildR24Playbook({
    quality,statistics,economics,stopActive
  });
  return {quality,statistics,economics,playbook};
}
test('R24 quality validates bounded cohorts, dates and prespecified study window',()=>{
  const f=fixture(),q=f.quality();
  assert.equal(q.schema,'osmanx.guest.r24.aggregate-quality.v1');
  assert.deepEqual(q.totals,{
    control:100,controlReturn:29,offer:100,offerReturn:47
  });
  assert.equal(q.protocolValid,true);
  assert.equal(q.outcomeWindowCompleted,true);
  assert.equal(q.sampleEnough,true);
  assert.equal(q.blocking,false);
  assert.equal(q.analysisStatus,'REVIEW_ONLY');
  assert.equal(q.issues.length,0);
  const invalid={...f.observations[1],controlReturn:999};
  assert.throws(()=>inspectR24AggregateQuality({
    pilot:f.pilot,observations:[f.observations[0],invalid],now:f.now
  }));
  assert.throws(()=>inspectR24AggregateQuality({
    pilot:f.pilot,observations:[f.observations[0],f.observations[0]],now:f.now
  }));
});
test('R24 flags invalid collection protocol, missing periods, oversubscribed groups and incomplete outcome',()=>{
  const f=fixture();
  const q=inspectR24AggregateQuality({
    pilot:{...f.pilot,protocol:{...f.pilot.protocol,allocation:'matched',source:'manual'}},
    observations:[{date:'2026-12-01',
      control:10,controlReturn:3,offer:50,offerReturn:8}],
    now:new Date('2026-11-04T00:00:00.000Z')
  });
  const codes=q.issues.map(x=>x.code);
  for(const code of ['OBSERVATION_IN_FUTURE','OBSERVATION_OUTSIDE_PROTOCOL',
    'UNBALANCED_PERIOD_GROUPS','TARGET_SAMPLE_NOT_REACHED',
    'NON_RANDOM_ASSIGNMENT','MANUAL_AGGREGATE_SOURCE',
    'OUTCOME_WINDOW_NOT_COMPLETED'])
    assert.ok(codes.includes(code),code);
  assert.equal(q.blocking,true);
  assert.equal(q.analysisStatus,'BLOCKED');
  const empty=inspectR24AggregateQuality({
    pilot:f.pilot,observations:[],now:f.now
  });
  assert.equal(empty.blocking,true);
  assert.equal(empty.periodCount,0);
  assert.ok(empty.issues.some(x=>x.code==='NO_OBSERVATIONS'));
});
test('R24 Newcombe/Wilson interval is bounded and explicitly not a causal estimate',()=>{
  const f=fixture(),{statistics:s}=all(f);
  assert.equal(s.schema,'osmanx.guest.r24.statistical-summary.v1');
  assert.equal(s.controlRatePct,29);
  assert.equal(s.offerRatePct,47);
  assert.equal(s.differencePp,18);
  assert.ok(s.interval95Pp[0]<=18&&s.interval95Pp[1]>=18);
  assert.equal(s.observationalOnly,true);
  assert.equal(s.noGuaranteedLift,true);
  assert.equal(s.claim,'no_causal_inference');
  const q=inspectR24AggregateQuality({pilot:f.pilot,
    observations:[],now:f.now});
  const noData=summarizeR24Retention(q);
  assert.equal(noData.state,'NO_DATA');
  assert.equal(noData.interval95Pp,null);
  assert.equal(noData.differencePp,null);
});
test('R24 scenario economics preserves real costs and admits a negative downside',()=>{
  const f=fixture(),{quality,statistics,economics:e}=all(f);
  assert.equal(e.schema,'osmanx.guest.r24.scenario-economics.v1');
  assert.equal(e.state,'SCENARIO_ONLY');
  assert.equal(e.costAssumptionsRub.modeledTotal,2300);
  assert.equal(e.breakEvenDifferencePp,9.2);
  assert.equal(e.observedDifferenceScenarioRub,2200);
  assert.equal(e.realizedRevenueKnown,false);
  assert.equal(e.causalProfitProven,false);
  assert.equal(e.scenarioOnly,true);
  const missing=modelR24Economics({plan:{},quality,statistics});
  assert.equal(missing.state,'INVALID_COST_ASSUMPTIONS');
  assert.equal(missing.observedDifferenceScenarioRub,null);
  const zero=modelR24Economics({
    plan:{...f.pilot.plan,margin:0},quality,statistics
  });
  assert.equal(zero.breakEvenDifferencePp,null);
  assert.ok(zero.risks.includes('ZERO_MARGIN'));
});
test('R24 evidence-first playbook prioritizes source, sample and independent review without making actions',()=>{
  const f=fixture(),{playbook:p}=all(f);
  assert.equal(p.schema,'osmanx.guest.r24.playbook.v1');
  assert.equal(p.automaticallyAssigned,false);
  assert.equal(p.automaticallyExecuted,false);
  assert.equal(p.approvedByOwner,false);
  assert.equal(p.causalClaimMade,false);
  assert.ok(p.actions.length>0);
  assert.ok(p.actions.every(x=>x.evidence.length>10&&
    x.role==='owner_or_manager'&&x.actionCreated===false));
  const stopped=all(f,true).playbook;
  assert.equal(stopped.leadAction,'REVIEW_SAFETY_STOP');
  assert.equal(stopped.furtherCollectionRecommended,false);
});
test('R24 manager evidence rejects unauthorized claims, changed stats, and guards CSV formulas',()=>{
  const f=fixture(),{quality,statistics,economics,playbook}=all(f);
  const x=createR24Brief({
    pilotId:f.pilot.id,version:f.pilot.version,phase:f.pilot.phase,
    evidenceDigest:'a'.repeat(64),
    quality,statistics,economics,playbook
  });
  assert.equal(x.schema,'osmanx.guest.r24.manager-brief.v1');
  assert.equal(x.signed,false);
  assert.equal(x.guestIdentifiersIncluded,false);
  assert.equal(x.causalEffectProven,false);
  assert.equal(x.customerGo,false);
  assert.equal(verifyR24Brief(x,{
    pilotId:f.pilot.id,evidenceDigest:'a'.repeat(64)
  }).valid,true);
  assert.equal(verifyR24Brief({...x,customerGo:true}).valid,false);
  assert.equal(verifyR24Brief({...x,
    statistics:{...x.statistics,differencePp:99}}).valid,false);
  assert.equal(verifyR24Brief({...x,
    extraGuestEmail:'private@example.test'}).valid,false);
  const csv=r24BriefCsv(x);
  assert.ok(csv.startsWith('\uFEFF'));
  assert.ok(csv.includes('95% интервал'));
  assert.ok(csv.includes('SHA-256'));
  assert.ok(!csv.includes('private@example.test'));
  assert.throws(()=>r24BriefCsv({...x,sha256:'f'.repeat(64)}));
});
