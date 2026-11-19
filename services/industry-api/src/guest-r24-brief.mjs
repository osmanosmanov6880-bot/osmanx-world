/**
 * R24 bounded manager report. The existing signed evidenceDigest comes from
 * the R4/R7 immutable snapshot. This is a derived SHA-256, NOT a signature.
 * No guest identifiers, emails, assignment details or primary source records.
 */
import {createHash} from 'node:crypto';
import {csv} from '../shared/experiment-model.js';
import {R24_QUALITY_SCHEMA} from './guest-r24-quality.mjs';
import {R24_STAT_SCHEMA} from './guest-r24-statistics.mjs';
import {R24_ECON_SCHEMA} from './guest-r24-economics.mjs';
import {R24_PLAYBOOK_SCHEMA} from './guest-r24-playbook.mjs';
export const R24_BRIEF_SCHEMA='osmanx.guest.r24.manager-brief.v1';
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
// UUID check also allows v1-v8, without coupling a report to database format.
const UUID_ANY=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const SHA=/^[a-f0-9]{64}$/;
const hash=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
const codesOnly=(list,max=24)=>Array.isArray(list)&&list.length<=max&&
  list.every(x=>typeof x==='string'&&/^[A-Z][A-Z0-9_]{1,70}$/.test(x));
const validMoney=n=>n===null||(typeof n==='number'&&Number.isFinite(n)&&
  Math.abs(n)<=1e15);
export function createR24Brief({
  pilotId,version,phase,evidenceDigest,quality,statistics,
  economics,playbook,stopActive=false
}={}){
  if(!UUID_ANY.test(pilotId||'')||!Number.isSafeInteger(version)||version<1||
     !['draft','running','in_review','returned','reviewed','archived'].includes(phase)||
     !SHA.test(evidenceDigest||'')||
     quality?.schema!==R24_QUALITY_SCHEMA||
     statistics?.schema!==R24_STAT_SCHEMA||
     economics?.schema!==R24_ECON_SCHEMA||
     playbook?.schema!==R24_PLAYBOOK_SCHEMA||
     !codesOnly(quality.issues.map(x=>x.code))||
     !codesOnly(playbook.actions.map(x=>x.code))||
     !validMoney(economics.observedDifferenceScenarioRub))
    throw new TypeError('R24 bounded evidence required');
  const body={
    schema:R24_BRIEF_SCHEMA,pilotId,version,phase,evidenceDigest,
    stopped:stopActive===true,
    observedPeriods:quality.periodCount,
    sample:{control:quality.totals.control,
      controlReturned:quality.totals.controlReturn,
      offer:quality.totals.offer,offerReturned:quality.totals.offerReturn,
      enough:quality.sampleEnough},
    quality:{analysisStatus:quality.analysisStatus,
      issues:quality.issues.map(x=>x.code),
      protocolProspective:quality.protocolProspective,
      declaredRandomization:quality.randomizedDeclared,
      outcomeWindowCompleted:quality.outcomeWindowCompleted},
    statistics:{
      state:statistics.state,controlRatePct:statistics.controlRatePct,
      offerRatePct:statistics.offerRatePct,
      differencePp:statistics.differencePp,
      interval95Pp:statistics.interval95Pp,
      intervalIncludesZero:statistics.intervalIncludesZero,
      riskCodes:statistics.uncertaintyFlags||[]
    },
    scenario:{
      state:economics.state,
      assumedCostsRub:economics.costAssumptionsRub||null,
      breakEvenDifferencePp:economics.breakEvenDifferencePp,
      estimatedRangeRub:economics.financialRangeRub,
      observedDifferenceScenarioRub:economics.observedDifferenceScenarioRub,
      risks:economics.risks||[]
    },
    decisions:playbook.actions.map(x=>({
      code:x.code,priority:x.priority,title:x.title,
      next:x.next,evidence:x.evidence,status:x.status
    })),
    customerGo:false,legalGo:false,causalEffectProven:false,
    productionAuthorized:false,
    disclaimer:'Только агрегированные наблюдения. Различия, статистические интервалы и экономическая модель НЕ доказывают влияние на клиентов или фактическую прибыль.'
  };
  return {...body,sha256:hash(body),
    signed:false,guestIdentifiersIncluded:false};
}
export function verifyR24Brief(packet,{pilotId,evidenceDigest}={}){
  const errors=[];
  if(!packet||typeof packet!=='object'||Array.isArray(packet)){
    return {valid:false,errors:['invalid_packet'],customerGo:false};
  }
  const {sha256,signed,guestIdentifiersIncluded,...body}=packet;
  if(body.schema!==R24_BRIEF_SCHEMA||!UUID_ANY.test(body.pilotId||'')||
     !SHA.test(body.evidenceDigest||'')||!SHA.test(sha256||''))
    errors.push('invalid_schema');
  if(hash(body)!==sha256)errors.push('tampered_data');
  if(pilotId!==undefined&&body.pilotId!==pilotId)errors.push('wrong_pilot');
  if(evidenceDigest!==undefined&&body.evidenceDigest!==evidenceDigest)
    errors.push('wrong_evidence');
  if(body.customerGo!==false||body.legalGo!==false||
     body.causalEffectProven!==false||body.productionAuthorized!==false||
     signed!==false||guestIdentifiersIncluded!==false)
    errors.push('unsafe_claims');
  const allowed=[
    'schema','pilotId','version','phase','evidenceDigest','stopped',
    'observedPeriods','sample','quality','statistics','scenario',
    'decisions','customerGo','legalGo','causalEffectProven',
    'productionAuthorized','disclaimer','sha256','signed',
    'guestIdentifiersIncluded'
  ];
  if(Object.keys(packet).sort().join('|')!==allowed.sort().join('|'))
    errors.push('unexpected_fields');
  return {valid:errors.length===0,errors,
    customerGo:false,productionAuthorized:false};
}
export function r24BriefCsv(brief){
  const verification=verifyR24Brief(brief);
  if(!verification.valid)throw new Error('Cannot export altered R24 evidence');
  const rows=[
    ['OSMANX GUEST INTELLIGENCE R24','Сводка агрегатов'],
    ['Версия пилота',brief.version],
    ['Хэш исходных наблюдений',brief.evidenceDigest],
    ['Наблюдаемых периодов',brief.observedPeriods],
    ['Контроль: всего',brief.sample.control],
    ['Контроль: повторные',brief.sample.controlReturned],
    ['Предложение: всего',brief.sample.offer],
    ['Предложение: повторные',brief.sample.offerReturned],
    ['Повторные визиты, контроль %',brief.statistics.controlRatePct??'нет'],
    ['Повторные визиты, предложение %',brief.statistics.offerRatePct??'нет'],
    ['Разница, п.п.',brief.statistics.differencePp??'нет'],
    ['95% интервал разницы, п.п.',(brief.statistics.interval95Pp||[]).join(' .. ')||'нет'],
    ['Модель разницы: результат ₽',brief.scenario.observedDifferenceScenarioRub??'нет'],
    ['Безубыточная разница, п.п.',brief.scenario.breakEvenDifferencePp??'нет'],
    ['Действия для независимой проверки',brief.decisions.map(x=>x.code).join(', ')],
    ['SHA-256 отчёта',brief.sha256],
    ['Ограничение',brief.disclaimer]
  ];
  return csv(rows);
}
