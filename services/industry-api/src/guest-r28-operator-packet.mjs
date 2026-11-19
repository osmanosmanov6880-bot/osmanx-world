/**
 * R28 privacy-safe, at-most-15-minute audit work order for HUMAN operators.
 * This is a checksum-bound snapshot, not an authorization or signature.
 * Never includes receipt signatures, private keys or customer records.
 */
import {createHash} from 'node:crypto';
import {csv} from '../shared/experiment-model.js';
import {verifyR27Handoff} from './guest-r27-handoff.mjs';
import {R28_GATE_SCHEMA,R28_STEP_CODES} from './guest-r28-stage-gate.mjs';
export const R28_PACKET_SCHEMA='osmanx.guest.r28.manual-operator-packet.v1';
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const SHA=/^[a-f0-9]{64}$/;
const CODE=/^[A-Z][A-Z0-9_]{1,80}$/;
const digest=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
const exact=(v,keys)=>v&&typeof v==='object'&&!Array.isArray(v)&&
  Object.keys(v).sort().join('|')===[...keys].sort().join('|');
export function makeR28OperatorPacket({handoff,gate,now=new Date()}={}){
  if(!verifyR27Handoff(handoff,{now}).valid||
     gate?.schema!==R28_GATE_SCHEMA||
     gate.pilotId!==handoff.pilotId||
     gate.version!==handoff.version||
     gate.r27HandoffSha!==handoff.sha256||
     !Array.isArray(gate.blockers)||!gate.blockers.every(x=>CODE.test(x))||
     !Array.isArray(gate.steps)||gate.steps.length!==7||
     !R28_STEP_CODES.every((c,i)=>gate.steps[i]?.code===c)||
     gate.productionAuthorized!==false||gate.customerGo!==false)
    throw new TypeError('R28 operator packet requires current denied-by-default gate');
  const expiration=Math.min(Date.parse(handoff.expiresAt),
    now.getTime()+15*60000);
  if(!Number.isFinite(expiration)||expiration<=now.getTime())
    throw new TypeError('R27 source packet expired');
  const payload={
    schema:R28_PACKET_SCHEMA,pilotId:handoff.pilotId,
    version:handoff.version,r27HandoffSha:handoff.sha256,
    releaseSourceSha:gate.releaseSourceSha,
    issuedAt:now.toISOString(),
    expiresAt:new Date(expiration).toISOString(),
    stage:gate.stage,
    verifiedSourcePrs:gate.checkedSourcePrs,
    totalSourcePrsRequired:14,
    evidenceChecks:{...gate.checks},
    blockers:[...gate.blockers],
    operatorSteps:gate.steps.map(s=>({
      order:s.order,code:s.code,label:s.label,
      proofRequired:s.proof,executed:false
    })),
    offlineReceiptsVerified:gate.externalReceiptSignaturesVerified,
    automaticMergeAllowed:false,
    customerGo:false,productionAuthorized:false,
    actualProductionInspected:false,
    realCustomerDataProcessed:false,
    cryptographicPublisherSignature:false,
    generatedAsHumanReviewOnly:true,
    note:'Отчёт не разрешает деплой, не заменяет подпись, договор, аудит реального хоста или внешнего хранилища.'
  };
  return {...payload,sha256:digest(payload)};
}
export function verifyR28OperatorPacket(packet,{now=new Date(),
  pilotId,version,r27HandoffSha}={}){
  const blockers=[];
  if(!exact(packet,[
    'schema','pilotId','version','r27HandoffSha','releaseSourceSha',
    'issuedAt','expiresAt','stage','verifiedSourcePrs',
    'totalSourcePrsRequired','evidenceChecks','blockers','operatorSteps',
    'offlineReceiptsVerified','automaticMergeAllowed','customerGo',
    'productionAuthorized','actualProductionInspected',
    'realCustomerDataProcessed','cryptographicPublisherSignature',
    'generatedAsHumanReviewOnly','note','sha256'
  ])||packet?.schema!==R28_PACKET_SCHEMA||
    !UUID.test(packet.pilotId||'')||
    !SHA.test(packet.r27HandoffSha||'')||!SHA.test(packet.sha256||''))
    blockers.push('INVALID_PACKET');
  if(!(now instanceof Date)||!Number.isFinite(now.getTime()))
    blockers.push('INVALID_CLOCK');
  const issue=Date.parse(packet?.issuedAt),expiry=Date.parse(packet?.expiresAt);
  if(!Number.isFinite(issue)||!Number.isFinite(expiry)||
    issue>now.getTime()||now.getTime()>=expiry||
    expiry-issue>15*60000||expiry<=issue)
    blockers.push('EXPIRED_OR_FUTURE');
  if(pilotId!==undefined&&packet?.pilotId!==pilotId)
    blockers.push('WRONG_PILOT');
  if(version!==undefined&&packet?.version!==version)
    blockers.push('WRONG_VERSION');
  if(r27HandoffSha!==undefined&&packet?.r27HandoffSha!==r27HandoffSha)
    blockers.push('WRONG_R27_HANDOFF');
  if(!Array.isArray(packet?.blockers)||packet.blockers.length>60||
     !packet.blockers.every(x=>CODE.test(x))||
     !['R28_LIVE_VPS_NOT_INDEPENDENTLY_VERIFIED',
       'R28_OFFSITE_DR_NOT_INDEPENDENTLY_VERIFIED',
       'R28_LAWFUL_BASIS_NOT_VERIFIED',
       'R28_MANUAL_CHANGE_WINDOW_AND_ROLLBACK_NOT_APPROVED'
     ].every(x=>packet.blockers.includes(x)))
    blockers.push('MISSING_MANDATORY_BLOCKERS');
  if(!Array.isArray(packet?.operatorSteps)||
     packet.operatorSteps.length!==7||
     !R28_STEP_CODES.every((s,i)=>
       packet.operatorSteps[i]?.code===s&&
       packet.operatorSteps[i]?.order===i+1&&
       packet.operatorSteps[i]?.executed===false))
    blockers.push('UNSAFE_WORKFLOW');
  if(packet?.totalSourcePrsRequired!==14||
     !Number.isSafeInteger(packet?.verifiedSourcePrs)||
     packet.verifiedSourcePrs<0||packet.verifiedSourcePrs>14||
     typeof packet?.offlineReceiptsVerified!=='boolean')
    blockers.push('INVALID_ATTESTATION_SUMMARY');
  for(const key of ['automaticMergeAllowed','customerGo',
    'productionAuthorized','actualProductionInspected',
    'realCustomerDataProcessed','cryptographicPublisherSignature'])
    if(packet?.[key]!==false)blockers.push('UNSAFE_GO_CLAIM');
  if(packet?.generatedAsHumanReviewOnly!==true)
    blockers.push('UNSAFE_PURPOSE');
  try{
    const {sha256,...payload}=packet;
    if(digest(payload)!==sha256)blockers.push('TAMPERED_PACKET');
  }catch{blockers.push('MALFORMED_CONTENT');}
  return {valid:blockers.length===0,blockers:[...new Set(blockers)],
    productionAuthorized:false,customerGo:false};
}
export function r28OperatorCsv(packet,{now=new Date()}={}){
  if(!verifyR28OperatorPacket(packet,{now}).valid)
    throw new TypeError('R28 packet invalid or expired');
  const rows=[
    ['OSMANX Guest R28','Ручная предрелизная проверка'],
    ['Версия пилота',packet.version],
    ['Отпечаток R27',packet.r27HandoffSha],
    ['Статус',packet.stage],
    ['Проверено исходных PR',packet.verifiedSourcePrs],
    ['Требуется исходных PR',14],
    ['Создано',packet.issuedAt],['Истекает',packet.expiresAt],
    ['Четыре подписанные квитанции проверены',packet.offlineReceiptsVerified?'ДА':'НЕТ']
  ];
  for(const step of packet.operatorSteps)
    rows.push(['Действие '+step.order,step.label+'; доказательство: '+step.proofRequired]);
  for(const issue of packet.blockers)rows.push(['Блокировка',issue]);
  rows.push(['Автоматическая публикация','ЗАПРЕЩЕНА']);
  rows.push(['SHA-256 отчёта',packet.sha256]);
  rows.push(['Ограничение',packet.note]);
  return csv(rows);
}
