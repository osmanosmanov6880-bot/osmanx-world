/**
 * R27 bounded human-only handoff; copies no guest identifiers or raw sources.
 * SHA-256 guards against accidental modification, but is not a signature or
 * authorization. E2E rehearsal is deterministic and always synthetic.
 */
import {createHash} from 'node:crypto';
import {csv} from '../shared/experiment-model.js';
import {verifyR24Brief} from './guest-r24-brief.mjs';
import {verifyR25Brief} from './guest-r25-brief.mjs';
import {verifyR26Brief} from './guest-r26-brief.mjs';
import {R27_AUDIT_SCHEMA} from './guest-r27-decision-audit.mjs';
import {R27_REHEARSAL_SCHEMA} from './guest-r27-rehearsal.mjs';
export const R27_HANDOFF_SCHEMA='osmanx.guest.r27.operator-handoff.v1';
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const SHA=/^[a-f0-9]{64}$/;
const code=c=>typeof c==='string'&&/^[A-Z][A-Z0-9_]{1,72}$/.test(c);
const digest=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
const exact=(x,keys)=>x&&typeof x==='object'&&!Array.isArray(x)&&
  Object.keys(x).sort().join('|')===[...keys].sort().join('|');
export function makeR27Handoff({r24,r25,r26,audit,rehearsal,
  now=new Date()}={}){
  if(!verifyR24Brief(r24).valid||!verifyR25Brief(r25).valid||
     !verifyR26Brief(r26).valid||audit?.schema!==R27_AUDIT_SCHEMA||
     rehearsal?.schema!==R27_REHEARSAL_SCHEMA||
     !UUID.test(r24.pilotId||'')||
     !(now instanceof Date)||!Number.isFinite(now.getTime())||
     audit.pilotId!==r24.pilotId||audit.version!==r24.version||
     audit.r24EvidenceSha!==r24.evidenceDigest||
     audit.r25SourceSha!==r25.tallySourceSha||
     audit.r26BriefSha!==r26.sha256||
     !SHA.test(rehearsal.sha256||'')||
     !Array.isArray(rehearsal.cases)||rehearsal.cases.length!==7||
     !Array.isArray(audit.blockers)||audit.blockers.length>45||
     !audit.blockers.every(code))
    throw new TypeError('R27 requires exact cross-layer source evidence');
  const {sha256,...rehearsalWithoutHash}=rehearsal;
  if(digest(rehearsalWithoutHash)!==sha256)
    throw new TypeError('Synthetic case digest mismatch');
  const ready=rehearsal.allPassed===true&&
    rehearsal.passedCases===7&&rehearsal.totalCases===7&&
    rehearsal.realCustomerDataUsed===false&&
    rehearsal.runtimeExternalCalls===0&&
    rehearsal.persistedRecords===0&&
    audit.state==='EXTERNAL_REVIEW_REQUIRED';
  const blockers=[...new Set(audit.blockers)];
  if(!ready)blockers.push('R27_TECHNICAL_OR_MODEL_REVIEW_REQUIRED');
  // This is mandatory EVEN IF every internal technical predicate passes.
  for(const requirement of [
    'R27_REAL_CLIENT_CONTRACT_AND_LAWFUL_BASIS_REQUIRED',
    'R27_INDEPENDENT_VPS_AND_DR_REVIEW_REQUIRED',
    'R27_HUMAN_MERGE_AND_CHANGE_TICKET_REQUIRED'
  ])if(!blockers.includes(requirement))blockers.push(requirement);
  const issued=now.toISOString(),expires=new Date(now.getTime()+30*60000).toISOString();
  const payload={
    schema:R27_HANDOFF_SCHEMA,
    pilotId:r24.pilotId,version:r24.version,issuedAt:issued,expiresAt:expires,
    source:{
      r24EvidenceSha:r24.evidenceDigest,r24BriefSha:r24.sha256,
      r25SourceSha:r25.tallySourceSha,r25BriefSha:r25.sha256,
      r26BriefSha:r26.sha256
    },
    rehearsal:{
      sha256:rehearsal.sha256,passedCases:rehearsal.passedCases,
      totalCases:7,allSynthetic:true
    },
    decision:{
      stage:audit.state,firstActionCode:audit.nextAction.code,
      technicalReviewMayProceed:ready,
      currentEvidenceInternallyReconciled:
        audit.evidenceReviewInternallyComplete===true
    },
    blockers,selectedRiskCodes:audit.warnings.filter(code).slice(0,24),
    authorizedOperatorSignature:false,
    externalAuditVerified:false,legalBasisVerified:false,
    liveHostInspected:false,offsiteDrVerified:false,
    productionDeploymentExecuted:false,
    customerGo:false,productionAuthorized:false,
    reportContainsPersonalData:false,
    disclaimer:'Пакет не является договором, подписью, разрешением на сбор, проверкой внешнего VPS или доказательством причинного эффекта.'
  };
  return {...payload,sha256:digest(payload)};
}
export function verifyR27Handoff(packet,{now=new Date(),
  pilotId,version,source}={}){
  const errors=[];
  if(!exact(packet,[
    'schema','pilotId','version','issuedAt','expiresAt','source',
    'rehearsal','decision','blockers','selectedRiskCodes',
    'authorizedOperatorSignature','externalAuditVerified',
    'legalBasisVerified','liveHostInspected','offsiteDrVerified',
    'productionDeploymentExecuted','customerGo','productionAuthorized',
    'reportContainsPersonalData','disclaimer','sha256'
  ])||packet?.schema!==R27_HANDOFF_SCHEMA||
     !UUID.test(packet?.pilotId||'')||
     !SHA.test(packet?.sha256||''))
    errors.push('INVALID_PACKET');
  if(!(now instanceof Date)||!Number.isFinite(now.getTime()))
    errors.push('INVALID_CLOCK');
  const issued=Date.parse(packet?.issuedAt),expires=Date.parse(packet?.expiresAt);
  if(!Number.isFinite(issued)||!Number.isFinite(expires)||
    expires-issued!==30*60000||now.getTime()<issued||
    now.getTime()>=expires)
    errors.push('EXPIRED_OR_INVALID_TIME');
  if(pilotId!==undefined&&packet?.pilotId!==pilotId)
    errors.push('WRONG_PILOT');
  if(version!==undefined&&packet?.version!==version)
    errors.push('WRONG_VERSION');
  if(source!==undefined&&
    (!source||Object.entries(source).some(([key,value])=>
      packet?.source?.[key]!==value)))
    errors.push('WRONG_SOURCE');
  try{
    const {sha256,...body}=packet;
    if(digest(body)!==sha256)errors.push('TAMPERED');
  }catch{errors.push('INVALID_CONTENT');}
  if(!exact(packet?.source,[
    'r24EvidenceSha','r24BriefSha','r25SourceSha','r25BriefSha','r26BriefSha'
  ])||!Object.values(packet.source||{}).every(x=>SHA.test(x||'')))
    errors.push('SOURCE_SHAPE');
  if(!Array.isArray(packet?.blockers)||packet.blockers.length>45||
    !packet.blockers.every(code)||
    !Array.isArray(packet?.selectedRiskCodes)||
    packet.selectedRiskCodes.length>24||
    !packet.selectedRiskCodes.every(code))
    errors.push('UNSAFE_CODES');
  if(!Array.isArray(packet?.blockers)||
    !['R27_REAL_CLIENT_CONTRACT_AND_LAWFUL_BASIS_REQUIRED',
      'R27_INDEPENDENT_VPS_AND_DR_REVIEW_REQUIRED',
      'R27_HUMAN_MERGE_AND_CHANGE_TICKET_REQUIRED'
    ].every(k=>packet.blockers.includes(k)))
    errors.push('MISSING_EXTERNAL_BLOCKERS');
  if(packet?.rehearsal?.allSynthetic!==true||
    packet?.decision?.technicalReviewMayProceed===undefined)
    errors.push('INVALID_REHEARSAL');
  for(const key of [
    'authorizedOperatorSignature','externalAuditVerified','legalBasisVerified',
    'liveHostInspected','offsiteDrVerified','productionDeploymentExecuted',
    'customerGo','productionAuthorized','reportContainsPersonalData'
  ])if(packet?.[key]!==false)errors.push('UNSAFE_AUTHORIZATION_CLAIM');
  return {valid:errors.length===0,errors:[...new Set(errors)],
    customerGo:false,productionAuthorized:false};
}
export function r27HandoffCsv(packet,{now=new Date()}={}){
  if(!verifyR27Handoff(packet,{now}).valid)
    throw new Error('R27 expired or modified handoff cannot be exported');
  return csv([
    ['OSMANX GUEST INTELLIGENCE R27','Технический пакет для ручной проверки'],
    ['Версия пилота',packet.version],
    ['Начало срока действия',packet.issuedAt],
    ['Окончание срока',packet.expiresAt],
    ['R24 SHA-256 наблюдений',packet.source.r24EvidenceSha],
    ['R25 SHA-256 источников',packet.source.r25SourceSha],
    ['R26 SHA-256 внутреннего отчёта',packet.source.r26BriefSha],
    ['Синтетический прогон',packet.rehearsal.passedCases+'/'+packet.rehearsal.totalCases],
    ['Состояние аналитики',packet.decision.stage],
    ['Следующее действие',packet.decision.firstActionCode],
    ['Причины запрета',packet.blockers.join(', ')],
    ['Реальный VPS проверен','НЕТ'],
    ['Юридическое разрешение получено','НЕТ'],
    ['Production активирован','НЕТ'],
    ['SHA-256 пакета',packet.sha256],
    ['Ограничение',packet.disclaimer]
  ]);
}
