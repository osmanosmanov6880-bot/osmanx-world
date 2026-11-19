/**
 * R36 guest NO-GO tenant status. Does not import external evidence,
 * operator secrets, GitHub approval or local files into the web process.
 */
import {createHash} from 'node:crypto';
import {csv} from '../shared/experiment-model.js';
import {verifyR35Readiness} from './guest-r35-report.mjs';
import {R35_PIN} from './guest-r36-source.mjs';
export const R36_REPORT_SCHEMA='osmanx.guest.r36.human-review-release-readiness.v1';
export const R36_BLOCKERS=Object.freeze([
  'R36_TWENTY_TWO_PRS_NOT_HUMAN_MERGED',
  'R36_FIRST_PENDING_PR_NEEDS_LIVE_REVIEW_AND_HEAD_CI',
  'R36_PR47_PATCH_HUMAN_CODE_AUDIT_REQUIRED',
  'R36_SEMANTIC_STAGING_NOT_INDEPENDENTLY_WITNESSED',
  'R36_ACTUAL_LOCAL_DISPOSABLE_RESTORE_NOT_RUN_IN_API',
  'R36_REAL_OFFSITE_AND_ROLLBACK_WITNESS_MISSING',
  'R36_CLIENT_LEGAL_AUTHORITY_NOT_INDEPENDENTLY_APPROVED',
  'R36_FRESH_MERGED_MAIN_CI_NOT_VERIFIED'
]);
const NOTE='R36: проверки GitHub, содержимого staging и безопасного AGE-восстановления доступны только отдельным операторам. Веб-API не запускает GitHub-изменения, внешние GET, локальные файлы, восстановления, миграции, production или сбор гостевых данных.';
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA=/^[a-f0-9]{64}$/;
const exact=(x,k)=>x&&typeof x==='object'&&!Array.isArray(x)&&
  Object.keys(x).sort().join('|')===k.slice().sort().join('|');
const digest=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
const TOP=['schema','pilotId','version','r35ReportSha','releaseSha',
  'source','review','staging','disasterRecovery','blockers',
  'issuedAt','expiresAt','manualReviewOnly','automaticMergeAllowed',
  'deployAllowed','mainChanged','productionChanged','guestWritesEnabled',
  'customerDataRead','stopLifted','customerGo','productionAuthorized','note'];
export function makeR36Readiness({r35,now=new Date()}={}){
  if(!verifyR35Readiness(r35,{now}).valid)
    throw Error('R36 requires valid existing R35 handoff');
  const expiry=Math.min(Date.parse(r35.expiresAt),now.getTime()+600000);
  if(expiry<=now.getTime())throw Error('R35 handoff expired');
  const body={schema:R36_REPORT_SCHEMA,pilotId:r35.pilotId,
    version:r35.version,r35ReportSha:r35.sha256,
    releaseSha:R35_PIN.sha,
    source:{requiredPrs:22,mergedPrsVerifiedInApi:0,
      mainCiVerifiedInApi:false},
    review:{firstPendingPrCheckedInApi:false,
      independentApprovalsVerifiedInApi:0,
      patchReadInWebApi:false},
    staging:{semanticCanaryAvailable:true,
      networkRequestsFromWebApi:0,
      verifiedDeployedCommit:false},
    disasterRecovery:{explicitLocalRestoreToolAvailable:true,
      actualLocalRestoresInWebApi:0,
      offsiteRestoreVerified:false,productionRollbackPerformed:false},
    blockers:[...new Set([...R36_BLOCKERS,...r35.blockers])],
    issuedAt:now.toISOString(),expiresAt:new Date(expiry).toISOString(),
    manualReviewOnly:true,automaticMergeAllowed:false,deployAllowed:false,
    mainChanged:false,productionChanged:false,guestWritesEnabled:false,
    customerDataRead:false,stopLifted:false,customerGo:false,
    productionAuthorized:false,note:NOTE};
  return {...body,sha256:digest(body)};
}
export function verifyR36Readiness(packet,{pilotId,now=new Date()}={}){
  const errors=[];
  if(!exact(packet,[...TOP,'sha256'])||
    packet?.schema!==R36_REPORT_SCHEMA||
    !UUID.test(packet?.pilotId||'')||
    !SHA.test(packet?.r35ReportSha||'')||
    !SHA.test(packet?.sha256||''))
    errors.push('INVALID_R36_PACKET');
  if(pilotId!==undefined&&packet?.pilotId!==pilotId)
    errors.push('PILOT_MISMATCH');
  const issued=Date.parse(packet?.issuedAt),
    expiry=Date.parse(packet?.expiresAt);
  if(!(now instanceof Date)||!Number.isFinite(now.getTime())||
    !Number.isFinite(issued)||!Number.isFinite(expiry)||
    issued>now.getTime()||now.getTime()>=expiry||
    expiry<=issued||expiry-issued>600000)
    errors.push('INVALID_OR_EXPIRED_REPORT');
  if(packet?.releaseSha!==R35_PIN.sha||
    !exact(packet?.source,['requiredPrs','mergedPrsVerifiedInApi',
      'mainCiVerifiedInApi'])||
    packet.source.requiredPrs!==22||
    packet.source.mergedPrsVerifiedInApi!==0||
    packet.source.mainCiVerifiedInApi!==false)
    errors.push('MAIN_NOT_VERIFIED');
  if(!exact(packet?.review,['firstPendingPrCheckedInApi',
      'independentApprovalsVerifiedInApi','patchReadInWebApi'])||
    packet.review.firstPendingPrCheckedInApi!==false||
    packet.review.independentApprovalsVerifiedInApi!==0||
    packet.review.patchReadInWebApi!==false)
    errors.push('REVIEW_NOT_INDEPENDENTLY_VERIFIED');
  if(!exact(packet?.staging,['semanticCanaryAvailable',
      'networkRequestsFromWebApi','verifiedDeployedCommit'])||
    packet.staging.semanticCanaryAvailable!==true||
    packet.staging.networkRequestsFromWebApi!==0||
    packet.staging.verifiedDeployedCommit!==false)
    errors.push('STAGING_NOT_ATTESTED');
  if(!exact(packet?.disasterRecovery,['explicitLocalRestoreToolAvailable',
      'actualLocalRestoresInWebApi','offsiteRestoreVerified',
      'productionRollbackPerformed'])||
    packet.disasterRecovery.explicitLocalRestoreToolAvailable!==true||
    packet.disasterRecovery.actualLocalRestoresInWebApi!==0||
    packet.disasterRecovery.offsiteRestoreVerified!==false||
    packet.disasterRecovery.productionRollbackPerformed!==false)
    errors.push('REAL_RESTORE_NOT_ATTESTED');
  if(!Array.isArray(packet?.blockers)||packet.blockers.length>200||
    !packet.blockers.every(x=>typeof x==='string'&&x.length<=170)||
    !R36_BLOCKERS.every(x=>packet.blockers.includes(x)))
    errors.push('REQUIRED_BLOCKER_REMOVED');
  for(const k of ['automaticMergeAllowed','deployAllowed','mainChanged',
    'productionChanged','guestWritesEnabled','customerDataRead','stopLifted',
    'customerGo','productionAuthorized'])if(packet?.[k]!==false)
    errors.push('UNAUTHORIZED_PRODUCTION_CLAIM');
  if(packet?.manualReviewOnly!==true||packet?.note!==NOTE)
    errors.push('UNSAFE_REPORT_SCOPE');
  if(exact(packet,[...TOP,'sha256'])){
    const {sha256,...body}=packet;
    if(digest(body)!==sha256)errors.push('REPORT_SHA_MISMATCH');
  }
  return {valid:errors.length===0,errors:[...new Set(errors)],
    productionAuthorized:false,customerGo:false};
}
export function r36ReadinessCsv(packet,{now=new Date()}={}){
  if(!verifyR36Readiness(packet,{now}).valid)
    throw Error('R36 report invalid or expired');
  const rows=[
    ['OSMANX Guest Intelligence R36','NO-GO / independent code and operator acceptance'],
    ['Пилот версия',packet.version],
    ['R35 SHA-256',packet.r35ReportSha],
    ['Pinned source head',packet.releaseSha],
    ['22 pull requests','human merge unverified in API'],
    ['First pending PR','GET-only external GitHub audit required'],
    ['Staging semantic health','operator-only live GET, not performed in API'],
    ['Disposable AGE restore','explicit operator-only on loopback DB'],
    ['Real offsite and rollback','not performed by R36 CI'],
    ['Expires',packet.expiresAt]
  ];
  for(const b of packet.blockers)rows.push(['Блокировка',b]);
  rows.push(['SHA-256',packet.sha256],['Ограничение',packet.note]);
  return csv(rows);
}
