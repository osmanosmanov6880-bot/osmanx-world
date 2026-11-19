/**
 * R35 tenant-safe NO-GO handoff. Operator file paths, human reviews, signing
 * keys, network probes and raw evidence never enter this Fastify API.
 */
import {createHash} from 'node:crypto';
import {csv} from '../shared/experiment-model.js';
import {verifyR34Readiness} from './guest-r34-report.mjs';
import {R34_PIN} from './guest-r35-source.mjs';
export const R35_REPORT_SCHEMA='osmanx.guest.r35.operator-evidence-readiness.v1';
export const R35_BLOCKERS=Object.freeze([
  'R35_TWENTY_ONE_PRS_AWAIT_HUMAN_MERGE',
  'R35_FIRST_PR_REVIEW_AND_APPROVAL_REQUIRED',
  'R35_STAGING_FIXED_IP_CERT_CANARY_NOT_WITNESSED',
  'R35_LOCAL_AGE_ARCHIVE_BYTE_HASHES_NOT_IMPORTED',
  'R35_LOCAL_CLIENT_CONTRACT_HASHES_NOT_IMPORTED',
  'R35_REAL_OFFSITE_RESTORE_AND_ROLLBACK_NOT_DONE',
  'R35_INDEPENDENT_LEGAL_REVIEW_REQUIRED',
  'R35_POST_MERGE_MAIN_CI_REQUIRED'
]);
const NOTE='R35: проверка 21 PR, staging с разрешёнными IP и сертификатом, локальная проверка архивов и пяти документов. Только офлайн-оператор может получить проверяемые хеши; веб-API не проверяет реальные файлы, не проводит сетевые запросы и не разрешает запуск.';
const SHA=/^[a-f0-9]{64}$/;
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const exact=(o,k)=>o&&typeof o==='object'&&!Array.isArray(o)&&
  Object.keys(o).sort().join('|')===k.slice().sort().join('|');
const hash=o=>createHash('sha256').update(JSON.stringify(o)).digest('hex');
const KEYS=['schema','pilotId','version','r34PacketSha','r33PacketSha',
  'releaseSha','source','staging','archive','documents','blockers',
  'issuedAt','expiresAt','manualReviewOnly','productionAuthorized',
  'customerGo','guestWritesEnabled','stopLifted','deployAllowed',
  'automaticMergeAllowed','mainChanged','productionChanged',
  'customerDataRead','note'];
export function makeR35Readiness({r34,now=new Date()}={}){
  if(!verifyR34Readiness(r34,{now}).valid)
    throw new TypeError('R35 requires valid current R34 handoff');
  const until=Math.min(Date.parse(r34.expiresAt),now.getTime()+600000);
  if(until<=now.getTime())throw new TypeError('R34 packet expired');
  const body={
    schema:R35_REPORT_SCHEMA,pilotId:r34.pilotId,version:r34.version,
    r34PacketSha:r34.sha256,r33PacketSha:r34.r33PacketSha,
    releaseSha:R34_PIN.sha,
    source:{requiredPrs:21,headReviewsVerifiedInApi:0,
      mergedIntoMainVerified:false,mainCiVerified:false},
    staging:{fixedIpCertCanaryAvailable:true,networkCallsMadeByApi:0,
      independentlyWitnessed:false},
    archive:{byteHashVerifierAvailable:true,
      localFilesReadByApi:0,actualRestoreExecutedByApi:false},
    documents:{localLegalHashVerifierAvailable:true,
      localFilesReadByApi:0,legalAuthorityVerified:false},
    blockers:[...new Set([...R35_BLOCKERS,...r34.blockers])],
    issuedAt:now.toISOString(),expiresAt:new Date(until).toISOString(),
    manualReviewOnly:true,productionAuthorized:false,
    customerGo:false,guestWritesEnabled:false,stopLifted:false,
    deployAllowed:false,automaticMergeAllowed:false,
    mainChanged:false,productionChanged:false,customerDataRead:false,
    note:NOTE};
  return {...body,sha256:hash(body)};
}
export function verifyR35Readiness(report,{pilotId,now=new Date()}={}){
  const errors=[];
  if(!exact(report,[...KEYS,'sha256'])||
    report?.schema!==R35_REPORT_SCHEMA||
    !UUID.test(report?.pilotId||'')||
    !SHA.test(report?.r34PacketSha||'')||
    !SHA.test(report?.r33PacketSha||'')||
    !SHA.test(report?.sha256||''))
    errors.push('INVALID_R35_PACKET');
  if(pilotId!==undefined&&report?.pilotId!==pilotId)
    errors.push('WRONG_PILOT');
  const created=Date.parse(report?.issuedAt),
    end=Date.parse(report?.expiresAt);
  if(!(now instanceof Date)||!Number.isFinite(now.getTime())||
    !Number.isFinite(created)||!Number.isFinite(end)||
    created>now.getTime()||now.getTime()>=end||
    end<=created||end-created>600000)
    errors.push('STALE_OR_FUTURE_PACKET');
  if(report?.releaseSha!==R34_PIN.sha||
    !exact(report?.source,['requiredPrs','headReviewsVerifiedInApi',
      'mergedIntoMainVerified','mainCiVerified'])||
    report.source.requiredPrs!==21||
    report.source.headReviewsVerifiedInApi!==0||
    report.source.mergedIntoMainVerified!==false||
    report.source.mainCiVerified!==false)
    errors.push('UNVERIFIED_SOURCE_CLAIMS');
  if(!exact(report?.staging,['fixedIpCertCanaryAvailable',
      'networkCallsMadeByApi','independentlyWitnessed'])||
    report.staging.fixedIpCertCanaryAvailable!==true||
    report.staging.networkCallsMadeByApi!==0||
    report.staging.independentlyWitnessed!==false)
    errors.push('UNVERIFIED_NETWORK_CLAIMS');
  if(!exact(report?.archive,['byteHashVerifierAvailable',
      'localFilesReadByApi','actualRestoreExecutedByApi'])||
    report.archive.byteHashVerifierAvailable!==true||
    report.archive.localFilesReadByApi!==0||
    report.archive.actualRestoreExecutedByApi!==false)
    errors.push('UNVERIFIED_ARCHIVE_CLAIMS');
  if(!exact(report?.documents,['localLegalHashVerifierAvailable',
      'localFilesReadByApi','legalAuthorityVerified'])||
    report.documents.localLegalHashVerifierAvailable!==true||
    report.documents.localFilesReadByApi!==0||
    report.documents.legalAuthorityVerified!==false)
    errors.push('UNVERIFIED_LEGAL_CLAIMS');
  if(!Array.isArray(report?.blockers)||report.blockers.length>180||
    !report.blockers.every(x=>typeof x==='string'&&x.length<170)||
    !R35_BLOCKERS.every(x=>report.blockers.includes(x)))
    errors.push('CRITICAL_NO_GO_REASONS_REMOVED');
  for(const key of ['productionAuthorized','customerGo',
    'guestWritesEnabled','stopLifted','deployAllowed',
    'automaticMergeAllowed','mainChanged','productionChanged',
    'customerDataRead'])
    if(report?.[key]!==false)errors.push('GO_CLAIM_FORBIDDEN');
  if(report?.manualReviewOnly!==true||report?.note!==NOTE)
    errors.push('REPORT_POLICY_CHANGED');
  if(exact(report,[...KEYS,'sha256'])){
    const {sha256,...copy}=report;
    if(hash(copy)!==sha256)errors.push('TAMPERED_SHA256');
  }
  return {valid:errors.length===0,errors:[...new Set(errors)],
    customerGo:false,productionAuthorized:false};
}
export function r35ReadinessCsv(report,{now=new Date()}={}){
  if(!verifyR35Readiness(report,{now}).valid)
    throw new TypeError('R35 report expired or invalid');
  const rows=[
    ['OSMANX GUEST R35','NO-GO / operator external review'],
    ['Пилот версия',report.version],
    ['R34 SHA-256',report.r34PacketSha],
    ['Source head',report.releaseSha],
    ['Проверка 21 PR','not performed in web API'],
    ['Разрешённый staging IP/TLS','external operator only'],
    ['2 AGE archives','local file byte verification required'],
    ['5 client documents','local file byte verification required'],
    ['Offsite restore','independent restore pending'],
    ['Дата окончания',report.expiresAt]
  ];
  for(const reason of report.blockers)rows.push(['Блокировка',reason]);
  rows.push(['Контроль SHA-256',report.sha256],['Примечание',report.note]);
  return csv(rows);
}
