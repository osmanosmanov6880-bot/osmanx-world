/**
 * R26 aggregated owner brief. Strictly derived from the immutable R25 snapshot
 * and R24 hash; SHA-256 detects accidental modifications, not authenticity.
 */
import {createHash} from 'node:crypto';
import {csv} from '../shared/experiment-model.js';
import {verifyR25Brief} from './guest-r25-brief.mjs';
import {assessR26SignalReliability} from './guest-r26-bias.mjs';
import {evaluateR26ReviewGate} from './guest-r26-review.mjs';
import {chooseR26Decision} from './guest-r26-decision.mjs';
export const R26_BRIEF_SCHEMA='osmanx.guest.r26.source-reliability-brief.v1';
const SHA=/^[a-f0-9]{64}$/;
const digest=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
const exact=(x,fields)=>x&&typeof x==='object'&&!Array.isArray(x)&&
  Object.keys(x).sort().join('|')===[...fields].sort().join('|');
export function makeR26Brief({pilot,r25,rows,reviews=[],
  stopActive=false,reviewEnabled=false,now=new Date()}={}){
  if(!verifyR25Brief(r25,{pilotId:pilot?.id}).valid||
    r25.version!==pilot.version||r25.phase!==pilot.phase)
    throw new TypeError('R26 requires unchanged R25 and pilot snapshot');
  const bias=assessR26SignalReliability({rows,profile:r25.profile,
    protocol:pilot.protocol,now});
  const review=evaluateR26ReviewGate({
    pilotId:pilot.id,pilotVersion:pilot.version,
    sourceSha:r25.tallySourceSha,r24EvidenceSha:r25.r24EvidenceSha,
    tallyRows:r25.profile.recordedShifts,
    reviews,stopActive
  });
  const decision=chooseR26Decision({r25,review,bias,stopActive});
  const body={
    schema:R26_BRIEF_SCHEMA,pilotId:pilot.id,
    version:pilot.version,phase:pilot.phase,
    r24EvidenceSha:r25.r24EvidenceSha,
    r25SourceSha:r25.tallySourceSha,
    r25BriefSha:r25.sha256,
    sourceRowCount:r25.profile.recordedShifts,
    sourceSampled:r25.profile.totalSampled,
    reviewEnabled:reviewEnabled===true&&stopActive!==true,
    stopActive:stopActive===true,
    bias,review,decision,
    customerMotivesEstablished:false,
    externalAuditCompleted:false,
    actualFinancialLiftVerified:false,
    reportSigned:false,
    independentLegalBasisConfirmed:false,
    automaticActionTaken:false,
    customerGo:false,productionAuthorized:false,
    warning:'Внутренние отметки двух сотрудников и SHA-256 не подтверждают реальную достоверность источника, причинность или разрешение на коммерческий сбор.'
  };
  return {...body,sha256:digest(body)};
}
export function verifyR26Brief(brief,{pilotId,
  r25SourceSha,r24EvidenceSha}={}){
  const errors=[];
  if(!exact(brief,[
    'schema','pilotId','version','phase','r24EvidenceSha',
    'r25SourceSha','r25BriefSha','sourceRowCount','sourceSampled',
    'reviewEnabled','stopActive','bias','review','decision',
    'customerMotivesEstablished','externalAuditCompleted',
    'actualFinancialLiftVerified','reportSigned',
    'independentLegalBasisConfirmed','automaticActionTaken',
    'customerGo','productionAuthorized','warning','sha256'
  ])||brief.schema!==R26_BRIEF_SCHEMA||
    !SHA.test(brief.r24EvidenceSha||'')||
    !SHA.test(brief.r25SourceSha||'')||
    !SHA.test(brief.r25BriefSha||'')||!SHA.test(brief.sha256||''))
    errors.push('INVALID_SHAPE');
  if(pilotId!==undefined&&brief?.pilotId!==pilotId)
    errors.push('WRONG_PILOT');
  if(r25SourceSha!==undefined&&brief?.r25SourceSha!==r25SourceSha)
    errors.push('WRONG_SOURCE');
  if(r24EvidenceSha!==undefined&&brief?.r24EvidenceSha!==r24EvidenceSha)
    errors.push('WRONG_R24_EVIDENCE');
  try{
    const {sha256,...body}=brief;
    if(digest(body)!==sha256)errors.push('CHANGED_REPORT');
  }catch{errors.push('INVALID_REPORT');}
  for(const key of [
    'customerMotivesEstablished','externalAuditCompleted',
    'actualFinancialLiftVerified','reportSigned',
    'independentLegalBasisConfirmed','automaticActionTaken',
    'customerGo','productionAuthorized'
  ])if(brief?.[key]!==false)errors.push('UNSAFE_CLAIM');
  if(brief?.stopActive===true&&brief?.reviewEnabled===true)
    errors.push('STOP_BYPASS');
  if(brief?.review?.customerGo!==false||
     brief?.bias?.causalExplanationProven!==false||
     brief?.decision?.experimentStarted!==false)
    errors.push('UNSAFE_NESTED_CLAIMS');
  return {valid:errors.length===0,errors:[...new Set(errors)],
    customerGo:false,productionAuthorized:false};
}
export function r26BriefCsv(brief){
  if(!verifyR26Brief(brief).valid)
    throw new Error('R26 evidence changed or unsafe');
  const b=brief.bias,r=brief.review,d=brief.decision;
  const rows=[
    ['OSMANX GUEST INTELLIGENCE R26','Внутренняя проверка анонимных источников'],
    ['Версия пилота',brief.version],
    ['SHA-256 исходных повторных визитов R24',brief.r24EvidenceSha],
    ['SHA-256 анонимных смен R25',brief.r25SourceSha],
    ['SHA-256 отчёта R25',brief.r25BriefSha],
    ['Анонимных смен',brief.sourceRowCount],
    ['Анонимных взаимодействий',brief.sourceSampled],
    ['Источник: оценки персонала %',b.sourceMix.staffPct??'нет данных'],
    ['Источник: анонимный счётчик %',b.sourceMix.counterPct??'нет данных'],
    ['Доля неизвестных %',b.unknownPct??'нет данных'],
    ['Перекос состава смен, п.п.',b.earlyLateShiftDriftPct??'нет данных'],
    ['Флаг стабильности главного сигнала',
      b.leaveOneDayOutLeaderUnstable?'Есть нестабильность':'Не выявлено'],
    ['Предупреждения по данным',b.warnings.join(', ')||'нет'],
    ['Объявление владельца',r.current.owner.verdict??'отсутствует'],
    ['Объявление управляющего',r.current.manager.verdict??'отсутствует'],
    ['Два внутренних подтверждения',r.internalDeclarationsComplete?'да':'нет'],
    ['Независимая внешняя проверка','НЕ ПРОВЕДЕНА'],
    ['Следующее действие',d.firstAction.title],
    ['Нужное доказательство',d.firstAction.evidence],
    ['SHA-256 отчёта',brief.sha256],
    ['Ограничение',brief.warning]
  ];
  return csv(rows);
}
