/**
 * R30 immutable, short-lived human review handoff. API never imports claims
 * from unknown GitHub/staging/DR witnesses and never grants customer GO.
 */
import {createHash} from 'node:crypto';
import {csv} from '../shared/experiment-model.js';
import {verifyR29Report} from './guest-r29-report.mjs';
import {R29_PIN,R30_SOURCE_SCHEMA} from './guest-r30-source-review.mjs';
export const R30_REPORT_SCHEMA='osmanx.guest.r30.independent-acceptance.v1';
const SHA=/^[a-f0-9]{64}$/;
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const digest=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
const exact=(x,keys)=>x&&typeof x==='object'&&!Array.isArray(x)&&
  Object.keys(x).sort().join('|')===keys.slice().sort().join('|');
const BLOCKERS=Object.freeze([
  'R30_SIXTEEN_PRS_REQUIRE_INDEPENDENT_REVIEW',
  'R30_FRESH_MERGED_MAIN_CI_REQUIRED',
  'R30_ACTUAL_STAGING_WITNESS_REQUIRED',
  'R30_INDEPENDENT_ED25519_QUORUM_REQUIRED',
  'R30_OFFSITE_DR_AND_ACTUAL_ROLLBACK_REQUIRED',
  'R30_LAWFUL_BASIS_AND_CLIENT_APPROVAL_REQUIRED',
  'R30_OPERATOR_CHANGE_WINDOW_REQUIRED'
]);
const PAYLOAD_FIELDS=[
  'schema','pilotId','version','r29ReportSha','sourceHeadCommit',
  'sourcePrsRequired','sourcePrsVerifiedInApi',
  'stagingTraceImportedInApi','independentWitnessesImportedInApi',
  'sourceReview','stagingReview','externalReceipts',
  'blockers','issuedAt','expiresAt','humanReviewOnly',
  'automaticMergeAllowed','actualStagingVerified',
  'offsiteRecoveryVerified','lawfulBasisVerified',
  'stopLifted','mainChanged','customerDataRead',
  'guestWritesEnabled','customerGo','productionAuthorized','note'
];
const DEFAULT_NOTE='Источник R29 синтетический. R30 не заменяет независимый аудит, законное основание, реальный staging, восстановление, ручное объединение PR и fresh CI итогового main.';
export function makeR30Report({r29,now=new Date()}={}){
  if(!verifyR29Report(r29,{now}).valid)throw new TypeError('R30 requires current R29 handoff');
  const expiry=Math.min(Date.parse(r29.expiresAt),now.getTime()+10*60000);
  if(expiry<=now.getTime())throw new TypeError('R29 handoff expired');
  const payload={
    schema:R30_REPORT_SCHEMA,pilotId:r29.pilotId,version:r29.version,
    r29ReportSha:r29.sha256,sourceHeadCommit:R29_PIN.sha,
    sourcePrsRequired:16,sourcePrsVerifiedInApi:0,
    stagingTraceImportedInApi:false,independentWitnessesImportedInApi:false,
    sourceReview:{schema:R30_SOURCE_SCHEMA,
      sourcePrsRequired:16,readOnly:true,reviewedInApi:false},
    stagingReview:{syntheticR29Cases:r29.stagedSynthetic.passed,
      observedRealHostInApi:false,networkCalledByApi:false,
      operatorTraceSignedInApi:false},
    externalReceipts:{requiredDistinctRoles:4,verifiedInApi:0,
      keysFetchedByApi:false},
    blockers:[...new Set([...BLOCKERS,...r29.blockers])],
    issuedAt:now.toISOString(),expiresAt:new Date(expiry).toISOString(),
    humanReviewOnly:true,automaticMergeAllowed:false,
    actualStagingVerified:false,offsiteRecoveryVerified:false,
    lawfulBasisVerified:false,stopLifted:false,mainChanged:false,
    customerDataRead:false,guestWritesEnabled:false,
    customerGo:false,productionAuthorized:false,note:DEFAULT_NOTE
  };
  return {...payload,sha256:digest(payload)};
}
export function verifyR30Report(r,{pilotId,now=new Date()}={}){
  const errors=[];
  if(!exact(r,[...PAYLOAD_FIELDS,'sha256'])||
    r?.schema!==R30_REPORT_SCHEMA||
    !UUID.test(r?.pilotId||'')||!SHA.test(r?.r29ReportSha||'')||
    !SHA.test(r?.sha256||''))errors.push('BAD_SHAPE');
  if(pilotId!==undefined&&r?.pilotId!==pilotId)
    errors.push('PILOT_MISMATCH');
  const issued=Date.parse(r?.issuedAt),expiry=Date.parse(r?.expiresAt);
  if(!(now instanceof Date)||!Number.isFinite(now.getTime())||
     !Number.isFinite(issued)||!Number.isFinite(expiry)||
     now.getTime()<issued||now.getTime()>=expiry||
     expiry-issued>10*60000||expiry<=issued)
    errors.push('EXPIRED_OR_BAD_CLOCK');
  if(r?.sourceHeadCommit!==R29_PIN.sha||
    r?.sourcePrsRequired!==16||r?.sourcePrsVerifiedInApi!==0||
    !exact(r?.sourceReview,['schema','sourcePrsRequired',
      'readOnly','reviewedInApi'])||
    r.sourceReview.schema!==R30_SOURCE_SCHEMA||
    r.sourceReview.sourcePrsRequired!==16||
    r.sourceReview.readOnly!==true||
    r.sourceReview.reviewedInApi!==false)
    errors.push('SOURCE_GRAPH_UNVERIFIED');
  if(!exact(r?.stagingReview,['syntheticR29Cases',
      'observedRealHostInApi','networkCalledByApi',
      'operatorTraceSignedInApi'])||
    r.stagingReview.syntheticR29Cases!==6||
    r.stagingReview.observedRealHostInApi!==false||
    r.stagingReview.networkCalledByApi!==false||
    r.stagingReview.operatorTraceSignedInApi!==false)
    errors.push('STAGING_UNVERIFIED');
  if(!exact(r?.externalReceipts,['requiredDistinctRoles',
      'verifiedInApi','keysFetchedByApi'])||
    r.externalReceipts.requiredDistinctRoles!==4||
    r.externalReceipts.verifiedInApi!==0||
    r.externalReceipts.keysFetchedByApi!==false)
    errors.push('RECEIPTS_UNVERIFIED');
  if(!Array.isArray(r?.blockers)||r.blockers.length>100||
    !r.blockers.every(x=>typeof x==='string'&&x.length<120)||
    !BLOCKERS.every(x=>r.blockers.includes(x)))
    errors.push('MISSING_NO_GO_REASONS');
  if(r?.stagingTraceImportedInApi!==false||
    r?.independentWitnessesImportedInApi!==false||
    r?.humanReviewOnly!==true)
    errors.push('INVALID_REVIEW_SCOPE');
  for(const flag of ['automaticMergeAllowed','actualStagingVerified',
    'offsiteRecoveryVerified','lawfulBasisVerified','stopLifted',
    'mainChanged','customerDataRead','guestWritesEnabled',
    'customerGo','productionAuthorized'])
    if(r?.[flag]!==false)errors.push('UNSAFE_GO_CLAIM');
  if(r?.note!==DEFAULT_NOTE)errors.push('ALTERED_DISCLAIMER');
  try{
    const {sha256,...body}=r;
    if(digest(body)!==sha256)errors.push('TAMPERED');
  }catch{errors.push('MALFORMED');}
  return {valid:errors.length===0,errors:[...new Set(errors)],
    customerGo:false,productionAuthorized:false};
}
export function r30ReportCsv(r,{now=new Date()}={}){
  if(!verifyR30Report(r,{now}).valid)
    throw new TypeError('R30 report invalid or expired');
  const rows=[
    ['OSMANX Guest R30','Независимая приёмка — NO-GO'],
    ['Версия пилота',r.version],
    ['Отпечаток R29',r.r29ReportSha],
    ['Релиз R29',r.sourceHeadCommit],
    ['Исходные PR','0 / 16 проверены в API'],
    ['Синтетический staging R29','6 / 6'],
    ['Реальный staging','НЕ ПОДТВЕРЖДЁН'],
    ['Независимые подписанные роли','0 / 4 в API'],
    ['Восстановление и законное основание','НЕ ПОДТВЕРЖДЕНЫ'],
    ['Действует до',r.expiresAt]
  ];
  for(const code of r.blockers)rows.push(['Блокировка',code]);
  rows.push(['SHA-256 отчёта',r.sha256],['Ограничение',r.note]);
  return csv(rows);
}
