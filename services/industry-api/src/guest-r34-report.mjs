/**
 * R34 tenant-safe read-only acceptance status. Web API never accepts or
 * imports actual host, DR, privacy evidence or public/private signing keys.
 */
import {createHash} from 'node:crypto';
import {csv} from '../shared/experiment-model.js';
import {verifyR33Readiness} from './guest-r33-report.mjs';
import {R33_PIN} from './guest-r34-source.mjs';
export const R34_REPORT_SCHEMA='osmanx.guest.r34.operator-release-review.v1';
export const R34_BLOCKERS=Object.freeze([
  'R34_TWENTY_PRS_REQUIRE_HUMAN_REVIEW',
  'R34_POST_MERGE_MAIN_CI_REQUIRED',
  'R34_APPROVED_STAGING_NETWORK_OBSERVATION_PENDING',
  'R34_INDEPENDENT_HOST_WITNESS_REQUIRED',
  'R34_REAL_OFFSITE_CUSTODY_AND_RESTORE_PENDING',
  'R34_ACTUAL_ROLLBACK_DRILL_NOT_PERFORMED',
  'R34_CLIENT_AND_LEGAL_AUTHORITY_NOT_VERIFIED',
  'R34_OPERATOR_CHANGE_WINDOW_NOT_APPROVED'
]);
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const SHA=/^[a-f0-9]{64}$/;
const exact=(o,k)=>o&&typeof o==='object'&&!Array.isArray(o)&&
  Object.keys(o).sort().join('|')===k.slice().sort().join('|');
const hash=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
const NOTE='R34: разрешённая операторская проверка staging, проверка двух копий восстановления и договорных разрешений требуют независимого исполнения. CI и подписи метаданных не дают права включить production.';
const FIELDS=['schema','pilotId','version','r33PacketSha','r32PacketSha',
  'releaseSha','source','staging','disasterRecovery','clientScope',
  'blockers','issuedAt','expiresAt','manualReviewOnly',
  'automaticMergeAllowed','deployAllowed','mainChanged','productionChanged',
  'guestWritesEnabled','customerDataRead','stopLifted','customerGo',
  'productionAuthorized','note'];
export function makeR34Readiness({r33,now=new Date()}={}){
  if(!verifyR33Readiness(r33,{now}).valid)
    throw new TypeError('R34 needs current valid R33 packet');
  const until=Math.min(Date.parse(r33.expiresAt),now.getTime()+600000);
  if(until<=now.getTime())throw new TypeError('R33 expired');
  const payload={
    schema:R34_REPORT_SCHEMA,pilotId:r33.pilotId,version:r33.version,
    r33PacketSha:r33.sha256,r32PacketSha:r33.r32ReportSha,
    releaseSha:R33_PIN.sha,
    source:{requiredPrs:20,verifiedInWebApi:0,
      postMergeMainCiVerified:false},
    staging:{operatorTlsDnsToolAvailable:true,
      realHttpsRequestsMadeByWebApi:0,
      liveHostIndependentlyVerified:false},
    disasterRecovery:{twoSignedCopiesRequired:true,
      actualExternalRestoresVerified:false,
      realProductionRollbackExecuted:false},
    clientScope:{independentSignersRequired:2,
      legalDocumentsReadByWebApi:false,authorityVerified:false,
      customerDataRead:false},
    blockers:[...new Set([...R34_BLOCKERS,...r33.blockers])],
    issuedAt:now.toISOString(),expiresAt:new Date(until).toISOString(),
    manualReviewOnly:true,automaticMergeAllowed:false,
    deployAllowed:false,mainChanged:false,productionChanged:false,
    guestWritesEnabled:false,customerDataRead:false,stopLifted:false,
    customerGo:false,productionAuthorized:false,note:NOTE
  };
  return {...payload,sha256:hash(payload)};
}
export function verifyR34Readiness(packet,{pilotId,now=new Date()}={}){
  const issues=[];
  if(!exact(packet,[...FIELDS,'sha256'])||
    packet?.schema!==R34_REPORT_SCHEMA||
    !UUID.test(packet?.pilotId||'')||
    !SHA.test(packet?.sha256||'')||
    !SHA.test(packet?.r33PacketSha||'')||
    !SHA.test(packet?.r32PacketSha||''))
    issues.push('BAD_R34_PACKET');
  if(pilotId!==undefined&&packet?.pilotId!==pilotId)
    issues.push('CROSS_PILOT_PACKET');
  const issued=Date.parse(packet?.issuedAt),
    expires=Date.parse(packet?.expiresAt);
  if(!(now instanceof Date)||!Number.isFinite(now.getTime())||
    !Number.isFinite(issued)||!Number.isFinite(expires)||
    issued>now.getTime()||now.getTime()>=expires||
    expires<=issued||expires-issued>600000)
    issues.push('EXPIRED_OR_INVALID_CLOCK');
  if(packet?.releaseSha!==R33_PIN.sha||
    !exact(packet?.source,['requiredPrs','verifiedInWebApi',
      'postMergeMainCiVerified'])||
    packet.source.requiredPrs!==20||
    packet.source.verifiedInWebApi!==0||
    packet.source.postMergeMainCiVerified!==false)
    issues.push('SOURCE_NOT_INDEPENDENTLY_VERIFIED');
  if(!exact(packet?.staging,['operatorTlsDnsToolAvailable',
    'realHttpsRequestsMadeByWebApi','liveHostIndependentlyVerified'])||
    packet.staging.operatorTlsDnsToolAvailable!==true||
    packet.staging.realHttpsRequestsMadeByWebApi!==0||
    packet.staging.liveHostIndependentlyVerified!==false)
    issues.push('LIVE_HOST_NOT_ATTESTED');
  if(!exact(packet?.disasterRecovery,['twoSignedCopiesRequired',
    'actualExternalRestoresVerified','realProductionRollbackExecuted'])||
    packet.disasterRecovery.twoSignedCopiesRequired!==true||
    packet.disasterRecovery.actualExternalRestoresVerified!==false||
    packet.disasterRecovery.realProductionRollbackExecuted!==false)
    issues.push('DISASTER_RECOVERY_NOT_ATTESTED');
  if(!exact(packet?.clientScope,['independentSignersRequired',
    'legalDocumentsReadByWebApi','authorityVerified','customerDataRead'])||
    packet.clientScope.independentSignersRequired!==2||
    packet.clientScope.legalDocumentsReadByWebApi!==false||
    packet.clientScope.authorityVerified!==false||
    packet.clientScope.customerDataRead!==false)
    issues.push('CLIENT_APPROVAL_NOT_ATTESTED');
  if(!Array.isArray(packet?.blockers)||packet.blockers.length>160||
    !packet.blockers.every(x=>typeof x==='string'&&x.length<=160)||
    !R34_BLOCKERS.every(x=>packet.blockers.includes(x)))
    issues.push('MANDATORY_BLOCKERS_MISSING');
  for(const key of ['automaticMergeAllowed','deployAllowed','mainChanged',
    'productionChanged','guestWritesEnabled','customerDataRead','stopLifted',
    'customerGo','productionAuthorized'])
    if(packet?.[key]!==false)issues.push('UNAUTHORIZED_GO_CLAIM');
  if(packet?.manualReviewOnly!==true||packet?.note!==NOTE)
    issues.push('UNSAFE_PACKET_SCOPE');
  if(exact(packet,[...FIELDS,'sha256'])){
    const {sha256,...body}=packet;
    if(hash(body)!==sha256)issues.push('TAMPERED_R34_PACKET');
  }
  return {valid:issues.length===0,errors:[...new Set(issues)],
    customerGo:false,productionAuthorized:false};
}
export function r34ReadinessCsv(packet,{now=new Date()}={}){
  if(!verifyR34Readiness(packet,{now}).valid)
    throw new TypeError('R34 packet not valid or expired');
  const rows=[
    ['OSMANX Guest R34','NO-GO / independent operator release review'],
    ['Пилот версия',packet.version],
    ['R33 packet SHA-256',packet.r33PacketSha],
    ['Source commit',packet.releaseSha],
    ['PR source reviews','0 / 20 in web API'],
    ['Actual staging TLS/DNS','operator-only, not web API'],
    ['Independent offsite restore','not yet independently verified'],
    ['Client documents/legal','not yet independently verified'],
    ['Report expires',packet.expiresAt]
  ];
  for(const x of packet.blockers)rows.push(['Блокировка',x]);
  rows.push(['SHA-256',packet.sha256],['Ограничение',packet.note]);
  return csv(rows);
}
