/**
 * Tenant MANAGE-only R33 status packet. External signatures are intentionally
 * NOT accepted or fetched by this API. Reports describe missing evidence and
 * never authorize real customer operations.
 */
import {createHash} from 'node:crypto';
import {csv} from '../shared/experiment-model.js';
import {verifyR32Readiness} from './guest-r32-report.mjs';
import {R32_PIN} from './guest-r33-source.mjs';
export const R33_REPORT_SCHEMA='osmanx.guest.r33.independent-review-readiness.v1';
const SHA=/^[a-f0-9]{64}$/;
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const digest=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
const exact=(x,keys)=>x&&typeof x==='object'&&!Array.isArray(x)&&
  Object.keys(x).sort().join('|')===keys.slice().sort().join('|');
export const R33_BLOCKERS=Object.freeze([
  'R33_NINETEEN_PRS_REQUIRE_HUMAN_MERGE',
  'R33_POST_MERGE_MAIN_CI_REQUIRED',
  'R33_TWO_SIGNED_STAGING_WITNESSES_MISSING',
  'R33_LIVE_TLS_DNS_AND_VPS_NOT_WITNESSED',
  'R33_DISPOSABLE_ROLLBACK_ONLY',
  'R33_ACTUAL_OFFSITE_RESTORE_NOT_PROVED',
  'R33_CLIENT_PRIVACY_AND_LAWFUL_BASIS_MISSING',
  'R33_CHANGE_WINDOW_AND_PRODUCTION_APPROVAL_MISSING'
]);
const NOTE='R33: четыре Ed25519-утверждения, учебный откат и проверка документов могут быть направлены оператору на ручную проверку. Это не подтверждение реального VPS, хранения резервных копий, договора или права включить production.';
const FIELDS=['schema','pilotId','version','r32ReportSha','r31ReportSha',
  'releaseSha','source','staging','rollback','privacy','blockers',
  'issuedAt','expiresAt','reviewOnly','automaticMergeAllowed','deployAllowed',
  'mainChanged','guestWritesEnabled','stopLifted','customerDataRead',
  'customerGo','productionAuthorized','note'];
export function makeR33Readiness({r32,now=new Date()}={}){
  if(!verifyR32Readiness(r32,{now}).valid)
    throw new TypeError('R33 requires current R32 handoff');
  const expires=Math.min(Date.parse(r32.expiresAt),now.getTime()+600000);
  if(expires<=now.getTime())throw new TypeError('R32 handoff expired');
  const packet={
    schema:R33_REPORT_SCHEMA,pilotId:r32.pilotId,version:r32.version,
    r32ReportSha:r32.sha256,r31ReportSha:r32.r31ReportSha,
    releaseSha:R32_PIN.sha,
    source:{prsRequired:19,prsVerifiedInApi:0,
      postMergeMainCiVerified:false},
    staging:{independentSignerRolesRequired:2,verifiedInApi:0,
      realTlsHandshakeVerified:false,realDnsVerified:false,
      realHttpObservationsVerifiedInApi:0},
    rollback:{disposableLedgerAvailable:true,
      simulatedChecksImportedInApi:0,realOffsiteRestoreVerified:false,
      liveRollbackPerformed:false},
    privacy:{clientAndPrivacySignerRolesRequired:2,
      signaturesVerifiedInApi:0,contractContentsVerified:false,
      lawfulBasisVerified:false,personalDataCollected:false},
    blockers:[...new Set([...R33_BLOCKERS,...r32.blockers])],
    issuedAt:now.toISOString(),expiresAt:new Date(expires).toISOString(),
    reviewOnly:true,automaticMergeAllowed:false,deployAllowed:false,
    mainChanged:false,guestWritesEnabled:false,stopLifted:false,
    customerDataRead:false,customerGo:false,productionAuthorized:false,
    note:NOTE
  };
  return {...packet,sha256:digest(packet)};
}
export function verifyR33Readiness(packet,{pilotId,now=new Date()}={}){
  const issues=[];
  if(!exact(packet,[...FIELDS,'sha256'])||
    packet?.schema!==R33_REPORT_SCHEMA||
    !UUID.test(packet?.pilotId||'')||
    !SHA.test(packet?.r32ReportSha||'')||
    !SHA.test(packet?.r31ReportSha||'')||
    !SHA.test(packet?.sha256||''))
    issues.push('BAD_PACKET_ENVELOPE');
  if(pilotId!==undefined&&packet?.pilotId!==pilotId)
    issues.push('PILOT_MISMATCH');
  const issued=Date.parse(packet?.issuedAt),
    expires=Date.parse(packet?.expiresAt);
  if(!(now instanceof Date)||!Number.isFinite(now.getTime())||
    !Number.isFinite(issued)||!Number.isFinite(expires)||
    issued>now.getTime()||expires<=now.getTime()||
    expires<=issued||expires-issued>600000)
    issues.push('EXPIRED_OR_FUTURE_REPORT');
  if(packet?.releaseSha!==R32_PIN.sha||
    !exact(packet?.source,['prsRequired','prsVerifiedInApi',
      'postMergeMainCiVerified'])||
    packet.source.prsRequired!==19||
    packet.source.prsVerifiedInApi!==0||
    packet.source.postMergeMainCiVerified!==false)
    issues.push('SOURCE_UNVERIFIED');
  if(!exact(packet?.staging,['independentSignerRolesRequired',
    'verifiedInApi','realTlsHandshakeVerified','realDnsVerified',
    'realHttpObservationsVerifiedInApi'])||
    packet.staging.independentSignerRolesRequired!==2||
    packet.staging.verifiedInApi!==0||
    packet.staging.realTlsHandshakeVerified!==false||
    packet.staging.realDnsVerified!==false||
    packet.staging.realHttpObservationsVerifiedInApi!==0)
    issues.push('STAGING_UNVERIFIED');
  if(!exact(packet?.rollback,['disposableLedgerAvailable',
    'simulatedChecksImportedInApi','realOffsiteRestoreVerified',
    'liveRollbackPerformed'])||
    packet.rollback.disposableLedgerAvailable!==true||
    packet.rollback.simulatedChecksImportedInApi!==0||
    packet.rollback.realOffsiteRestoreVerified!==false||
    packet.rollback.liveRollbackPerformed!==false)
    issues.push('RECOVERY_UNVERIFIED');
  if(!exact(packet?.privacy,['clientAndPrivacySignerRolesRequired',
    'signaturesVerifiedInApi','contractContentsVerified',
    'lawfulBasisVerified','personalDataCollected'])||
    packet.privacy.clientAndPrivacySignerRolesRequired!==2||
    packet.privacy.signaturesVerifiedInApi!==0||
    packet.privacy.contractContentsVerified!==false||
    packet.privacy.lawfulBasisVerified!==false||
    packet.privacy.personalDataCollected!==false)
    issues.push('LEGAL_UNVERIFIED');
  if(!Array.isArray(packet?.blockers)||packet.blockers.length>150||
    !packet.blockers.every(x=>typeof x==='string'&&x.length<=160)||
    !R33_BLOCKERS.every(x=>packet.blockers.includes(x)))
    issues.push('NO_GO_REASONS_REMOVED');
  for(const key of ['automaticMergeAllowed','deployAllowed','mainChanged',
    'guestWritesEnabled','stopLifted','customerDataRead',
    'customerGo','productionAuthorized'])
    if(packet?.[key]!==false)issues.push('UNAUTHORIZED_GO');
  if(packet?.reviewOnly!==true||packet?.note!==NOTE)
    issues.push('REPORT_SCOPE_CHANGED');
  try{
    if(exact(packet,[...FIELDS,'sha256'])){
      const {sha256,...content}=packet;
      if(digest(content)!==sha256)issues.push('DIGEST_MISMATCH');
    }
  }catch{issues.push('BAD_REPORT_DIGEST');}
  return {valid:issues.length===0,errors:[...new Set(issues)],
    productionAuthorized:false,customerGo:false};
}
export function r33ReadinessCsv(packet,{now=new Date()}={}){
  if(!verifyR33Readiness(packet,{now}).valid)
    throw new TypeError('R33 NO-GO packet invalid or expired');
  const rows=[
    ['OSMANX Guest R33','NO-GO / manual independent acceptance'],
    ['Пилот версия',packet.version],
    ['R32 SHA-256',packet.r32ReportSha],
    ['Проверяемый релиз',packet.releaseSha],
    ['Исходная цепочка','0 / 19 PR independently reviewed in API'],
    ['Staging Ed25519','0 / 2 independent signatures in API'],
    ['Privacy Ed25519','0 / 2 independent signatures in API'],
    ['Реальная проверка TLS/DNS/VPS','NOT PERFORMED IN API'],
    ['Реальный offsite и откат','NOT PERFORMED IN API'],
    ['Действует до',packet.expiresAt]
  ];
  for(const blocker of packet.blockers)rows.push(['Блокировка',blocker]);
  rows.push(['Контроль SHA-256',packet.sha256],['Ограничение',packet.note]);
  return csv(rows);
}
