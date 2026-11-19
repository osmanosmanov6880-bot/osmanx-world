/**
 * R25 manager report combines the real R24 retention observations with
 * independently collected ANONYMOUS shift-category estimates. The two data
 * sets are NOT joined at individual guest level and cannot prove causation.
 */
import {createHash} from 'node:crypto';
import {csv} from '../shared/experiment-model.js';
import {summarizeR25Operational,R25_PROFILE_SCHEMA}
  from './guest-r25-signals.mjs';
import {deriveR25Hypotheses} from './guest-r25-hypotheses.mjs';
import {draftR25Experiment} from './guest-r25-experiment.mjs';
export const R25_BRIEF_SCHEMA='osmanx.guest.r25.operational-brief.v1';
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const SHA=/^[a-f0-9]{64}$/;
const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const exact=(x,keys)=>x&&typeof x==='object'&&!Array.isArray(x)&&
  Object.keys(x).sort().join('|')===[...keys].sort().join('|');
export function makeR25Brief({pilot,rows,r24,hold=false,recordingAvailable=false,now=new Date()}={}){
  if(!UUID.test(pilot?.id||'')||
    !Number.isSafeInteger(pilot?.version)||pilot.version<1||
    !SHA.test(r24?.evidenceDigest||'')||
    r24?.schema!=='osmanx.guest.r24.manager-brief.v1'||
    r24.pilotId!==pilot.id||r24.version!==pilot.version)
    throw new TypeError('R25 report must refer to verified original R24 evidence');
  const profile=summarizeR25Operational(rows,{
    protocol:pilot.protocol,now
  });
  const board=deriveR25Hypotheses(profile);
  const nextExperiment=draftR25Experiment({
    pilot,profile,board,r24,stopActive:hold,now
  });
  const normalized=[...rows].map(r=>({
    date:r.date,shift:r.shift,source:r.source,sampled:r.sampled,
    counts:r.counts
  })).sort((a,b)=>a.date.localeCompare(b.date)||a.shift.localeCompare(b.shift));
  const sourceDigest=digest(normalized);
  const payload={
    schema:R25_BRIEF_SCHEMA,pilotId:pilot.id,version:pilot.version,
    phase:pilot.phase,
    r24EvidenceSha:r24.evidenceDigest,
    r24RetainedReturns:{
      observedPeriods:r24.observedPeriods,
      controlRatePct:r24.statistics.controlRatePct,
      offerRatePct:r24.statistics.offerRatePct,
      differencePp:r24.statistics.differencePp,
      approximate95DifferencePp:r24.statistics.interval95Pp
    },
    tallySourceSha:sourceDigest,
    profile,board,nextExperiment,
    emergencyStopActive:hold===true,
    recordingAvailable:recordingAvailable===true&&hold!==true,
    anonymousCategoryEstimatesOnly:true,
    individualGuestsLinked:false,causalExplanationProven:false,
    confidenceInCustomerMotives:false,
    actionsAutomaticallyExecuted:false,
    signed:false,legalGo:false,customerGo:false,
    productionAuthorized:false,
    warning:'Коды препятствий составлены по анонимным оценкам процессов. Они не связаны с реальными возвратами конкретных гостей, не доказывают причинность и не гарантируют рост выручки.'
  };
  return {...payload,sha256:digest(payload)};
}
export function verifyR25Brief(report,{pilotId,r24EvidenceSha}={}){
  const blockers=[];
  if(!exact(report,[
    'schema','pilotId','version','phase','r24EvidenceSha',
    'r24RetainedReturns','tallySourceSha','profile','board',
    'nextExperiment','emergencyStopActive','recordingAvailable',
    'anonymousCategoryEstimatesOnly','individualGuestsLinked',
    'causalExplanationProven','confidenceInCustomerMotives',
    'actionsAutomaticallyExecuted','signed','legalGo','customerGo',
    'productionAuthorized','warning','sha256'
  ])||report.schema!==R25_BRIEF_SCHEMA||
    !UUID.test(report.pilotId||'')||
    !SHA.test(report.r24EvidenceSha||'')||
    !SHA.test(report.tallySourceSha||'')||
    !SHA.test(report.sha256||''))
    blockers.push('INVALID_REPORT_SHAPE');
  if(pilotId!==undefined&&report?.pilotId!==pilotId)
    blockers.push('WRONG_PILOT');
  if(r24EvidenceSha!==undefined&&report?.r24EvidenceSha!==r24EvidenceSha)
    blockers.push('WRONG_R24_EVIDENCE');
  try{
    const {sha256,...body}=report;
    if(digest(body)!==sha256)blockers.push('TAMPERED_REPORT');
    if(report?.profile?.schema!==R25_PROFILE_SCHEMA||
       report?.profile?.individualReasonsKnown!==false)
      blockers.push('INVALID_SIGNAL_PROFILE');
  }catch{blockers.push('INVALID_REPORT_CONTENT');}
  if(typeof report?.recordingAvailable!=='boolean'||
     (report?.emergencyStopActive===true&&report?.recordingAvailable===true)||
     report?.anonymousCategoryEstimatesOnly!==true||
     report?.individualGuestsLinked!==false||
     report?.causalExplanationProven!==false||
     report?.confidenceInCustomerMotives!==false||
     report?.actionsAutomaticallyExecuted!==false||
     report?.signed!==false||report?.legalGo!==false||
     report?.customerGo!==false||report?.productionAuthorized!==false||
     report?.nextExperiment?.automaticExperimentStart!==false)
    blockers.push('UNSAFE_CLAIMS');
  return {schema:'osmanx.guest.r25.brief-verification.v1',
    valid:blockers.length===0,blockers,customerGo:false,
    productionAuthorized:false};
}
export function r25BriefCsv(report){
  if(!verifyR25Brief(report).valid)throw new Error('R25 brief was changed');
  const m=report.profile,rows=[
    ['OSMANX Guest Intelligence R25','Анонимные операционные сигналы'],
    ['Версия пилота',report.version],
    ['SHA исходного R24',report.r24EvidenceSha],
    ['SHA анонимных сводок',report.tallySourceSha],
    ['Периодов R25',m.recordedShifts],
    ['Смены и дни',m.recordedDays],
    ['Просмотренных взаимодействий (анонимно)',m.totalSampled],
    ['Повторные визиты: контроль %',report.r24RetainedReturns.controlRatePct??'нет'],
    ['Повторные визиты: предложение %',report.r24RetainedReturns.offerRatePct??'нет'],
    ['Разница возвратов, п.п.',report.r24RetainedReturns.differencePp??'нет']
  ];
  for(const code of ['wait','stockout','ordering','price','service','unknown']){
    rows.push(['Наблюдаемый код '+code,m.categoryShares[code].observed]);
    rows.push(['Доля '+code+' %',m.categoryShares[code].sharePct??'нет']);
    rows.push(['Позднее против раннего, п.п. '+code,
      m.periodComparison.changes[code].changePp??'не сравнимо']);
  }
  for(const hypothesis of report.board.hypotheses.slice(0,5))
    rows.push(['Гипотеза '+hypothesis.code,
      hypothesis.title+'; требуется: '+hypothesis.verification]);
  rows.push(['Подготовка следующего теста',
    report.nextExperiment.eligibleForHumanDesignReview?'Черновик для ручной проверки':'Заблокировано']);
  rows.push(['SHA-256 отчёта',report.sha256]);
  rows.push(['Ограничение',report.warning]);
  return csv(rows);
}
