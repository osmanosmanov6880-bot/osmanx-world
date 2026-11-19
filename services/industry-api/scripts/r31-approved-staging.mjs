/**
 * R31 explicit human-initiated staging GET audit. NEVER called by web API or CI.
 * No arbitrary URLs: fixed loopback and dedicated staging SUBDOMAIN only.
 * No production osmanx.world requests, credentials, bodies, redirects or POST.
 * Even completed HTTP requests are operator-observed, not independently attested.
 */
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {LOCAL,PROBES} from './r14-monitor.mjs';
import {R30_PIN} from '../src/guest-r31-chain.mjs';
import {makeR30ProbeSnapshot,reviewR30ProbeSnapshot}
  from '../src/guest-r30-probe.mjs';
export const R31_STAGING_HOST='https://staging.osmanx.world';
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const targets=Object.freeze([
  {origin:'loopback',base:LOCAL},{origin:'staging',base:R31_STAGING_HOST}
]);
export async function runR31ApprovedStaging({
  approved=false,pilotId,fetcher=fetch,clock=()=>new Date()
}={}){
  if(approved!==true||!UUID.test(pilotId||'')||typeof fetcher!=='function')
    throw new TypeError('Explicit operator approval and pilot UUID required');
  const began=clock();
  if(!(began instanceof Date)||!Number.isFinite(began.getTime()))
    throw new TypeError('Invalid UTC clock');
  const observations=[];
  for(const {origin,base} of targets){
    for(const spec of PROBES){
      let httpStatus=599;
      try{
        // URLs are constructed solely from pinned constant bases and route specs.
        const response=await fetcher(base+spec.path,{
          method:'GET',redirect:'error',credentials:'omit',
          cache:'no-store',headers:{Accept:'application/json'},
          signal:AbortSignal.timeout(5000)
        });
        httpStatus=response.status;
        // Discard response bodies: no diagnostics, errors or customer data.
        try{await response.body?.cancel?.();}catch{httpStatus=599;}
      }catch{httpStatus=599;}
      const observedAt=clock();
      if(!(observedAt instanceof Date)||!Number.isFinite(observedAt.getTime()))
        throw new TypeError('Invalid observation clock');
      observations.push({
        origin,probe:spec.id,method:'GET',httpStatus,
        redirected:false,requestHadCredentials:false,
        responseBodyStored:false,observedAt:observedAt.toISOString()
      });
    }
  }
  const finished=clock();
  const snapshot=makeR30ProbeSnapshot({
    pilotId,releaseCommit:R30_PIN.sha,observations,
    source:'operator-claimed',now:began
  });
  const evaluated=reviewR30ProbeSnapshot(snapshot,{
    pilotId,releaseCommit:R30_PIN.sha,now:finished
  });
  return {
    schema:'osmanx.guest.r31.readonly-staging-attempt.v1',
    snapshot,review:evaluated,networkRequestsAttempted:10,
    externalHostObserved:true,independentWitnessVerified:false,
    realStagingIndependentlyVerified:false,productionAuthorized:false,
    customerGo:false,changedProduction:false,
    note:'Only explicit GET requests to loopback and dedicated staging host. HTTP status is not a signed independent host attestation.'
  };
}
const direct=process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url);
if(direct){
  try{
    if(process.argv.length!==4||
      process.argv[2]!=='--approved-staging'||
      process.env.GUEST_R31_OPERATOR_APPROVAL!=='APPROVED_READ_ONLY_STAGING')
      throw new Error('Require --approved-staging PILOT_UUID and explicit GUEST_R31_OPERATOR_APPROVAL');
    const result=await runR31ApprovedStaging({
      approved:true,pilotId:process.argv[3]
    });
    process.stdout.write(JSON.stringify(result)+'\n');
    if(!result.review.technicalParityPassed)process.exitCode=2;
  }catch(e){
    process.stderr.write('R31 staging probe refused or failed: '+e.message+'\n');
    process.exitCode=2;
  }
}
