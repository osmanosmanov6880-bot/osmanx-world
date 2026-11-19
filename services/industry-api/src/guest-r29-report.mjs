/**
 * R29 operator review report, bound to a current R28 human-only packet.
 * No live GitHub/host checks are silently imported into tenant API:
 * chain, staging and rollback are synthetic/unverified until independently
 * inspected by an operator. The report cannot authorize production.
 */
import {createHash} from 'node:crypto';
import {csv} from '../shared/experiment-model.js';
import {verifyR28OperatorPacket} from './guest-r28-operator-packet.mjs';
import {runR29StagingRehearsal,R29_STAGING_SCHEMA}
  from './guest-r29-staging.mjs';
import {evaluateR29Rollback,R29_ROLLBACK_SCHEMA}
  from './guest-r29-rollback.mjs';
export const R29_REPORT_SCHEMA='osmanx.guest.r29.manual-staging-review.v1';
const SHA=/^[a-f0-9]{64}$/;
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const digest=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
const exact=(x,keys)=>x&&typeof x==='object'&&!Array.isArray(x)&&
  Object.keys(x).sort().join('|')===[...keys].sort().join('|');
export function makeR29Report({r28,staging=runR29StagingRehearsal(),
  rollback=evaluateR29Rollback({steps:[],
    expectedReleaseSha:'a'.repeat(64),
    expectedRestoreSha:'b'.repeat(64)}),
  now=new Date()}={}){
  if(!verifyR28OperatorPacket(r28,{now}).valid||
     staging?.schema!==R29_STAGING_SCHEMA||
     staging.allPassed!==true||staging.totalCases!==6||
     staging.passedCases!==6||staging.realHostContacted!==false||
     staging.actualStagingHostProbed!==false||
     rollback?.schema!==R29_ROLLBACK_SCHEMA||
     rollback.remoteRollbackExecuted!==false||
     rollback.productionAuthorized!==false)
    throw new TypeError('R29 requires valid bounded synthetic evidence');
  const expires=new Date(Math.min(Date.parse(r28.expiresAt),
    now.getTime()+10*60000));
  if(expires.getTime()<=now.getTime())throw new TypeError('Source expired');
  const blockers=[
    'R29_FIFTEEN_PR_SOURCE_TREE_NOT_VERIFIED_IN_API',
    'R29_MERGED_MAIN_CI_NOT_VERIFIED',
    'R29_REAL_STAGING_ORIGIN_NOT_PROBED',
    'R29_ACTUAL_ROLLBACK_NOT_PERFORMED',
    'R29_EXTERNAL_VPS_DR_LEGAL_REVIEW_REQUIRED',
    ...r28.blockers
  ];
  const payload={
    schema:R29_REPORT_SCHEMA,pilotId:r28.pilotId,
    version:r28.version,r28PacketSha:r28.sha256,
    sourcePrsRequired:15,
    verifiedSourcePrsInApi:0,mainTreeMatched:false,
    actualStagingVerified:false,actualRollbackVerified:false,
    stagedSynthetic:{passed:staging.passedCases,
      total:staging.totalCases,sha256:staging.sha256},
    rollbackSynthetic:{stage:rollback.stage,
      completed:rollback.completedSteps,
      total:rollback.expectedSteps,
      evidenceVerifiedOffline:rollback.syntheticPathComplete},
    blockers:[...new Set(blockers)],
    issuedAt:now.toISOString(),expiresAt:expires.toISOString(),
    humanReviewOnly:true,automaticMergeAllowed:false,
    realCustomerRecordsRead:false,externalVpsContacted:false,
    mainChanged:false,stopLifted:false,productionDeployed:false,
    customerGo:false,productionAuthorized:false,
    note:'Шесть синтетических staging-сценариев не заменяют реальную сетевую проверку, реальные тесты отката, ревью PR и юридическое согласование.'
  };
  return {...payload,sha256:digest(payload)};
}
export function verifyR29Report(report,{pilotId,now=new Date()}={}){
  const errors=[];
  if(!exact(report,['schema','pilotId','version','r28PacketSha',
    'sourcePrsRequired','verifiedSourcePrsInApi','mainTreeMatched',
    'actualStagingVerified','actualRollbackVerified','stagedSynthetic',
    'rollbackSynthetic','blockers','issuedAt','expiresAt','humanReviewOnly',
    'automaticMergeAllowed','realCustomerRecordsRead','externalVpsContacted',
    'mainChanged','stopLifted','productionDeployed','customerGo',
    'productionAuthorized','note','sha256'])||
    report?.schema!==R29_REPORT_SCHEMA||
    !UUID.test(report?.pilotId||'')||
    !SHA.test(report?.sha256||'')||!SHA.test(report?.r28PacketSha||''))
    errors.push('INVALID_SHAPE');
  if(!(now instanceof Date)||!Number.isFinite(now.getTime())||
     now.getTime()<Date.parse(report?.issuedAt)||
     now.getTime()>=Date.parse(report?.expiresAt)||
     Date.parse(report?.expiresAt)-Date.parse(report?.issuedAt)>10*60000)
    errors.push('EXPIRED_OR_BAD_CLOCK');
  if(pilotId!==undefined&&report?.pilotId!==pilotId)
    errors.push('PILOT_MISMATCH');
  if(report?.sourcePrsRequired!==15||report?.verifiedSourcePrsInApi!==0||
     !Array.isArray(report?.blockers)||report.blockers.length>65||
     !['R29_MERGED_MAIN_CI_NOT_VERIFIED',
       'R29_REAL_STAGING_ORIGIN_NOT_PROBED',
       'R29_ACTUAL_ROLLBACK_NOT_PERFORMED'
     ].every(x=>report.blockers.includes(x)))
    errors.push('MISSING_REQUIRED_BLOCKERS');
  if(report?.stagedSynthetic?.passed!==6||
     report?.stagedSynthetic?.total!==6||
     !SHA.test(report?.stagedSynthetic?.sha256||''))
    errors.push('UNEXPECTED_SYNTHETIC_RESULT');
  for(const key of ['mainTreeMatched','actualStagingVerified',
    'actualRollbackVerified','automaticMergeAllowed',
    'realCustomerRecordsRead','externalVpsContacted',
    'mainChanged','stopLifted','productionDeployed',
    'customerGo','productionAuthorized'])
    if(report?.[key]!==false)errors.push('UNSAFE_CLAIM');
  if(report?.humanReviewOnly!==true)errors.push('PURPOSE_NOT_REVIEW');
  try{
    const {sha256,...body}=report;
    if(digest(body)!==sha256)errors.push('TAMPERED');
  }catch{errors.push('MALFORMED');}
  return {valid:errors.length===0,errors:[...new Set(errors)],
    productionAuthorized:false,customerGo:false};
}
export function r29ReportCsv(report,{now=new Date()}={}){
  if(!verifyR29Report(report,{now}).valid)
    throw new TypeError('Invalid or expired R29');
  const lines=[
    ['OSMANX GUEST R29','Ручная staging-приёмка'],
    ['Пилот версия',report.version],
    ['R28 SHA',report.r28PacketSha],
    ['15 PR проверены','НЕТ, проверяется внешним оператором'],
    ['Тесты staging',report.stagedSynthetic.passed+'/'+report.stagedSynthetic.total],
    ['Реальный staging VPS проверен','НЕТ'],
    ['Реальный rollback выполнен','НЕТ'],
    ['Срок пакета',report.expiresAt]
  ];
  for(const b of report.blockers)lines.push(['Причина NO-GO',b]);
  lines.push(['SHA-256',report.sha256],
    ['Ограничение',report.note]);
  return csv(lines);
}
