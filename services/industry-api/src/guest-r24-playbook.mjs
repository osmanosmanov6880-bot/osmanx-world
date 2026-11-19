/**
 * R24 testable recommendations — transparent, prioritized, no AI guesses.
 * These are suggestions for operators, NOT automatically created tasks
 * and NOT proofs of why any individual guest did/did not return.
 */
import {R24_QUALITY_SCHEMA} from './guest-r24-quality.mjs';
import {R24_STAT_SCHEMA} from './guest-r24-statistics.mjs';
import {R24_ECON_SCHEMA} from './guest-r24-economics.mjs';
export const R24_PLAYBOOK_SCHEMA='osmanx.guest.r24.playbook.v1';
const LIBRARY=Object.freeze({
  RESTORE_PROTOCOL:{
    priority:1,title:'Проверить календарь и регистрацию протокола',
    why:'Дата наблюдения или предрегистрация требует отдельной проверки.',
    next:'Сверить даты и версию протокола с независимым ответственным до нового сбора.',
    evidence:'Зарегистрированный протокол, календарь наблюдений и история исправлений'},
  VERIFY_SOURCE:{
    priority:2,title:'Подтвердить первичные агрегаты',
    why:'Ручной источник или непроверенная точность подсчёта не позволяют объяснить отклонение.',
    next:'Сверить обезличенные суммы с разрешённым первичным учётом и журналом исправлений.',
    evidence:'Подписанная сверка агрегатов без персональных записей'},
  AUDIT_ASSIGNMENT:{
    priority:3,title:'Проверить распределение между группами',
    why:'Неслучайное распределение и перекос размеров могут исказить сравнение.',
    next:'Зафиксировать порядок отбора, непересечение и сопоставимость групп.',
    evidence:'Описание механизма распределения и независимый контроль'},
  COMPLETE_SAMPLE:{
    priority:4,title:'Собрать достаточный объём данных',
    why:'Наблюдений недостаточно для утверждённого размера выборки.',
    next:'Согласовать план добора, не заменяя пропущенные наблюдения нулями.',
    evidence:'План объёмов, подписанные агрегированные наблюдения'},
  WAIT_RETURN_WINDOW:{
    priority:5,title:'Дождаться завершения окна возврата',
    why:'Повторные визиты ещё могут состояться до окончания окна протокола.',
    next:'Вернуться к оценке после последнего дня заранее определённого окна.',
    evidence:'Дата завершения окна и закрытые периоды'},
  REVIEW_UNCERTAINTY:{
    priority:6,title:'Проверить статистическую неопределённость',
    why:'Интервал разницы может включать ноль или выборка содержит редкие исходы.',
    next:'Провести независимую интерпретацию без причинных утверждений.',
    evidence:'Численность, интервалы и заранее выбранная основная метрика'},
  REVIEW_UNIT_ECONOMICS:{
    priority:7,title:'Уточнить экономику единицы',
    why:'Сценарий требует подтверждения маржи, затрат или содержит возможный убыток.',
    next:'Согласовать четыре ценовых допущения с владельцем и проверить безубыточность.',
    evidence:'Сверенная маржа, затраты и договорная стоимость'},
  INVESTIGATE_RETURN_JOURNEY:{
    priority:8,title:'Изучить путь повторного визита',
    why:'Доля повторных визитов в группе предложения наблюдалась ниже контроля.',
    next:'Проверить гипотезы о процессе возврата и предложить новый независимый тест.',
    evidence:'Карта гипотез и утверждённый следующий протокол'},
  REVIEW_NEXT_PILOT:{
    priority:9,title:'Согласовать следующую проверяемую гипотезу',
    why:'Есть данные для разбора, но нет подтверждённого причинного эффекта.',
    next:'Назначить независимый разбор, принять или отклонить новый пилот.',
    evidence:'Протокол следующего теста и документированное решение'}
});
export function buildR24Playbook({quality,statistics,economics,
  stopActive=false}={}){
  if(quality?.schema!==R24_QUALITY_SCHEMA||
    statistics?.schema!==R24_STAT_SCHEMA||
    economics?.schema!==R24_ECON_SCHEMA)
    throw new TypeError('R24 playbook requires validated evidence');
  const codes=new Set();
  const issues=new Set(quality.issues.map(x=>x.code));
  if(quality.blocking||
     issues.has('PROTOCOL_NOT_PREREGISTERED'))
    codes.add('RESTORE_PROTOCOL');
  if(issues.has('MANUAL_AGGREGATE_SOURCE'))
    codes.add('VERIFY_SOURCE');
  if(!quality.randomizedDeclared||
     issues.has('UNBALANCED_TOTAL_GROUPS')||
     issues.has('UNBALANCED_PERIOD_GROUPS'))
    codes.add('AUDIT_ASSIGNMENT');
  if(!quality.sampleEnough)codes.add('COMPLETE_SAMPLE');
  if(!quality.outcomeWindowCompleted)codes.add('WAIT_RETURN_WINDOW');
  if(statistics.intervalIncludesZero===true||
    statistics.uncertaintyFlags?.includes('SMALL_SAMPLE_OR_RARE_EVENTS'))
    codes.add('REVIEW_UNCERTAINTY');
  if(economics.state!=='SCENARIO_ONLY'||
    economics.risks?.includes('NEGATIVE_DOWNSIDE')||
    economics.risks?.includes('ZERO_MARGIN'))
    codes.add('REVIEW_UNIT_ECONOMICS');
  if((statistics.differencePp??0)<0)
    codes.add('INVESTIGATE_RETURN_JOURNEY');
  if(quality.periodCount>0)codes.add('REVIEW_NEXT_PILOT');
  const items=[...codes].map(code=>({code,...LIBRARY[code],
    role:'owner_or_manager',status:'suggested_unapproved',
    actionCreated:false}))
    .sort((a,b)=>a.priority-b.priority||a.code.localeCompare(b.code));
  return {
    schema:R24_PLAYBOOK_SCHEMA,actions:items.slice(0,9),
    totalRecommendations:items.length,
    leadAction:stopActive?'REVIEW_SAFETY_STOP':
      items[0]?.code||'NO_ACTION',
    safetyStopActive:stopActive===true,
    furtherCollectionRecommended:stopActive!==true&&
      quality.periodCount===0,
    automaticallyAssigned:false,automaticallyExecuted:false,
    approvedByOwner:false,causalClaimMade:false,
    disclaimer:'Каждый пункт — проверяемая гипотеза или требование качества, а не установленная причина потери клиентов.'
  };
}
