/**
 * R30 offline review of a privacy-minimized staging trace. No fetch/network
 * access. Inputs are untrusted observations until independently witnessed;
 * a valid shape and healthy statuses are NOT proof of a real staging host.
 */
import {createHash} from 'node:crypto';
export const R30_PROBE_SCHEMA='osmanx.guest.r30.operator-probe-snapshot.v1';
export const R30_PROBES=Object.freeze([
  'live','ready','pilotsPrivate','safetyPrivate','incidentPrivate'
]);
export const R30_ORIGINS=Object.freeze(['loopback','staging']);
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const SHA=/^[a-f0-9]{64}$/;
const COMMIT=/^[a-f0-9]{40}$/;
const KEYS=['origin','probe','method','httpStatus','redirected',
  'requestHadCredentials','responseBodyStored','observedAt'];
const TOP=['schema','pilotId','releaseCommit','issuedAt','observations',
  'source','guestWritesDisabled'];
const exact=(x,n)=>x&&typeof x==='object'&&!Array.isArray(x)&&
  Object.keys(x).sort().join('|')===n.slice().sort().join('|');
const time=x=>typeof x==='string'&&Number.isFinite(Date.parse(x))&&
  new Date(Date.parse(x)).toISOString()===x;
export const r30Digest=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
export function makeR30ProbeSnapshot({pilotId,releaseCommit,observations,
  source='synthetic',now=new Date()}={}){
  if(!['synthetic','operator-claimed'].includes(source))
    throw new TypeError('Explicit source classification required');
  const body={schema:R30_PROBE_SCHEMA,pilotId,releaseCommit,
    issuedAt:now.toISOString(),observations,source,guestWritesDisabled:true};
  return {...body,sha256:r30Digest(body)};
}
export function reviewR30ProbeSnapshot(snapshot,{pilotId,releaseCommit,
  now=new Date()}={}){
  const blockers=[];
  if(!exact(snapshot,[...TOP,'sha256'])||
    snapshot.schema!==R30_PROBE_SCHEMA||
    !UUID.test(snapshot.pilotId||'')||
    !COMMIT.test(snapshot.releaseCommit||'')||
    !SHA.test(snapshot.sha256||'')||
    !time(snapshot.issuedAt)||
    !['synthetic','operator-claimed'].includes(snapshot.source)||
    snapshot.guestWritesDisabled!==true)
    blockers.push('INVALID_SNAPSHOT_ENVELOPE');
  if(pilotId!==undefined&&snapshot?.pilotId!==pilotId)
    blockers.push('PILOT_MISMATCH');
  if(releaseCommit!==undefined&&snapshot?.releaseCommit!==releaseCommit)
    blockers.push('RELEASE_MISMATCH');
  const issued=Date.parse(snapshot?.issuedAt);
  if(!(now instanceof Date)||!Number.isFinite(now.getTime())||
    !Number.isFinite(issued)||issued>now.getTime()||
    now.getTime()-issued>10*60000)blockers.push('STALE_OR_FUTURE_PROBE');
  const items=Array.isArray(snapshot?.observations)?snapshot.observations:[];
  if(items.length!==10)blockers.push('EXPECTED_TEN_PROBES');
  const found=new Set();
  for(const o of items.slice(0,20)){
    if(!exact(o,KEYS)||!R30_ORIGINS.includes(o.origin)||
      !R30_PROBES.includes(o.probe)||o.method!=='GET'||
      !Number.isInteger(o.httpStatus)||o.httpStatus<100||
      o.httpStatus>599||o.redirected!==false||
      o.requestHadCredentials!==false||o.responseBodyStored!==false||
      !time(o.observedAt)||Date.parse(o.observedAt)>now.getTime()||
      Date.parse(o.observedAt)<issued||
      Date.parse(o.observedAt)-issued>10*60000){
      blockers.push('UNSAFE_OR_MALFORMED_OBSERVATION');continue;
    }
    const id=o.origin+':'+o.probe;
    if(found.has(id))blockers.push('DUPLICATE_PROBE');
    found.add(id);
    const expected=['live','ready'].includes(o.probe)?200:401;
    if(o.httpStatus!==expected)
      blockers.push('STATUS_OR_PRIVACY_FAILURE_'+id);
  }
  if(found.size!==10)blockers.push('INCOMPLETE_OR_DUPLICATE_OBSERVATIONS');
  try{
    if(exact(snapshot,[...TOP,'sha256'])){
      const {sha256,...body}=snapshot;
      if(r30Digest(body)!==sha256)blockers.push('TAMPERED_SNAPSHOT');
    }
  }catch{blockers.push('INVALID_DIGEST_INPUT');}
  return {
    schema:'osmanx.guest.r30.probe-review.v1',
    observationsAccepted:found.size,
    technicalParityPassed:blockers.length===0,
    evidenceSha:SHA.test(snapshot?.sha256||'')?snapshot.sha256:null,
    isSynthetic:snapshot?.source==='synthetic',
    realHostVerified:false,independentWitnessVerified:false,
    guestWritesEnabled:false,changedProduction:false,
    blockers:[...new Set(blockers)],customerGo:false,
    productionAuthorized:false
  };
}
