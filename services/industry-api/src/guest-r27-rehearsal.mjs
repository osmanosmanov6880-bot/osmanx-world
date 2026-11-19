/**
 * R27 deterministic FULL synthetic first-client intellectual rehearsal:
 * R24 aggregate quality -> statistical interval -> economics -> playbook ->
 * R25 anonymized shift hypotheses -> R26 review -> R27 cross-layer audit.
 * No connection, network, database, user records, environment writes or timers.
 */
import {createHash} from 'node:crypto';
import {inspectR24AggregateQuality} from './guest-r24-quality.mjs';
import {summarizeR24Retention} from './guest-r24-statistics.mjs';
import {modelR24Economics} from './guest-r24-economics.mjs';
import {buildR24Playbook} from './guest-r24-playbook.mjs';
import {createR24Brief} from './guest-r24-brief.mjs';
import {makeR25Brief} from './guest-r25-brief.mjs';
import {makeR26Brief} from './guest-r26-brief.mjs';
import {auditR27Decision} from './guest-r27-decision-audit.mjs';
export const R27_REHEARSAL_SCHEMA='osmanx.guest.r27.synthetic-first-client-rehearsal.v1';
const FIXED_TIME=new Date('2026-11-19T12:00:00.000Z');
const PILOT_ID='11111111-1111-4111-8111-111111111111';
const OWNER='22222222-2222-4222-8222-222222222222';
const MANAGER='33333333-3333-4333-8333-333333333333';
const hash=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
const repeat=(c)=>c.repeat(64);
const days=['2026-10-01','2026-10-02','2026-10-03',
  '2026-10-04','2026-10-05','2026-10-06'];
const EXPECTED=Object.freeze({
  normal:'EXTERNAL_REVIEW_REQUIRED',
  emergency_stop:'SAFETY_HOLD',
  no_operational_signals:'SOURCE_REVIEW_PENDING',
  rejected_internal_review:'SOURCE_REVIEW_PENDING',
  source_mix_shift:'SHIFT_BIAS_REVIEW',
  stale_version_reviews:'SOURCE_REVIEW_PENDING',
  negative_observed_difference:'EXTERNAL_REVIEW_REQUIRED'
});
function syntheticInputs(id){
  const stop=id==='emergency_stop';
  const pilot={
    id:PILOT_ID,version:id==='stale_version_reviews'?5:4,
    phase:'in_review',target_per_group:60,
    plan:{baselinePct:20,liftPp:8,margin:240,discount:12,
      fixed:100,fee:250},
    protocol:{startDate:'2026-10-01',endDate:'2026-10-12',
      outcomeWindowDays:7,allocation:'random',source:'pos',
      primaryMetric:'repeat_visit'},
    protocol_registered_at:'2026-09-29T08:00:00.000Z'
  };
  const obs=days.map((date,i)=>({
    date,control:20,controlReturn:5+(i%2),
    offer:20,offerReturn:id==='negative_observed_difference'?
      3+(i%2):9+(i%2)
  }));
  const tally=id==='no_operational_signals'?[]:days.map((date,i)=>{
    const wait=5+(i%2);
    return {date,shift:['morning','afternoon','evening'][i%3],
      source:id==='source_mix_shift'&&i<3?
        'staff_estimate':'anonymous_counter',
      sampled:20,counts:{
        wait,stockout:3,ordering:2,price:2,service:1,
        unknown:12-wait
      }};
  });
  return {pilot,obs,tally,stop};
}
function buildSyntheticCase(id){
  const {pilot,obs,tally,stop}=syntheticInputs(id);
  const quality=inspectR24AggregateQuality({
    pilot,observations:obs,now:FIXED_TIME});
  const statistics=summarizeR24Retention(quality);
  const economics=modelR24Economics({quality,statistics,plan:pilot.plan});
  const playbook=buildR24Playbook({
    quality,statistics,economics,stopActive:stop});
  const sourceEvidence=hash({
    synthetic:true,pilotId:pilot.id,protocol:pilot.protocol,
    observations:obs
  });
  const r24=createR24Brief({
    pilotId:pilot.id,version:pilot.version,phase:pilot.phase,
    evidenceDigest:sourceEvidence,
    quality,statistics,economics,playbook,stopActive:stop
  });
  const r25=makeR25Brief({
    pilot,rows:tally,r24,hold:stop,now:FIXED_TIME});
  const priorVersion=id==='stale_version_reviews'?
    pilot.version-1:pilot.version;
  const review=(role,actorId,evidenceSha,verdict='reconciled')=>({
    actorId,role,method:'independent_aggregate_recount',verdict,
    pilotVersion:priorVersion,sourceSha:r25.tallySourceSha,
    r24EvidenceSha:r25.r24EvidenceSha,
    tallyRows:tally.length,evidenceSha
  });
  const reviews=tally.length?[
    review('owner',OWNER,repeat('b')),
    review('manager',MANAGER,repeat('c'),
      id==='rejected_internal_review'?'rejected':'reconciled')
  ]:[];
  const r26=makeR26Brief({
    pilot,r25,rows:tally,reviews,stopActive:stop,now:FIXED_TIME});
  return {r24,r25,r26,decision:auditR27Decision({r24,r25,r26})};
}
export function runR27FirstClientRehearsal(){
  const cases=Object.entries(EXPECTED).map(([id,expected])=>{
    try{
      const x=buildSyntheticCase(id),a=x.decision;
      const got=a.state,success=got===expected&&
        a.customerGo===false&&a.productionAuthorized===false&&
        a.causalEffectProven===false&&a.automaticActionTaken===false&&
        x.r24.customerGo===false&&x.r25.customerGo===false&&
        x.r26.customerGo===false&&x.r24.version===x.r26.version;
      return {caseId:id,expectedStage:expected,observedStage:got,
        passed:success,sourceRecordsSynthetic:true,
        checksumIntegrityVerified:true,
        customerGo:false};
    }catch{
      return {caseId:id,expectedStage:expected,
        observedStage:'CASE_ERROR',passed:false,
        sourceRecordsSynthetic:true,checksumIntegrityVerified:false,
        customerGo:false};
    }
  });
  const payload={schema:R27_REHEARSAL_SCHEMA,
    generatedAt:FIXED_TIME.toISOString(),
    cases,passedCases:cases.filter(c=>c.passed).length,
    totalCases:cases.length,
    allPassed:cases.every(c=>c.passed),
    runtimeExternalCalls:0,persistedRecords:0,
    realCustomerDataUsed:false,realInfrastructureTested:false,
    staffIdentitiesUsed:false,customerGo:false,
    productionAuthorized:false,deployAuthorized:false,
    note:'Синтетическая репетиция моделей R24–R27. Она не замещает реальный тест подключения клиента, договор, аудит и внешнее согласование.'
  };
  return {...payload,sha256:hash(payload)};
}
