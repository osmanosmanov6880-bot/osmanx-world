/**
 * R29 staging dry-run: deterministic synthetic TWO-origin monitor parity and
 * RLS envelope. No network calls or live customer data; real staging requires
 * a later separate approved on-host read-only probe by an operator.
 */
import {createHash} from 'node:crypto';
import {assessR23Canary} from '../scripts/r23-http-canary.mjs';
export const R29_STAGING_SCHEMA='osmanx.guest.r29.synthetic-staging-rehearsal.v1';
const sha=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
const LOCAL='http://127.0.0.1:8787';
const PUBLIC='https://osmanx.world';
const probes=['live','ready','pilotsPrivate','safetyPrivate','incidentPrivate'];
function monitor(target,{fault=null}={}){
  const observations=Object.fromEntries(probes.map((p,i)=>{
    const status=i<2?200:401;
    const actual=fault===p?status===401?200:503:status;
    return [p,{ok:actual===status,status:actual}];
  }));
  return {schema:'osmanx.guest.r14.monitor.v1',
    target,status:fault?'degraded':'healthy',guestWritesExpected:false,
    ready:!fault,observations};
}
const SCENARIOS=Object.freeze([
  ['private_routes_ok',null,null,true],
  ['unauthorized_route_public','pilotsPrivate',null,false],
  ['readiness_endpoint_fails','ready',null,false],
  ['remote_privacy_break',null,'incidentPrivate',false],
  ['remote_live_fails',null,'live',false],
  ['both_origins_status_mismatch','safetyPrivate',null,false]
]);
export function runR29StagingRehearsal(){
  const cases=SCENARIOS.map(([id,localFault,remoteFault,expected])=>{
    const local=monitor(LOCAL,{fault:localFault});
    const remote=monitor(PUBLIC,{fault:remoteFault});
    const outcome=assessR23Canary(local,remote);
    const result=outcome.technicalCanaryReady;
    return {id,expectedHealthy:expected,observedHealthy:result,
      passed:result===expected,
      probeCount:outcome.probeCount,
      rejectsUnauthorizedRouteLeak:
        id.includes('privacy')||id.includes('unauthorized')?
          result===false:true,
      guestWritesDisabled:true,
      realHostContacted:false,customerDataUsed:false};
  });
  const payload={schema:R29_STAGING_SCHEMA,cases,
    totalCases:cases.length,passedCases:cases.filter(x=>x.passed).length,
    allPassed:cases.every(x=>x.passed),
    actualStagingHostProbed:false,
    realHostContacted:false,productionWrites:false,
    observedClientData:false,changedMain:false,changedProduction:false,
    customerGo:false,productionAuthorized:false,
    note:'Синтетическая репетиция маршрутов R23; не является сетевой проверкой реального staging/VPS.'};
  return {...payload,sha256:sha(payload)};
}
