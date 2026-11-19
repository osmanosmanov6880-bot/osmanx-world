/**
 * External client/legal release scope is an independently signed *claim*.
 * Hashes alone do NOT establish executed contracts or lawful basis.
 */
import {R33_PIN} from './guest-r34-source.mjs';
import {digest34,valid34Time,verifyR34Quorum}
  from './guest-r34-quorum.mjs';
export const R34_CLIENT_SCHEMA='osmanx.guest.r34.client-scope-review.v1';
export const R34_CLIENT_ROLES=Object.freeze([
  'authorized_client','data_protection_reviewer'
]);
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const SHA=/^[a-f0-9]{64}$/;
const SHA40=/^[a-f0-9]{40}$/;
const TOP=['schema','tenantId','pilotId','releaseSha','treeSha',
  'changeId','issuedAt','expiresAt','purpose','dataCategories',
  'retentionDays','aggregatedOnly','personalIdentifiersCollected',
  'thirdPartyExportAllowed','consentOrOtherBasisReviewed',
  'contractSha','processorAgreementSha','privacyNoticeSha',
  'lawfulBasisOpinionSha','deletionProcedureSha',
  'productionCollectionAuthorized'];
const exact=(o,k)=>o&&typeof o==='object'&&!Array.isArray(o)&&
  Object.keys(o).sort().join('|')===k.slice().sort().join('|');
export function evaluateR34ClientScope({packet,statements,
  trustedKeys={},now=new Date()}={}){
  const issues=[];
  if(!exact(packet,TOP)||packet?.schema!==R34_CLIENT_SCHEMA||
    !UUID.test(packet?.tenantId||'')||!UUID.test(packet?.pilotId||'')||
    !UUID.test(packet?.changeId||'')||
    packet?.releaseSha!==R33_PIN.sha||
    !SHA40.test(packet?.treeSha||'')||
    !valid34Time(packet?.issuedAt)||!valid34Time(packet?.expiresAt)||
    packet?.purpose!=='guest_experience_aggregate'||
    !Array.isArray(packet?.dataCategories)||
    packet.dataCategories.length!==1||
    packet.dataCategories[0]!=='aggregate-guest-metrics'||
    !Number.isInteger(packet?.retentionDays)||
    packet.retentionDays<1||packet.retentionDays>30||
    packet.aggregatedOnly!==true||
    packet.personalIdentifiersCollected!==false||
    packet.thirdPartyExportAllowed!==false||
    packet.consentOrOtherBasisReviewed!==true||
    packet.productionCollectionAuthorized!==false||
    ![packet.contractSha,packet.processorAgreementSha,
      packet.privacyNoticeSha,packet.lawfulBasisOpinionSha,
      packet.deletionProcedureSha].every(v=>SHA.test(v||'')))
    issues.push('INVALID_PILOT_LEGAL_SCOPE');
  const signatures=verifyR34Quorum({
    domain:'osmanx.guest.r34.client-authorization.v1',
    payload:packet,statements,roles:R34_CLIENT_ROLES,
    trustedKeys,now});
  if(!signatures.signaturesValid)
    issues.push('INDEPENDENT_CLIENT_REVIEW_MISSING');
  const valid=issues.length===0;
  return {schema:'osmanx.guest.r34.client-review.v1',
    signedScopeMetadataValid:valid,
    scopeSha:valid?digest34(packet):null,
    contractContentVerifiedExternally:false,
    legalBasisVerifiedExternally:false,
    identityOfClientWitnessVerified:false,
    personalDataCollected:false,
    customerGo:false,productionAuthorized:false,
    blockers:[...new Set(issues)]};
}
