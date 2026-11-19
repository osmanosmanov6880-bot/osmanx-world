/**
 * Two role-signed, two-sample staging metadata review. Host TLS and DNS
 * digests are operator assertions; this module performs NO networking.
 */
import {reviewR30ProbeSnapshot} from './guest-r30-probe.mjs';
import {R32_PIN} from './guest-r33-source.mjs';
import {r33Hash,r33Timestamp,verifyR33Statements}
  from './guest-r33-signatures.mjs';
export const R33_STAGE_SCHEMA='osmanx.guest.r33.signed-staging-evidence.v1';
export const R33_STAGE_DOMAIN='osmanx.guest.r33.stage-statement.v1';
export const R33_STAGE_ROLES=Object.freeze([
  'staging_operator','security_reviewer'
]);
const SHA=/^[a-f0-9]{64}$/;
const SHA40=/^[a-f0-9]{40}$/;
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const FIELDS=['schema','tenantId','pilotId','releaseSha','sourceTreeSha',
  'origin','tlsCertSha256','dnsAnswerSha256','first','second',
  'issuedAt','expiresAt'];
const exact=(x,keys)=>x&&typeof x==='object'&&!Array.isArray(x)&&
  Object.keys(x).sort().join('|')===keys.slice().sort().join('|');
export function evaluateR33Staging({packet,receipts,publicKeys={},
  now=new Date()}={}){
  const blockers=[];
  if(!exact(packet,FIELDS)||packet?.schema!==R33_STAGE_SCHEMA||
    !UUID.test(packet?.tenantId||'')||!UUID.test(packet?.pilotId||'')||
    packet?.releaseSha!==R32_PIN.sha||
    !SHA40.test(packet?.sourceTreeSha||'')||
    packet?.origin!=='https://staging.osmanx.world'||
    !SHA.test(packet?.tlsCertSha256||'')||
    !SHA.test(packet?.dnsAnswerSha256||'')||
    !r33Timestamp(packet?.issuedAt)||!r33Timestamp(packet?.expiresAt))
    blockers.push('INVALID_STAGING_ENVELOPE');
  const a=reviewR30ProbeSnapshot(packet?.first,{
    pilotId:packet?.pilotId,releaseCommit:R32_PIN.sha,now});
  const b=reviewR30ProbeSnapshot(packet?.second,{
    pilotId:packet?.pilotId,releaseCommit:R32_PIN.sha,now});
  if(!a.technicalParityPassed||!b.technicalParityPassed)
    blockers.push('BAD_HTTP_PRIVACY_PARITY');
  if(packet?.first?.source!=='operator-claimed'||
    packet?.second?.source!=='operator-claimed')
    blockers.push('SYNTHETIC_OBSERVATIONS_NOT_ACCEPTED');
  const ta=Date.parse(packet?.first?.issuedAt),
    tb=Date.parse(packet?.second?.issuedAt),
    issued=Date.parse(packet?.issuedAt),expires=Date.parse(packet?.expiresAt);
  if(!Number.isFinite(ta)||!Number.isFinite(tb)||!Number.isFinite(issued)||
    !Number.isFinite(expires)||tb-ta<30000||tb-ta>600000||
    issued>ta||tb>expires||
    !a.evidenceSha||a.evidenceSha===b.evidenceSha)
    blockers.push('REPLAY_OR_INVALID_STAGING_TIME');
  if(packet?.first?.pilotId!==packet?.second?.pilotId||
    packet?.first?.releaseCommit!==packet?.second?.releaseCommit)
    blockers.push('STAGING_RELEASE_OR_PILOT_DRIFT');
  const one=Array.isArray(packet?.first?.observations)?
    packet.first.observations:[];
  const two=Array.isArray(packet?.second?.observations)?
    packet.second.observations:[];
  const statuses=new Map(one.map(x=>[x?.origin+':'+x?.probe,x?.httpStatus]));
  if(one.length!==10||two.length!==10||
    two.some(x=>statuses.get(x?.origin+':'+x?.probe)!==x?.httpStatus))
    blockers.push('HTTP_STATUS_DRIFT');
  const signing=verifyR33Statements({
    domain:R33_STAGE_DOMAIN,payload:packet,receipts,
    roles:R33_STAGE_ROLES,publicKeys,
    issuedAt:packet?.issuedAt,expiresAt:packet?.expiresAt,now});
  if(!signing.signaturesValid)blockers.push('STAGING_SIGNATURES_INVALID');
  const metadataReady=blockers.length===0;
  return {schema:'osmanx.guest.r33.staging-review.v1',
    tenantId:UUID.test(packet?.tenantId||'')?packet.tenantId:null,
    pilotId:UUID.test(packet?.pilotId||'')?packet.pilotId:null,
    metadataSha:metadataReady?r33Hash(packet):null,
    observationsExpected:20,pairedProbesHealthy:metadataReady,
    witnessesSigned:signing.signaturesValid,
    certificateFingerprintClaimOnly:true,dnsAnswerClaimOnly:true,
    actualTlsHandshakeVerified:false,actualDnsIndependentlyVerified:false,
    realStagingIndependentlyVerified:false,
    independentSignersRealWorldIdentityVerified:false,
    customerGo:false,productionAuthorized:false,
    blockers:[...new Set(blockers)]};
}
