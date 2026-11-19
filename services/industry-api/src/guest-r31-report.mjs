/**
 * R31 bounded review packet for tenant MANAGE UI. External checks are NEVER
 * fetched or imported by this web API and may not enable production.
 */
import {createHash} from 'node:crypto';
import {csv} from '../shared/experiment-model.js';
import {verifyR30Report} from './guest-r30-report.mjs';
import {R30_PIN} from './guest-r31-chain.mjs';
export const R31_REPORT_SCHEMA='osmanx.guest.r31.operator-handoff.v1';
const SHA=/^[a-f0-9]{64}$/;
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const hash=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
const exact=(x,keys)=>x&&typeof x==='object'&&!Array.isArray(x)&&
  Object.keys(x).sort().join('|')===keys.slice().sort().join('|');
export const R31_BLOCKERS=Object.freeze([
  'R31_SEVENTEEN_PRS_REQUIRE_HUMAN_REVIEW',
  'R31_FRESH_POST_MERGE_MAIN_CI_MISSING',
  'R31_REAL_STAGING_OPERATOR_GET_NOT_EXECUTED_IN_API',
  'R31_FOUR_SIGNED_INDEPENDENT_WITNESSES_MISSING',
  'R31_OFFSITE_DR_PROOF_AND_ROLLBACK_NOT_VERIFIED',
  'R31_LAWFUL_BASIS_AND_CLIENT_CONTRACT_NOT_VERIFIED',
  'R31_MANUAL_CHANGE_WINDOW_UNAPPROVED'
]);
const KEYS=['schema','pilotId','version','r30PacketSha','r29ReportSha',
  'sourceHeadCommit','sourcePrsRequired','sourcePrsCheckedInApi',
  'staging','witnesses','restoration','blockers',
  'issuedAt','expiresAt','manualReviewOnly','automaticMergeAllowed',
  'productionGo','customerGo','mainChanged','stopLifted',
  'guestWritesEnabled','customerRecordsRead','legalApprovalVerified',
  'note'];
const NOTE='R31 даёт безопасные операторские инструменты и требования к доказательствам. Настоящие VPS/DR/правовые свидетельства, ручной merge и CI итогового main не проверяются этим API.';
export function makeR31OperatorReport({r30,now=new Date()}={}){
  if(!verifyR30Report(r30,{now}).valid)
    throw new TypeError('R31 needs current R30 packet');
  const issued=now.getTime(),expires=Math.min(
    Date.parse(r30.expiresAt),issued+10*60000);
  if(expires<=issued)throw new TypeError('R30 source expired');
  const payload={
    schema:R31_REPORT_SCHEMA,pilotId:r30.pilotId,version:r30.version,
    r30PacketSha:r30.sha256,r29ReportSha:r30.r29ReportSha,
    sourceHeadCommit:R30_PIN.sha,sourcePrsRequired:17,
    sourcePrsCheckedInApi:0,
    staging:{operatorGetCliAvailable:true,
      operatorApprovalRequired:true,realVpsProbedInApi:false,
      syntheticResultsNotProductionProof:true},
    witnesses:{ed25519RolesRequired:4,verifiedInApi:0,
      trustedPublicKeysInApi:false},
    restoration:{twoIndependentArchivesRequired:true,
      offlineExternalCustodyVerified:false,actualRollbackVerified:false},
    blockers:[...new Set([...R31_BLOCKERS,...r30.blockers])],
    issuedAt:now.toISOString(),expiresAt:new Date(expires).toISOString(),
    manualReviewOnly:true,automaticMergeAllowed:false,
    productionGo:false,customerGo:false,mainChanged:false,
    stopLifted:false,guestWritesEnabled:false,customerRecordsRead:false,
    legalApprovalVerified:false,note:NOTE
  };
  return {...payload,sha256:hash(payload)};
}
export function verifyR31OperatorReport(r,{pilotId,now=new Date()}={}){
  const errors=[];
  if(!exact(r,[...KEYS,'sha256'])||r?.schema!==R31_REPORT_SCHEMA||
    !UUID.test(r?.pilotId||'')||!SHA.test(r?.r30PacketSha||'')||
    !SHA.test(r?.r29ReportSha||'')||!SHA.test(r?.sha256||''))
    errors.push('INVALID_PACKET');
  if(pilotId!==undefined&&r?.pilotId!==pilotId)
    errors.push('WRONG_PILOT');
  const issued=Date.parse(r?.issuedAt),expires=Date.parse(r?.expiresAt);
  if(!(now instanceof Date)||!Number.isFinite(now.getTime())||
    !Number.isFinite(issued)||!Number.isFinite(expires)||
    now.getTime()<issued||now.getTime()>=expires||
    expires<=issued||expires-issued>10*60000)
    errors.push('BAD_CLOCK_OR_EXPIRED');
  if(r?.sourceHeadCommit!==R30_PIN.sha||
    r?.sourcePrsRequired!==17||r?.sourcePrsCheckedInApi!==0)
    errors.push('SOURCE_UNVERIFIED');
  if(!exact(r?.staging,['operatorGetCliAvailable',
    'operatorApprovalRequired','realVpsProbedInApi',
    'syntheticResultsNotProductionProof'])||
    r.staging.operatorGetCliAvailable!==true||
    r.staging.operatorApprovalRequired!==true||
    r.staging.realVpsProbedInApi!==false||
    r.staging.syntheticResultsNotProductionProof!==true)
    errors.push('STAGING_UNVERIFIED');
  if(!exact(r?.witnesses,['ed25519RolesRequired','verifiedInApi',
    'trustedPublicKeysInApi'])||
    r.witnesses.ed25519RolesRequired!==4||
    r.witnesses.verifiedInApi!==0||
    r.witnesses.trustedPublicKeysInApi!==false)
    errors.push('WITNESSES_UNVERIFIED');
  if(!exact(r?.restoration,['twoIndependentArchivesRequired',
    'offlineExternalCustodyVerified','actualRollbackVerified'])||
    r.restoration.twoIndependentArchivesRequired!==true||
    r.restoration.offlineExternalCustodyVerified!==false||
    r.restoration.actualRollbackVerified!==false)
    errors.push('RESTORE_UNVERIFIED');
  if(!Array.isArray(r?.blockers)||r.blockers.length>120||
    !r.blockers.every(x=>typeof x==='string'&&x.length<128)||
    !R31_BLOCKERS.every(x=>r.blockers.includes(x)))
    errors.push('MISSING_BLOCKERS');
  if(r?.manualReviewOnly!==true||r?.automaticMergeAllowed!==false||
    r?.productionGo!==false||r?.customerGo!==false||
    r?.mainChanged!==false||r?.stopLifted!==false||
    r?.guestWritesEnabled!==false||r?.customerRecordsRead!==false||
    r?.legalApprovalVerified!==false||r?.note!==NOTE)
    errors.push('UNAUTHORIZED_GO_CLAIM');
  try{
    const {sha256,...body}=r;
    if(hash(body)!==sha256)errors.push('TAMPERED');
  }catch{errors.push('BAD_PAYLOAD');}
  return {valid:errors.length===0,errors:[...new Set(errors)],
    productionAuthorized:false,customerGo:false};
}
export function r31OperatorCsv(r,{now=new Date()}={}){
  if(!verifyR31OperatorReport(r,{now}).valid)
    throw new TypeError('R31 packet invalid or expired');
  const rows=[
    ['OSMANX Guest R31','NO-GO / ручная приёмка'],
    ['Пилот версия',r.version],
    ['R30 пакет SHA-256',r.r30PacketSha],
    ['Релиз R30',r.sourceHeadCommit],
    ['Исходная цепочка','0 / 17 проверено внутри API'],
    ['Операторский staging','Требуется отдельный разрешённый запуск'],
    ['Подписанные свидетели','0 / 4 в API'],
    ['Независимое offsite восстановление','НЕ ПОДТВЕРЖДЕНО'],
    ['Запрещено авто-объединение','ДА'],
    ['Истекает',r.expiresAt]
  ];
  for(const code of r.blockers)rows.push(['Блокировка',code]);
  rows.push(['SHA-256 отчёта',r.sha256],['Ограничение',r.note]);
  return csv(rows);
}
