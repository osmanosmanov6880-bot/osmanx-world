/**
 * Two distinct bounded staging GET snapshots reduce transient false positives.
 * Both are operator claims until their actual host is independently witnessed.
 * No fetch, sockets or client data, no authorization to deploy.
 */
import {reviewR30ProbeSnapshot} from './guest-r30-probe.mjs';
import {R31_PIN} from './guest-r32-source.mjs';
export const R32_DRIFT_SCHEMA='osmanx.guest.r32.staging-drift-review.v1';
export function evaluateR32StagingDrift({first,second,pilotId,
  now=new Date()}={}){
  const blockers=[];
  const a=reviewR30ProbeSnapshot(first,{pilotId,
    releaseCommit:R31_PIN.sha,now});
  const b=reviewR30ProbeSnapshot(second,{pilotId,
    releaseCommit:R31_PIN.sha,now});
  if(!a.technicalParityPassed||!b.technicalParityPassed)
    blockers.push('ONE_OR_BOTH_PROBE_SNAPSHOTS_FAILED');
  if(first?.source!=='operator-claimed'||
    second?.source!=='operator-claimed')
    blockers.push('SYNTHETIC_ORIGIN_NOT_ACCEPTED');
  const ta=Date.parse(first?.issuedAt),tb=Date.parse(second?.issuedAt);
  if(!Number.isFinite(ta)||!Number.isFinite(tb)||
    tb-ta<30000||tb-ta>10*60000)
    blockers.push('DISTINCT_SAMPLES_30S_TO_10M_REQUIRED');
  if(!first?.sha256||first.sha256===second?.sha256)
    blockers.push('REPLAYED_SAMPLE_DIGEST');
  if(first?.pilotId!==second?.pilotId||
    first?.releaseCommit!==second?.releaseCommit)
    blockers.push('SCOPE_CHANGED_BETWEEN_SAMPLES');
  const one=Array.isArray(first?.observations)?first.observations:[];
  const two=Array.isArray(second?.observations)?second.observations:[];
  if(one.length!==10||two.length!==10)
    blockers.push('INCOMPLETE_SAMPLE');
  // Both snapshots already enforce exact GET route identities and status 200/401.
  // Independent source timing is still an operator claim.
  const map=new Map(one.filter(x=>x&&typeof x==='object').map(
    x=>[x.origin+':'+x.probe,x.httpStatus]));
  if(two.some(x=>!x||map.get(x.origin+':'+x.probe)!==x.httpStatus))
    blockers.push('HTTP_STATUS_DRIFT');
  return {schema:R32_DRIFT_SCHEMA,pilotId:pilotId||null,
    sampleCount:2,observationsExpected:20,
    firstSha:a.evidenceSha,secondSha:b.evidenceSha,
    technicalParityStable:blockers.length===0,
    operatorClaimOnly:true,realStagingIndependentlyVerified:false,
    freshMainCiVerified:false,productionAuthorized:false,
    customerGo:false,changedProduction:false,
    blockers:[...new Set(blockers)]};
}
