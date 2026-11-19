/**
 * Tenant-scoped short-lived R32 review packet: 18 PRs, explicit two-person
 * window, dual staging sampling and RTO/RPO. The API never imports offline
 * operator claims, keys, tokens or customer data; production stays NO-GO.
 */
import {createHash} from 'node:crypto';
import {csv} from '../shared/experiment-model.js';
import {verifyR31OperatorReport} from './guest-r31-report.mjs';
import {R31_PIN} from './guest-r32-source.mjs';
export const R32_REPORT_SCHEMA='osmanx.guest.r32.manual-release-readiness.v1';
const SHA=/^[a-f0-9]{64}$/;
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const hash=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
const exact=(x,keys)=>x&&typeof x==='object'&&!Array.isArray(x)&&
  Object.keys(x).sort().join('|')===keys.slice().sort().join('|');
export const R32_BLOCKERS=Object.freeze([
  'R32_EIGHTEEN_PRS_NEED_HUMAN_REVIEW',
  'R32_SIGNED_CHANGE_WINDOW_NOT_VERIFIED',
  'R32_TWO_REAL_STAGING_SAMPLES_NOT_OBSERVED',
  'R32_RECOVERY_RTO_RPO_NOT_INDEPENDENTLY_ATTESTED',
  'R32_REAL_OFFSITE_AND_ROLLBACK_EVIDENCE_MISSING',
  'R32_CLIENT_CONTRACT_AND_LAWFUL_BASIS_UNVERIFIED',
  'R32_FRESH_POST_MERGE_MAIN_CI_MISSING'
]);
const KEYS=['schema','pilotId','version','r31ReportSha','r30PacketSha',
  'releaseSha','sourcePrsRequired','sourcePrsVerifiedInApi','sourceReview',
  'staging','changeWindow','recovery','blockers',
  'issuedAt','expiresAt','manualReviewOnly','guestWritesEnabled',
  'stopLifted','mainChanged','productionAuthorized','customerGo',
  'customerRecordsRead','deployAllowed','automaticMergeAllowed','note'];
const NOTE='R32: подписанное окно, 2 staging-снимка и RTO/RPO проверяются независимым офлайн-оператором. API не собирает внешние доказательства, не проводит деплой и не разрешает коммерческий запуск.';
export function makeR32Readiness({r31,now=new Date()}={}){
  if(!verifyR31OperatorReport(r31,{now}).valid)
    throw new TypeError('R32 requires unexpired R31 handoff');
  const expires=Math.min(Date.parse(r31.expiresAt),now.getTime()+600000);
  if(expires<=now.getTime())throw new TypeError('R31 handoff expired');
  const payload={
    schema:R32_REPORT_SCHEMA,pilotId:r31.pilotId,version:r31.version,
    r31ReportSha:r31.sha256,r30PacketSha:r31.r30PacketSha,
    releaseSha:R31_PIN.sha,sourcePrsRequired:18,sourcePrsVerifiedInApi:0,
    sourceReview:{freshMainCiVerified:false,
      humanMergedCountVerifiedInApi:0,independentCodeReviewVerified:false},
    staging:{samplesRequired:2,realSamplesVerifiedInApi:0,
      networkCallsPerformedInApi:0,syntheticEvidenceIsNotLive:true},
    changeWindow:{distinctApproversRequired:2,verifiedInApi:0,
      stagingOnly:true,allowProduction:false},
    recovery:{independentCopiesRequired:2,
      rtoRpoIndependentlyWitnessed:false,actualOffsiteCustodyVerified:false},
    blockers:[...new Set([...R32_BLOCKERS,...r31.blockers])],
    issuedAt:now.toISOString(),expiresAt:new Date(expires).toISOString(),
    manualReviewOnly:true,guestWritesEnabled:false,stopLifted:false,
    mainChanged:false,productionAuthorized:false,customerGo:false,
    customerRecordsRead:false,deployAllowed:false,
    automaticMergeAllowed:false,note:NOTE
  };
  return {...payload,sha256:hash(payload)};
}
export function verifyR32Readiness(r,{pilotId,now=new Date()}={}){
  const issues=[];
  if(!exact(r,[...KEYS,'sha256'])||r?.schema!==R32_REPORT_SCHEMA||
    !UUID.test(r?.pilotId||'')||!SHA.test(r?.r31ReportSha||'')||
    !SHA.test(r?.r30PacketSha||'')||!SHA.test(r?.sha256||''))
    issues.push('BAD_REPORT_SHAPE');
  if(pilotId!==undefined&&r?.pilotId!==pilotId)
    issues.push('PILOT_MISMATCH');
  const issued=Date.parse(r?.issuedAt),expiry=Date.parse(r?.expiresAt);
  if(!(now instanceof Date)||!Number.isFinite(now.getTime())||
    !Number.isFinite(issued)||!Number.isFinite(expiry)||
    now.getTime()<issued||now.getTime()>=expiry||
    expiry<=issued||expiry-issued>600000)
    issues.push('STALE_OR_INVALID_REPORT_CLOCK');
  if(r?.releaseSha!==R31_PIN.sha||r?.sourcePrsRequired!==18||
    r?.sourcePrsVerifiedInApi!==0||
    !exact(r?.sourceReview,['freshMainCiVerified',
      'humanMergedCountVerifiedInApi','independentCodeReviewVerified'])||
    r.sourceReview.freshMainCiVerified!==false||
    r.sourceReview.humanMergedCountVerifiedInApi!==0||
    r.sourceReview.independentCodeReviewVerified!==false)
    issues.push('SOURCE_EVIDENCE_MISSING');
  if(!exact(r?.staging,['samplesRequired','realSamplesVerifiedInApi',
      'networkCallsPerformedInApi','syntheticEvidenceIsNotLive'])||
    r.staging.samplesRequired!==2||
    r.staging.realSamplesVerifiedInApi!==0||
    r.staging.networkCallsPerformedInApi!==0||
    r.staging.syntheticEvidenceIsNotLive!==true)
    issues.push('STAGING_UNVERIFIED');
  if(!exact(r?.changeWindow,['distinctApproversRequired',
      'verifiedInApi','stagingOnly','allowProduction'])||
    r.changeWindow.distinctApproversRequired!==2||
    r.changeWindow.verifiedInApi!==0||
    r.changeWindow.stagingOnly!==true||
    r.changeWindow.allowProduction!==false)
    issues.push('CHANGE_WINDOW_UNVERIFIED');
  if(!exact(r?.recovery,['independentCopiesRequired',
      'rtoRpoIndependentlyWitnessed','actualOffsiteCustodyVerified'])||
    r.recovery.independentCopiesRequired!==2||
    r.recovery.rtoRpoIndependentlyWitnessed!==false||
    r.recovery.actualOffsiteCustodyVerified!==false)
    issues.push('DR_UNVERIFIED');
  if(!Array.isArray(r?.blockers)||r.blockers.length>128||
    !r.blockers.every(x=>typeof x==='string'&&x.length<130)||
    !R32_BLOCKERS.every(x=>r.blockers.includes(x)))
    issues.push('MISSING_NO_GO_BLOCKERS');
  for(const k of ['guestWritesEnabled','stopLifted','mainChanged',
    'productionAuthorized','customerGo','customerRecordsRead',
    'deployAllowed','automaticMergeAllowed'])
    if(r?.[k]!==false)issues.push('UNSAFE_GO_CLAIM');
  if(r?.manualReviewOnly!==true||r?.note!==NOTE)
    issues.push('DISCLAIMER_OR_SCOPE_CHANGED');
  try{
    const {sha256,...payload}=r;
    if(hash(payload)!==sha256)issues.push('TAMPERED_PACKET');
  }catch{issues.push('INVALID_PACKET_DIGEST');}
  return {valid:issues.length===0,errors:[...new Set(issues)],
    productionAuthorized:false,customerGo:false};
}
export function r32ReadinessCsv(report,{now=new Date()}={}){
  if(!verifyR32Readiness(report,{now}).valid)
    throw new TypeError('R32 packet invalid or expired');
  const rows=[
    ['OSMANX GUEST R32','NO-GO: independent operator acceptance'],
    ['Пилот версия',report.version],
    ['Контроль R31 SHA',report.r31ReportSha],
    ['Релиз',report.releaseSha],
    ['Исходная цепочка','0 / 18 PR verified inside API'],
    ['Реальные staging-снимки','0 / 2 inside API'],
    ['Подписи окна изменений','0 / 2 inside API'],
    ['DR: RTO / RPO','Not independently witnessed'],
    ['Клиентские данные','not read'],['Действует до',report.expiresAt]
  ];
  for(const item of report.blockers)rows.push(['Блокировка',item]);
  rows.push(['SHA-256',report.sha256],['Область допуска',report.note]);
  return csv(rows);
}
