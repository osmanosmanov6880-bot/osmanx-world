/**
 * Signed, data-minimized pilot privacy plan. Does not read contracts or
 * customer records and NEVER asserts actual legal basis was established.
 */
import {R32_PIN} from './guest-r33-source.mjs';
import {r33Hash,r33Timestamp,verifyR33Statements}
  from './guest-r33-signatures.mjs';
export const R33_PRIVACY_SCHEMA='osmanx.guest.r33.minimized-pilot-privacy.v1';
export const R33_PRIVACY_DOMAIN='osmanx.guest.r33.privacy-statement.v1';
export const R33_PRIVACY_ROLES=Object.freeze([
  'client_representative','privacy_reviewer'
]);
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const SHA=/^[a-f0-9]{64}$/;
const SHA40=/^[a-f0-9]{40}$/;
const FIELDS=['schema','tenantId','pilotId','changeId','releaseSha',
  'sourceTreeSha','purpose','retentionDays','source',
  'onlyAggregatedMetrics','noPersonalIdentifiers','noThirdPartyExport',
  'deletionPlanSha','privacyNoticeSha','processorAgreementSha',
  'clientAgreementSha','lawfulBasisAssessmentSha','issuedAt','expiresAt'];
const exact=(o,k)=>o&&typeof o==='object'&&!Array.isArray(o)&&
  Object.keys(o).sort().join('|')===k.slice().sort().join('|');
export function evaluateR33Privacy({packet,receipts,publicKeys={},
  now=new Date()}={}){
  const blockers=[];
  if(!exact(packet,FIELDS)||packet?.schema!==R33_PRIVACY_SCHEMA||
    !UUID.test(packet?.tenantId||'')||
    !UUID.test(packet?.pilotId||'')||
    !UUID.test(packet?.changeId||'')||
    packet?.releaseSha!==R32_PIN.sha||
    !SHA40.test(packet?.sourceTreeSha||'')||
    packet?.purpose!=='guest_experience_aggregate'||
    !Number.isSafeInteger(packet?.retentionDays)||
    packet.retentionDays<1||packet.retentionDays>30||
    packet?.source!=='operator-claimed'||
    packet?.onlyAggregatedMetrics!==true||
    packet?.noPersonalIdentifiers!==true||
    packet?.noThirdPartyExport!==true||
    ![
      packet?.deletionPlanSha,packet?.privacyNoticeSha,
      packet?.processorAgreementSha,packet?.clientAgreementSha,
      packet?.lawfulBasisAssessmentSha
    ].every(x=>SHA.test(x||''))||
    !r33Timestamp(packet?.issuedAt)||
    !r33Timestamp(packet?.expiresAt))
    blockers.push('INVALID_PRIVACY_SCOPE_OR_MINIMIZATION');
  const signed=verifyR33Statements({
    domain:R33_PRIVACY_DOMAIN,payload:packet,
    receipts,publicKeys,roles:R33_PRIVACY_ROLES,
    issuedAt:packet?.issuedAt,expiresAt:packet?.expiresAt,now
  });
  if(!signed.signaturesValid)
    blockers.push('PRIVACY_SIGNATURES_MISSING');
  return {schema:'osmanx.guest.r33.privacy-review.v1',
    metadataAndSignaturesValid:blockers.length===0,
    evidenceSha:blockers.length===0?r33Hash(packet):null,
    policyRetainsOnlyAggregates:packet?.onlyAggregatedMetrics===true,
    maxStatedRetentionDays:30,
    documentHashesOnly:true,documentsContentVerified:false,
    realClientAuthorityVerified:false,lawfulBasisIndependentlyVerified:false,
    customerDataCollected:false,customerGo:false,
    productionAuthorized:false,blockers:[...new Set(blockers)]};
}
